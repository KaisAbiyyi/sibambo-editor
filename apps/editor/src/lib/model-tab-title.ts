export type LoadedModelTitleInput = {
	modelName?: string | null;
	sourceFileName?: string | null;
	selectedFileName?: string | null;
};

const modelFileExtension = /\.(?:skp|bomc|json|cleanpkg|zip)$/i;
const officialExportSuffix = /__SIBAMBO-BOMC-v\d+(?:\.\d+)+__(?:EXACT|RESEARCH|VISUAL)$/i;

export function loadedModelTabTitle(input: LoadedModelTitleInput, emptyTitle: string) {
	const modelName = input.modelName?.trim();
	if (modelName) return modelName;

	const sourceFileName = input.sourceFileName?.trim();
	if (sourceFileName) {
		const basename = sourceFileName.split(/[\\/]/).at(-1) ?? '';
		return basename.replace(modelFileExtension, '').trim() || emptyTitle;
	}

	const selectedFileName = input.selectedFileName?.trim();
	if (selectedFileName) {
		const basename = selectedFileName.split(/[\\/]/).at(-1) ?? '';
		const withoutExtension = basename.replace(modelFileExtension, '').trim();
		return withoutExtension.replace(officialExportSuffix, '').trim() || emptyTitle;
	}

	return emptyTitle;
}
