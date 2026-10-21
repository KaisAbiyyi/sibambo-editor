/** Profile eligibility is necessary, but never replaces the lossless BWEB subset validation. */
export function authoringProfileReason(profile: string | undefined): string | null {
	if (profile === 'exact') return null;
	if (profile === 'visual') return 'Visual preview only · Canonical editing and BOMC Save require lossless Exact data.';
	if (profile === 'research') return 'Legacy Research read-only · Historical import cannot become an Exact authoring document.';
	return 'Encoding profile unavailable · Canonical editing and BOMC Save are disabled.';
}
