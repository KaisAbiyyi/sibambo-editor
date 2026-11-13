import { describe, expect, it } from 'bun:test';
import { loadedModelTabTitle } from '../../src/lib/model-tab-title';

describe('loadedModelTabTitle', () => {
	it('prefers the trimmed embedded model name and preserves internal spaces and Unicode', () => {
		expect(loadedModelTabTitle({ modelName: '  Rumah SBOOST 1 – façade  ', sourceFileName: 'PROJECT SBOOST 1.skp' }, 'Editor')).toBe('Rumah SBOOST 1 – façade');
	});

	it('does not parse a nonempty model name as a path or remove its extension', () => {
		expect(loadedModelTabTitle({ modelName: ' C:\\models\\PROJECT SBOOST 1.skp ' }, 'Editor')).toBe('C:\\models\\PROJECT SBOOST 1.skp');
	});

	it('uses the embedded source basename before the selected-file fallback', () => {
		expect(loadedModelTabTitle({ sourceFileName: 'D:\\exports\\PROJECT SBOOST 1.SKP', selectedFileName: 'other.bomc' }, 'Editor')).toBe('PROJECT SBOOST 1');
		expect(loadedModelTabTitle({ sourceFileName: '/models/PROJECT SBOOST 2.BoMc' }, 'Editor')).toBe('PROJECT SBOOST 2');
	});

	it('removes only supported final file extensions case-insensitively', () => {
		for (const extension of ['skp', 'bomc', 'json', 'cleanpkg', 'zip']) {
			expect(loadedModelTabTitle({ sourceFileName: `Model.${extension.toUpperCase()}` }, 'Editor')).toBe('Model');
		}
	});

	it('strips an official export suffix only from the selected-file fallback', () => {
		expect(loadedModelTabTitle({ selectedFileName: 'PROJECT SBOOST 1__SIBAMBO-BOMC-v1.2.0__EXACT.bomc' }, 'Editor')).toBe('PROJECT SBOOST 1');
		expect(loadedModelTabTitle({ selectedFileName: 'Rumah__sibambo-bomc-v2.0__research.ZIP' }, 'Editor')).toBe('Rumah');
		expect(loadedModelTabTitle({ selectedFileName: 'Rumah__SIBAMBO-BOMC-v1.2.0__VISUAL.cleanpkg' }, 'Editor')).toBe('Rumah');
		expect(loadedModelTabTitle({ sourceFileName: 'PROJECT SBOOST 1__SIBAMBO-BOMC-v1.2.0__EXACT.bomc' }, 'Editor')).toBe('PROJECT SBOOST 1__SIBAMBO-BOMC-v1.2.0__EXACT');
	});

	it('preserves unknown suffixes and internal underscores', () => {
		expect(loadedModelTabTitle({ selectedFileName: 'model__custom_export_v1.bomc' }, 'Editor')).toBe('model__custom_export_v1');
	});

	it('returns the route default for empty or extension-only names', () => {
		expect(loadedModelTabTitle({ modelName: ' ', sourceFileName: '  ', selectedFileName: '   ' }, 'Sibambo Editor')).toBe('Sibambo Editor');
		expect(loadedModelTabTitle({ selectedFileName: '.bomc' }, 'Sibambo Editor')).toBe('Sibambo Editor');
	});
});
