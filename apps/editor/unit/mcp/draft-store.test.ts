import { expect, test } from 'bun:test';
import { hash, parseJson, type DraftState } from '../../src/lib/mcp/draft-protocol';
import { stageDraft } from '../../src/lib/mcp/draft-store';
const epoch = '12345678-1234-4234-8234-123456789012';
async function record(revision = 1) {
  const canonicalIrJson = JSON.stringify({ schemaVersion: '1.0.0', moduleId: 'house/room', revision, operations: [] });
  const projectionJson = JSON.stringify({ moduleId: 'house/room', revision, worldTransform: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1], positions: [], materials: [], faces: [] });
  return { moduleId: 'house/room', moduleRevision: revision, canonicalIrJson, projectionJson,
    contentSha256: await hash(canonicalIrJson), projectionSha256: await hash(projectionJson) };
}
async function snapshot() {
  const module = await record(), manifest = [[module.moduleId, 1, module.contentSha256]];
  return { type: 'snapshot', schemaVersion: 1, projectId: 'p', epoch, revision: 1, modules: [module], manifest, draftSha256: await hash(JSON.stringify(manifest)) };
}
test('exact UTF-8 modules and manifest stage without mutating prior state', async () => {
  const raw = await snapshot(); const first = await stageDraft(JSON.stringify(raw), null, 'p');
  const next = await record(2), manifest = [[next.moduleId, 2, next.contentSha256]];
  const proposed = await stageDraft(JSON.stringify({ type: 'event', schemaVersion: 1, projectId: 'p', epoch, revision: 2, previousRevision: 1,
    operationId: 'operation', changed: [next], removed: [], manifest, draftSha256: await hash(JSON.stringify(manifest)) }), first.state, 'p');
  expect(first.state.revision).toBe(1); expect(proposed.state.revision).toBe(2);
  expect(proposed.state.modules[0]!.canonicalIrJson).toBe(next.canonicalIrJson);
});
test('corrupt/gap/wrong-project/wrong-epoch messages preserve last committed state', async () => {
  const raw = await snapshot(), previous = (await stageDraft(JSON.stringify(raw), null, 'p')).state;
  for (const patch of [{ projectId: 'other' }, { epoch: '87654321-1234-4234-8234-123456789012' },
    { revision: 2, modules: [{ ...raw.modules[0], canonicalIrJson: '{}' }] },
    { type: 'event', revision: 3, previousRevision: 2, changed: [], removed: [] }]) {
    await expect(stageDraft(JSON.stringify({ ...raw, ...patch }), previous, 'p')).rejects.toThrow();
    expect(previous.revision).toBe(1);
  }
});
test('identical duplicate is acknowledged without another projection', async () => {
  const raw = await snapshot(), previous = (await stageDraft(JSON.stringify(raw), null, 'p')).state;
  expect((await stageDraft(JSON.stringify(raw), previous, 'p')).duplicate).toBe(true);
});
test('parser rejects duplicate keys, malformed numbers, invalid trailing data and excessive depth', () => {
  for (const raw of ['{"a":1,"a":2}', '{"x":1e999}', '[01]', '{}{}', '['.repeat(65) + '0' + ']'.repeat(65)]) expect(() => parseJson(raw)).toThrow();
});
test('a remove produces a tombstone and cannot resurrect its module in the same epoch', async () => {
  const raw = await snapshot(), previous = (await stageDraft(JSON.stringify(raw), null, 'p')).state;
  const manifest = [['house/room', 2, null]], digest = await hash(JSON.stringify(manifest));
  const removed = (await stageDraft(JSON.stringify({ type: 'event', schemaVersion: 1, projectId: 'p', epoch, revision: 2, previousRevision: 1,
    operationId: 'remove', changed: [], removed: ['house/room'], manifest, draftSha256: digest }), previous, 'p')).state;
  expect(removed.modules).toEqual([]); expect(removed.manifest[0]![2]).toBeNull();
  await expect(stageDraft(JSON.stringify({ ...raw, type: 'event', revision: 3, previousRevision: 2, changed: [await record(3)], removed: [] }), removed, 'p')).rejects.toThrow();
});
