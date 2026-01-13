import { Err, Ok, partitionResults, type Result } from 'wellcrafted/result';
import { defineMutation, queryClient } from '$lib/query/client';
import { WhisperingErr, type WhisperingError } from '$lib/result';
import { desktopServices, services } from '$lib/services';
import type { Recording } from '$lib/services/isomorphic/db';
import { splitAudioDialog } from '$lib/stores/split-audio-dialog.svelte';
import { settings } from '$lib/stores/settings.svelte';
import type { Settings } from '$lib/settings';
import { rpc } from '..';
import { db } from './db';
import { notify } from './notify';

const MAX_TRANSCRIPTION_FILE_MB = 25;
const MB_BYTES = 1024 * 1024;

const transcriptionKeys = {
	isTranscribing: ['transcription', 'isTranscribing'] as const,
} as const;

export const transcription = {
	isCurrentlyTranscribing() {
		return (
			queryClient.isMutating({
				mutationKey: transcriptionKeys.isTranscribing,
			}) > 0
		);
	},
	transcribeRecording: defineMutation({
		mutationKey: transcriptionKeys.isTranscribing,
		mutationFn: async (
			recording: Recording,
		): Promise<Result<string, WhisperingError>> => {
			// Fetch audio blob by ID
			const { data: audioBlob, error: getAudioBlobError } =
				await services.db.recordings.getAudioBlob(recording.id);

			if (getAudioBlobError) {
				return WhisperingErr({
					title: '⚠️ Failed to fetch audio',
					description: `Unable to load audio for recording: ${getAudioBlobError.message}`,
				});
			}

			const { error: setRecordingTranscribingError } =
				await db.recordings.update({
					...recording,
					transcriptionStatus: 'TRANSCRIBING',
				});
			if (setRecordingTranscribingError) {
				notify.warning({
					title:
						'⚠️ Unable to set recording transcription status to transcribing',
					description: 'Continuing with the transcription process...',
					action: {
						type: 'more-details',
						error: setRecordingTranscribingError,
					},
				});
			}
			const { data: transcribedText, error: transcribeError } =
				await transcribeBlob(audioBlob);
			if (transcribeError) {
				const { error: setRecordingTranscribingError } =
					await db.recordings.update({
						...recording,
						transcriptionStatus: 'FAILED',
					});
				if (setRecordingTranscribingError) {
					notify.warning({
						title: '⚠️ Unable to update recording after transcription',
						description:
							"Transcription failed but unable to update recording's transcription status in database",
						action: {
							type: 'more-details',
							error: setRecordingTranscribingError,
						},
					});
				}
				return Err(transcribeError);
			}

			const { error: setRecordingTranscribedTextError } =
				await db.recordings.update({
					...recording,
					transcribedText,
					transcriptionStatus: 'DONE',
				});
			if (setRecordingTranscribedTextError) {
				notify.warning({
					title: '⚠️ Unable to update recording after transcription',
					description:
						"Transcription completed but unable to update recording's transcribed text and status in database",
					action: {
						type: 'more-details',
						error: setRecordingTranscribedTextError,
					},
				});
			}
			return Ok(transcribedText);
		},
	}),

	transcribeRecordings: defineMutation({
		mutationKey: transcriptionKeys.isTranscribing,
		mutationFn: async (recordings: Recording[]) => {
			const results = await Promise.all(
				recordings.map(async (recording) => {
					// Fetch audio blob by ID
					const { data: audioBlob, error: getAudioBlobError } =
						await services.db.recordings.getAudioBlob(recording.id);

					if (getAudioBlobError) {
						return WhisperingErr({
							title: '⚠️ Failed to fetch audio',
							description: `Unable to load audio for recording: ${getAudioBlobError.message}`,
						});
					}

					return await transcribeBlob(audioBlob);
				}),
			);
			const partitionedResults = partitionResults(results);
			return Ok(partitionedResults);
		},
	}),
};

