/**
 * GET /api/lessons/{id}
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { lessonsContainer, ATLAS_USER_ID, Lesson } from '../shared/cosmos.js';
import { getPrincipal, isAuthorized } from '../shared/auth.js';

export async function getLesson(
  req: HttpRequest,
  ctx: InvocationContext
): Promise<HttpResponseInit> {
  const principal = getPrincipal(req);
  if (!isAuthorized(principal)) {
    return { status: 401, jsonBody: { error: 'Unauthorized' } };
  }

  const id = req.params.id;
  if (!id) return { status: 400, jsonBody: { error: 'Missing id' } };

  try {
    const { resource } = await lessonsContainer().item(id, ATLAS_USER_ID).read<Lesson>();
    if (!resource) return { status: 404, jsonBody: { error: 'Not found' } };
    return { status: 200, jsonBody: resource };
  } catch (err: unknown) {
    if (err instanceof Error && (err as { code?: number }).code === 404) {
      return { status: 404, jsonBody: { error: 'Not found' } };
    }
    ctx.error('getLesson failed', err);
    return { status: 500, jsonBody: { error: String(err) } };
  }
}

app.http('getLesson', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'lessons/{id}',
  handler: getLesson,
});
