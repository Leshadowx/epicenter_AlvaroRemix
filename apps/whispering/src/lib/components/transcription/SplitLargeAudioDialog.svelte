<script lang="ts">
	import * as Dialog from '@epicenter/ui/dialog';
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { splitAudioDialog } from '$lib/stores/split-audio-dialog.svelte';
	import { settings } from '$lib/stores/settings.svelte';

	const options = $derived(splitAudioDialog.options);

	const optionKeyMap = {
		'transcription.splitMaxMB': 'maxMb',
		'transcription.splitBitrateKbps': 'bitrateKbps',
		'transcription.splitMinChunkSec': 'minChunkSec',
		'transcription.splitSafetyMB': 'safetyMb',
	} as const;

	function updateNumberSetting<T extends number>(
		key:
			| 'transcription.splitMaxMB'
			| 'transcription.splitBitrateKbps'
			| 'transcription.splitMinChunkSec'
			| 'transcription.splitSafetyMB',
		value: string,
		fallback: T,
	) {
		const parsed = Number(value);
		const nextValue = Number.isFinite(parsed) ? parsed : fallback;
		settings.updateKey(key, nextValue);
		splitAudioDialog.updateOptions({
			[optionKeyMap[key]]: nextValue,
		} as Partial<typeof options>);
	}
</script>

<Dialog.Root
	bind:open={splitAudioDialog.isOpen}
	onOpenChange={(value) => {
		if (!value) splitAudioDialog.cancel();
	}}
>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Large audio detected</Dialog.Title>
			<Dialog.Description>
				Your audio is{' '}
				{splitAudioDialog.blobSizeMb
					? splitAudioDialog.blobSizeMb.toFixed(1)
					: 'over'}{' '}
				MB. Whisper requires files under 25MB, so we can split and degrade
				quality for transcription.
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-4">
			<Field.Field>
				<Field.Label for="split-max-mb">Max MB per chunk</Field.Label>
				<Input
					id="split-max-mb"
					type="number"
					min="1"
					step="0.1"
					value={options.maxMb}
					oninput={(event) =>
						updateNumberSetting(
							'transcription.splitMaxMB',
							event.currentTarget.value,
							options.maxMb,
						)}
				/>
			</Field.Field>

			<Field.Field>
				<Field.Label for="split-bitrate">Bitrate (kbps)</Field.Label>
				<Input
					id="split-bitrate"
					type="number"
					min="16"
					step="8"
					value={options.bitrateKbps}
					oninput={(event) =>
						updateNumberSetting(
							'transcription.splitBitrateKbps',
							event.currentTarget.value,
							options.bitrateKbps,
						)}
				/>
			</Field.Field>

			<Field.Field>
				<Field.Label for="split-min-seconds">Minimum chunk length</Field.Label>
				<Input
					id="split-min-seconds"
					type="number"
					min="5"
					step="1"
					value={options.minChunkSec}
					oninput={(event) =>
						updateNumberSetting(
							'transcription.splitMinChunkSec',
							event.currentTarget.value,
							options.minChunkSec,
						)}
				/>
			</Field.Field>

			<Field.Field>
				<Field.Label for="split-safety-mb">Safety buffer (MB)</Field.Label>
				<Input
					id="split-safety-mb"
					type="number"
					min="0"
					step="0.1"
					value={options.safetyMb}
					oninput={(event) =>
						updateNumberSetting(
							'transcription.splitSafetyMB',
							event.currentTarget.value,
							options.safetyMb,
						)}
				/>
			</Field.Field>

			<Field.Field orientation="horizontal">
				<Checkbox
					id="split-tagging"
					checked={options.addSplitTags}
					onCheckedChange={(checked) => {
						const nextValue = checked === true;
						settings.updateKey(
							'transcription.splitTaggingEnabled',
							nextValue,
						);
						splitAudioDialog.updateOptions({ addSplitTags: nextValue });
					}}
				/>
				<Field.Content>
					<Field.Label for="split-tagging">
						Add timestamps between chunks
					</Field.Label>
					<Field.Description>
						Insert [start–end] tags so you can edit out artifacts later.
					</Field.Description>
				</Field.Content>
			</Field.Field>
		</div>

		<Dialog.Footer class="mt-6">
			<Button variant="outline" onclick={() => splitAudioDialog.cancel()}>
				Cancel
			</Button>
			<Button onclick={() => splitAudioDialog.confirm()}>
				Split &amp; transcribe
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
