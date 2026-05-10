/**
 * POST /api/lessons/{id}/state?repoId=<id>
 * Body: { action: 'mark_read' | 'save' | 'unsave' }
 *
 * All three actions write to `lessonProgress` (per-reader). The lesson doc
 * itself in `lessons_v2` is not modified — its `status` is the catalog state
 * (queued / drafting / published / archived), not the per-reader read state.
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import {
  lessonsV2Container,
  lessonProgressContainer,
  LessonV2,
  LessonProgress,
} from '../shared/cosmos.js';
import { resolveRequest, isHttpResponse } from '../shared/auth.js';

interface StateBody {
  action: 'mark_read' | 'save' | 'unsave';
}

export async function updateLessonState(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const r = resolveRequest(req);
  if (isHttpResponse(r)) return r;
  const { userId, repoId } = r;

  const id = req.params.id;
  if (!id) return { status: 400, jsonBody: { error: 'Missing id' } };

  let body: StateBody;
  try {
    body = (await req.json()) as StateBody;
  } catch {
    return { status: 400, jsonBody: { error: 'Invalid JSON body' } };
  }

  // Confirm the lesson exists and belongs to the requested repo. Cheap and
  // prevents a user creating progress rows for a repo they shouldn't see.
  const { resource: lesson } = await lessonsV2Container()
    .item(id, repoId)
    .read<LessonV2>();
  if (!lesson) {
    return { status: 404, jsonBody: { error: 'Not found' } };
  }

  // Read existing progress (if any) so we can update fields atomically.
  const progress = lessonProgressContainer();
  const progressId = `${userId}_${id}`;
  let existing: LessonProgress | undefined;
  try {
    const { resource } = await progress.item(progressId, userId).read<LessonProgress>();
    existing = resource ?? undefined;
  } catch (e: unknown) {
    if (e instanceof Error && (e as { code?: number }).code !== 404) throw e;
  }

  const next: LessonProgress = existing ?? {
    id: progressId,
    userId,
    repoId,
    lessonId: id,
    status: 'unread',
    readAt: null,
    saved: false,
  };

  if (body.action === 'mark_read') {
    next.status = 'read';
    next.readAt = new Date().toISOString();
  } else if (body.action === 'save') {
    next.saved = true;
  } else if (body.action === 'unsave') {
    next.saved = false;
  } else {
    return { status: 400, jsonBody: { error: `Unknown action ${body.action}` } };
  }

  await progress.items.upsert(next);
  ctx.log(`updateLessonState: ${id} -> ${body.action} (user=${userId}, repo=${repoId})`);

  // Return the hydrated lesson so the client can update state in-place.
  return {
    status: 200,
    jsonBody: {
      ...lesson,
      status: next.status === 'read' ? 'read' : lesson.status,
      read_at: next.readAt ?? null,
      saved: next.saved ?? false,
    },
  };
}

app.http('updateLessonState', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'lessons/{id}/state',
  handler: updateLessonState,
});
