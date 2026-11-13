import type { RequestHandler } from './$types';
import { clearFlow, clearSession, csrf, respond, disconnectOwner } from '$lib/server/mcp-bff';
export const POST: RequestHandler = async (event) => {
  const owner = csrf(event);
  try { await disconnectOwner(owner); }
  finally { clearFlow(event); clearSession(event); }
  return respond({ phase: 'disconnected' });
};
