import type { RequestHandler } from './$types';
import { configured, expose, getSession, noStore, respond, service, projectId, csrf, requestJson, draftWebSocketUrl } from '$lib/server/mcp-bff';
export const GET: RequestHandler = async (event) => {
  const session = getSession(event);
  if (!session) return respond({ contract: 'se04-owner-mcp-v1', phase: 'disconnected', configured: configured(), csrf: null, serviceReady: false });
  const project = event.url.searchParams.get('project');
  if (!project) return respond({ contract: 'se04-owner-mcp-v1', phase: 'project-selected', subject: session.sub, csrf: session.csrf, serviceReady: !!process.env.SE04_SERVICE_BASE_URL });
  const data = await service(event, session, projectId(project), '', 'GET');
  return respond({ ...expose(data), subject: session.sub, csrf: session.csrf, serviceReady: true, draftWebSocketUrl: draftWebSocketUrl() });
};
export const POST: RequestHandler = async (event) => {
  const owner = csrf(event), body = await requestJson(event), project = projectId(body.projectId);
  return respond(expose(await service(event, owner, project, '/open', 'POST', {})));
};
