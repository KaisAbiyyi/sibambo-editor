import type { RequestHandler } from './$types';
import { csrf, projectId, requestJson, respond, service, ticketResponse } from '$lib/server/mcp-bff';
export const POST: RequestHandler = async (event) => {
  const owner = csrf(event), body = await requestJson(event);
  const project = projectId(body.projectId);
  // SE-03 generates short-lived single-use WebSocket tickets; BFF never fabricates, stores or logs one.
  return respond(ticketResponse(await service(event, owner, project, '/ticket', 'POST', {}), owner, project));
};
