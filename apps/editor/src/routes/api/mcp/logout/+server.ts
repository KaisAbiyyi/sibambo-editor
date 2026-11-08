import type { RequestHandler } from './$types';
import { clearFlow, clearSession, csrf, respond } from '$lib/server/mcp-bff';
export const POST: RequestHandler = async (event) => {
  csrf(event);
  clearFlow(event);
  clearSession(event);
  return respond({ phase: 'disconnected' });
};
