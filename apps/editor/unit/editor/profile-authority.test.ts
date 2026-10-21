import { expect, test } from 'bun:test';
import { authoringProfileReason } from '../../src/lib/profile-authority';

test('only parsed Exact is eligible for the separate lossless editable subset validation', () => {
	expect(authoringProfileReason('exact')).toBeNull();
	expect(authoringProfileReason('visual')).toContain('Visual preview only');
	expect(authoringProfileReason('research')).toContain('Legacy Research read-only');
	expect(authoringProfileReason(undefined)).toContain('unavailable');
	expect(authoringProfileReason('future')).toContain('unavailable');
});