async function transcribeBlob(
	blob: Blob,
): Promise<Result<string, WhisperingError>> {
	const selectedService =
		settings.value['transcription.selectedTranscriptionService'];

	// Log transcription request
	const startTime = Date.now();
	rpc.analytics.logEvent({
		type: 'transcription_requested',
		provider: selectedService,
	});

	// Compress audio if enabled, else pass through original blob
	let audioToTranscribe = blob;
	if (settings.value['transcription.compressionEnabled']) {
		const { data: compressedBlob, error: compressionError } =
			await desktopServices.ffmpeg.compressAudioBlob(
				blob,
				settings.value['transcription.compressionOptions'],
			);

		if (compressionError) {
			// Notify user of compression failure but continue with original blob
			notify.warning({
				title: 'Audio compression failed',
				description: `${compressionError.message}. Using original audio for transcription.`,
			});
			rpc.analytics.logEvent({
				type: 'compression_failed',
				provider: selectedService,
				error_message: compressionError.message,
			});
		} else {
			// Use compressed blob and notify user of success
			audioToTranscribe = compressedBlob;
			const compressionRatio = Math.round(
				(1 - compressedBlob.size / blob.size) * 100,
			);
			notify.info({
				title: 'Audio compressed',
				description: `Reduced file size by ${compressionRatio}%`,
			});
			rpc.analytics.logEvent({
				type: 'compression_completed',
				provider: selectedService,
				original_size: blob.size,
				compressed_size: compressedBlob.size,
				compression_ratio: compressionRatio,
			});
		}
	}

	const requiresSplit = blob.size > MAX_TRANSCRIPTION_FILE_MB * MB_BYTES;
	let transcriptionResult: Result<string, WhisperingError>;

	if (requiresSplit) {
		const splitOptions = await splitAudioDialog.open({
			blob,
			blobSizeMb: blob.size / MB_BYTES,
			options: {
				maxMb: settings.value['transcription.splitMaxMB'],
				bitrateKbps: settings.value['transcription.splitBitrateKbps'],
				minChunkSec: settings.value['transcription.splitMinChunkSec'],
				safetyMb: settings.value['transcription.splitSafetyMB'],
				addSplitTags: settings.value['transcription.splitTaggingEnabled'],
			},
		});

		if (!splitOptions) {
			transcriptionResult = WhisperingErr({
				title: 'Split canceled',
				description:
					'Transcription was canceled because the audio file exceeds 25MB.',
			});
		} else {
			transcriptionResult = await transcribeSplitAudio(
				blob,
				splitOptions,
				selectedService,
			);
		}
	} else {
		transcriptionResult = await transcribeWithProvider(
			audioToTranscribe,
			selectedService,
		);
	}

	// Log transcription result
	const duration = Date.now() - startTime;
	if (transcriptionResult.error) {
		rpc.analytics.logEvent({
			type: 'transcription_failed',
			provider: selectedService,
			error_title: transcriptionResult.error.title,
			error_description: transcriptionResult.error.description,
		});
	} else {
		rpc.analytics.logEvent({
			type: 'transcription_completed',
			provider: selectedService,
			duration,
		});
	}

	return transcriptionResult;
}

async function transcribeSplitAudio(
	blob: Blob,
	options: {
		maxMb: number;
		bitrateKbps: number;
		minChunkSec: number;
		safetyMb: number;
		addSplitTags: boolean;
	},
	selectedService: Settings['transcription.selectedTranscriptionService'],
): Promise<Result<string, WhisperingError>> {
	const { data: splitBlobs, error: splitError } =
		await desktopServices.ffmpeg.splitAudioBlob(blob, {
			maxMb: options.maxMb,
			bitrateKbps: options.bitrateKbps,
			minChunkSec: options.minChunkSec,
			safetyMb: options.safetyMb,
		});

	if (splitError) {
		return WhisperingErr({
			title: 'Audio split failed',
			serviceError: splitError,
		});
	}

	const chunkSeconds = calculateChunkSeconds(options);
	const merged: string[] = [];

	for (let index = 0; index < splitBlobs.length; index += 1) {
		const chunk = splitBlobs[index];
		if (!chunk) continue;

		const { data: text, error: chunkError } = await transcribeWithProvider(
			chunk,
			selectedService,
		);

		if (chunkError) return Err(chunkError);

		if (options.addSplitTags) {
			const start = index * chunkSeconds;
			const end = (index + 1) * chunkSeconds;
			merged.push(formatSplitTag(index + 1, start, end));
		}

		merged.push(text.trim());
	}

	return Ok(merged.join('\n\n'));
}

