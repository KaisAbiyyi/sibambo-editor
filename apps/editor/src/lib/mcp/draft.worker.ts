import { parseJson, type DraftState, type DraftProposal } from './draft-protocol';
import { stageDraft } from './draft-store';
let committed: DraftState | null = null, pending: DraftProposal | null = null;
self.onmessage = async ({ data }) => {
  const { id, kind, raw, projectId } = data;
  try {
    if (kind === 'commit') { if (!pending) throw Error('DRAFT_COMMIT'); committed = pending.state; pending = null; self.postMessage({ id, ok: true }); return; }
    const message = parseJson(raw);
    if (message?.type === 'snapshot' || message?.type === 'event') {
      pending = await stageDraft(raw, committed, projectId);
      self.postMessage({ id, proposal: pending, eventType: message.type });
    } else {
      if (!message || !['viewer_role', 'presence', 'resync_required', 'owner_request_status'].includes(message.type)) throw Error('DRAFT_MESSAGE');
      if (message.projectId !== undefined && message.projectId !== projectId || committed && message.epoch !== undefined && message.epoch !== committed.epoch) throw Error('DRAFT_SCOPE');
      self.postMessage({ id, control: message });
    }
  } catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : 'DRAFT_INVALID' }); }
};
