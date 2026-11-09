import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { csrf, expose, projectId, requestJson, respond, service } from '$lib/server/mcp-bff';
export const POST: RequestHandler = async (event) => {
  const owner = csrf(event), body = await requestJson(event);
  const project = projectId(body.projectId);
  if (typeof body.paused !== 'boolean') throw error(400, 'Explicit pause state required');
  return respond(expose(await service(event, owner, project, '/pause', 'POST', { paused: body.paused })));
};
