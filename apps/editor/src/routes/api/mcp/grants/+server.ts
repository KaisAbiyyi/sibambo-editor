import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { csrf, expose, projectId, requestJson, respond, service } from '$lib/server/mcp-bff';
export const POST: RequestHandler = async (event) => {
  const owner = csrf(event), body = await requestJson(event);
  const project = projectId(body.projectId);
  if (!['approve', 'deny', 'revoke', 'remove'].includes(String(body.action)) ||
      typeof body.grantId !== 'string' || body.grantId.length > 128 ||
      typeof body.agentSubject !== 'string' || body.agentSubject.length > 255 ||
      typeof body.clientId !== 'string' || body.clientId.length > 255 ||
      !Array.isArray(body.scopes) || body.scopes.some(s => s !== 'read' && s !== 'write') ||
      !body.scopes.length || body.scopes.length > 2) throw error(400, 'Exact agent, client and scopes required');
  return respond(expose(await service(event, owner, project, '/grants', 'POST', body)));
};
