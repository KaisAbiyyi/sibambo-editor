import { hash, moduleId, parseJson, sha, uint, validateProjection, type DraftModule, type DraftProposal, type DraftState, type Manifest } from './draft-protocol';

/** Stage off-thread; never mutate the last committed state before projection/render succeeds. */
export async function stageDraft(raw: string, previous: DraftState | null, projectId: string): Promise<DraftProposal> {
  const event = parseJson(raw);
  if (!event || !['snapshot', 'event'].includes(event.type) || event.schemaVersion !== 1 || event.projectId !== projectId ||
      typeof event.epoch !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(event.epoch) || !uint(event.revision) || !sha(event.draftSha256)) throw Error('DRAFT_SCOPE');
  if (previous && event.epoch !== previous.epoch) throw Error('EPOCH_CHANGED');
  if (previous && event.revision <= previous.revision) {
    if (event.revision === previous.revision && event.draftSha256 === previous.draftSha256) return { state: previous, changed: [], removed: [], duplicate: true };
    throw Error('DRAFT_STALE_HASH');
  }
  if (event.type === 'event' && (!previous || event.previousRevision !== previous.revision || event.revision !== previous.revision + 1)) throw Error('DRAFT_GAP');
  const incoming = event.type === 'snapshot' ? event.modules : event.changed;
  if (!Array.isArray(incoming) || (event.type === 'event' && incoming.length > 8)) throw Error('DRAFT_BUDGET');
  const modules = new Map<string, DraftModule>(event.type === 'snapshot' ? [] : previous!.modules.map(m => [m.moduleId, m]));
  const changed = new Set<string>();
  for (const m of incoming) {
    if (!m || !moduleId(m.moduleId) || changed.has(m.moduleId) || !uint(m.moduleRevision) || m.moduleRevision < 1 || !sha(m.contentSha256) || !sha(m.projectionSha256) ||
        typeof m.canonicalIrJson !== 'string' || typeof m.projectionJson !== 'string' || new TextEncoder().encode(m.canonicalIrJson).length > 65536) throw Error('DRAFT_MODULE');
    // Hash exact UTF-8 before parsing (Python and JS float spelling is intentionally not reserialized).
    if (await hash(m.canonicalIrJson) !== m.contentSha256 || await hash(m.projectionJson) !== m.projectionSha256) throw Error('DRAFT_HASH');
    const ir = parseJson(m.canonicalIrJson, 65536), projection = parseJson(m.projectionJson);
    if (!ir || ir.moduleId !== m.moduleId || ir.revision !== m.moduleRevision || !Array.isArray(ir.operations)) throw Error('DRAFT_IR');
    validateProjection(projection, m.moduleId, m.moduleRevision);
    if (event.type === 'event') {
      const old = previous!.manifest.find(row => row[0] === m.moduleId);
      if (old && (old[2] === null || m.moduleRevision !== old[1] + 1) || !old && m.moduleRevision !== 1) throw Error('DRAFT_MODULE_REVISION');
    }
    modules.set(m.moduleId, { ...m, projection }); changed.add(m.moduleId);
  }
  const removed: string[] = event.type === 'snapshot' ? previous?.modules.filter(m => !modules.has(m.moduleId)).map(m => m.moduleId) ?? [] : event.removed;
  if (!Array.isArray(removed) || removed.length > 8 && event.type !== 'snapshot' || new Set(removed).size !== removed.length ||
      removed.some(id => !moduleId(id) || changed.has(id) || event.type === 'event' && !modules.has(id)) || event.type === 'event' && changed.size + removed.length > 8) throw Error('DRAFT_REMOVAL');
  for (const id of removed) modules.delete(id);
  const manifest: Manifest = event.manifest;
  if (!Array.isArray(manifest) || manifest.length > 2048) throw Error('DRAFT_MANIFEST');
  let last = ''; const rows = new Map<string, [string, number, string | null]>();
  for (const row of manifest) {
    if (!Array.isArray(row) || row.length !== 3 || !moduleId(row[0]) || row[0] <= last || !uint(row[1]) || row[1] < 1 || row[2] !== null && !sha(row[2])) throw Error('DRAFT_MANIFEST');
    last = row[0]; rows.set(row[0], row);
    const m = modules.get(row[0]);
    if (row[2] === null ? !!m : !m || m.moduleRevision !== row[1] || m.contentSha256 !== row[2]) throw Error('DRAFT_MANIFEST');
  }
  if ([...modules.keys()].some(id => !rows.has(id)) || await hash(JSON.stringify(manifest)) !== event.draftSha256 ||
      [...modules.values()].reduce((n, m) => n + new TextEncoder().encode(m.canonicalIrJson).length, 0) > 2 * 1024 * 1024) throw Error('DRAFT_MANIFEST');
  if (previous && event.type === 'event') {
    for (const old of previous.manifest) {
      const row = rows.get(old[0]);
      if (!row || removed.includes(old[0]) && (row[1] !== old[1] + 1 || row[2] !== null) ||
          !changed.has(old[0]) && !removed.includes(old[0]) && JSON.stringify(row) !== JSON.stringify(old)) throw Error('DRAFT_MANIFEST_REVISION');
    }
  }
  return { state: { projectId, epoch: event.epoch, revision: event.revision, draftSha256: event.draftSha256, manifest, modules: [...modules.values()] },
    changed: [...changed], removed, duplicate: false };
}