async function transcribeWithProvider(
	audioToTranscribe: Blob,
	selectedService: Settings['transcription.selectedTranscriptionService'],
): Promise<Result<string, WhisperingError>> {
	switch (selectedService) {
		case 'OpenAI':
			return await services.transcriptions.openai.transcribe(audioToTranscribe, {
				outputLanguage: settings.value['transcription.outputLanguage'],
				prompt: settings.value['transcription.prompt'],
				temperature: settings.value['transcription.temperature'],
				apiKey: settings.value['apiKeys.openai'],
				modelName: settings.value['transcription.openai.model'],
				baseURL: settings.value['apiEndpoints.openai'] || undefined,
			});
		case 'Groq':
			return await services.transcriptions.groq.transcribe(audioToTranscribe, {
				outputLanguage: settings.value['transcription.outputLanguage'],
				prompt: settings.value['transcription.prompt'],
				temperature: settings.value['transcription.temperature'],
				apiKey: settings.value['apiKeys.groq'],
				modelName: settings.value['transcription.groq.model'],
				baseURL: settings.value['apiEndpoints.groq'] || undefined,
			});
		case 'speaches':
			return await services.transcriptions.speaches.transcribe(
				audioToTranscribe,
				{
					outputLanguage: settings.value['transcription.outputLanguage'],
					prompt: settings.value['transcription.prompt'],
					temperature: settings.value['transcription.temperature'],
					modelId: settings.value['transcription.speaches.modelId'],
					baseUrl: settings.value['transcription.speaches.baseUrl'],
				},
			);
		case 'ElevenLabs':
			return await services.transcriptions.elevenlabs.transcribe(
				audioToTranscribe,
				{
					outputLanguage: settings.value['transcription.outputLanguage'],
					prompt: settings.value['transcription.prompt'],
					temperature: settings.value['transcription.temperature'],
					apiKey: settings.value['apiKeys.elevenlabs'],
					modelName: settings.value['transcription.elevenlabs.model'],
				},
			);
		case 'Deepgram':
			return await services.transcriptions.deepgram.transcribe(
				audioToTranscribe,
				{
					outputLanguage: settings.value['transcription.outputLanguage'],
					prompt: settings.value['transcription.prompt'],
					temperature: settings.value['transcription.temperature'],
					apiKey: settings.value['apiKeys.deepgram'],
					modelName: settings.value['transcription.deepgram.model'],
				},
			);
		case 'Mistral':
			return await services.transcriptions.mistral.transcribe(
				audioToTranscribe,
				{
					outputLanguage: settings.value['transcription.outputLanguage'],
					prompt: settings.value['transcription.prompt'],
					temperature: settings.value['transcription.temperature'],
					apiKey: settings.value['apiKeys.mistral'],
					modelName: settings.value['transcription.mistral.model'],
				},
			);
		case 'whispercpp': {
			return await services.transcriptions.whispercpp.transcribe(
				audioToTranscribe,
				{
					outputLanguage: settings.value['transcription.outputLanguage'],
					modelPath: settings.value['transcription.whispercpp.modelPath'],
					prompt: settings.value['transcription.prompt'],
				},
			);
		}
		case 'parakeet': {
			return await services.transcriptions.parakeet.transcribe(
				audioToTranscribe,
				{ modelPath: settings.value['transcription.parakeet.modelPath'] },
			);
		}
		case 'moonshine': {
			return await services.transcriptions.moonshine.transcribe(
				audioToTranscribe,
				{
					modelPath: settings.value['transcription.moonshine.modelPath'],
				},
			);
		}
		default:
			return WhisperingErr({
				title: '⚠️ No transcription service selected',
				description: 'Please select a transcription service in settings.',
			});
	}
}

function calculateChunkSeconds(options: {
	maxMb: number;
	bitrateKbps: number;
	minChunkSec: number;
	safetyMb: number;
}) {
	const targetBytes = (options.maxMb - options.safetyMb) * MB_BYTES;
	const bytesPerSecond = (options.bitrateKbps * 1000) / 8;
	return Math.max(options.minChunkSec, Math.floor(targetBytes / bytesPerSecond));
}

function formatSplitTag(index: number, startSeconds: number, endSeconds: number) {
	return `[Chunk ${index} • ${formatTimestamp(startSeconds)} – ${formatTimestamp(
		endSeconds,
	)}]`;
}

function formatTimestamp(totalSeconds: number) {
	const clampedSeconds = Math.max(0, Math.floor(totalSeconds));
	const hours = Math.floor(clampedSeconds / 3600);
	const minutes = Math.floor((clampedSeconds % 3600) / 60);
	const seconds = clampedSeconds % 60;
	const hourPrefix = hours > 0 ? `${String(hours).padStart(2, '0')}:` : '';
	return `${hourPrefix}${String(minutes).padStart(2, '0')}:${String(
		seconds,
	).padStart(2, '0')}`;
}
