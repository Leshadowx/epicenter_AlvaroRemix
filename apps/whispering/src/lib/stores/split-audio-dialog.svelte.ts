export type SplitAudioDialogOptions = {
	maxMb: number;
	bitrateKbps: number;
	minChunkSec: number;
	safetyMb: number;
	addSplitTags: boolean;
};

type SplitAudioDialogRequest = {
	blob: Blob;
	blobSizeMb: number;
	options: SplitAudioDialogOptions;
};

type SplitAudioDialogResult = SplitAudioDialogOptions | null;

function createSplitAudioDialog() {
	let isOpen = $state(false);
	let blob = $state<Blob | null>(null);
	let blobSizeMb = $state<number | null>(null);
	let options = $state<SplitAudioDialogOptions>({
		maxMb: 25,
		bitrateKbps: 128,
		minChunkSec: 10,
		safetyMb: 0.5,
		addSplitTags: true,
	});
	let resolvePromise: ((value: SplitAudioDialogResult) => void) | null = null;

	return {
		get isOpen() {
			return isOpen;
		},
		set isOpen(value) {
			isOpen = value;
		},
		get blob() {
			return blob;
		},
		get blobSizeMb() {
			return blobSizeMb;
		},
		get options() {
			return options;
		},
		updateOptions(next: Partial<SplitAudioDialogOptions>) {
			options = { ...options, ...next };
		},
		open(request: SplitAudioDialogRequest) {
			if (resolvePromise) {
				resolvePromise(null);
			}
			blob = request.blob;
			blobSizeMb = request.blobSizeMb;
			options = request.options;
			isOpen = true;
			return new Promise<SplitAudioDialogResult>((resolve) => {
				resolvePromise = resolve;
			});
		},
		confirm() {
			if (!resolvePromise) return;
			const currentOptions = options;
			isOpen = false;
			resolvePromise(currentOptions);
			resolvePromise = null;
		},
		cancel() {
			if (!resolvePromise) return;
			isOpen = false;
			resolvePromise(null);
			resolvePromise = null;
		},
	};
}

export const splitAudioDialog = createSplitAudioDialog();
