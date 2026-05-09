/**
 * POST /api/lessons/{id}/state  body: { action: 'mark_read' | 'save' | 'unsave' }
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { lessonsContainer, ATLAS_USER_ID, Lesson } from '../shared/cosmos.js';
import { getPrincipal, isAuthorized } from '../shared/auth.js';

interface StateBody { action: 'mark_read' | 'save' | 'unsave' }

export async function updateLessonState(
  req: HttpRequest,
  ctx: InvocationContext
): Promise<HttpResponseInit> {
  const principal = getPrincipal(req);
  if (!isAuthorized(principal)) {
    return { status: 401, jsonBody: { error: 'Unauthorized' } };
  }
  const id = req.params.id;
  if (!id) return { status: 400, jsonBody: { error: 'Missing id' } };

  let body: StateBody;
  try {
    body = (await req.json()) as StateBody;
  } catch {
    return { status: 400, jsonBody: { error: 'Invalid JSON body' } };
  }

  const item = lessonsContainer().item(id, ATLAS_USER_ID);
  const { resource } = await item.read<Lesson>();
  if (!resource) return { status: 404, jsonBody: { error: 'Not found' } };

  if (body.action === 'mark_read') {
    resource.status = 'read';
    resource.read_at = new Date().toISOString();
  } else if (body.action === 'save') {
    resource.saved = true;
  } else if (body.action === 'unsave') {
    resource.saved = false;
  } else {
    return { status: 400, jsonBody: { error: `Unknown action ${body.action}` } };
  }

  await item.replace(resource);
  ctx.log(`updateLessonState: ${id} -> ${body.action}`);
  return { status: 200, jsonBody: resource };
}

app.http('updateLessonState', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'lessons/{id}/state',
  handler: updateLessonState,
});
