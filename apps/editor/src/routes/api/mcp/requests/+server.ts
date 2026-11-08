import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { csrf, expose, projectId, requestJson, respond, requireSession, service } from '$lib/server/mcp-bff';
export const GET: RequestHandler = async (event) => {
  const owner = requireSession(event), project = projectId(event.url.searchParams.get('project'));
  return respond(expose(await service(event, owner, project, '/requests', 'GET')));
};
export const POST: RequestHandler = async (event) => {
  const owner = csrf(event), body = await requestJson(event);
  const project = projectId(body.projectId);
  if (!['create', 'withdraw', 'mark-read', 'mark-addressed'].includes(String(body.action))) throw error(400, 'Invalid request action');
  if (body.action === 'create') {
    if (typeof body.body !== 'string' || !body.body.trim() || body.body.length > 2000 ||
      !Array.isArray(body.moduleIds) || body.moduleIds.length > 8 ||
      body.moduleIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id))) throw error(400, 'Invalid revision request');
  } else if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(body.requestId)) throw error(400, 'Invalid revision ID');
  return respond(expose(await service(event, owner, project, '/requests', 'POST', body)));
};
