/**
 * POST /api/lessons/{id}/state?repoId=<id>
 * Body: { action: 'mark_read' | 'save' | 'unsave' | 'feedback_up' | 'feedback_down'
 *                 | 'feedback_clear' | 'set_rating' | 'set_comment',
 *         rating?: 1..5 | null,   // required for 'set_rating' (null clears it)
 *         comment?: string | null // required for 'set_comment' (empty/null clears it)
 *       }
 *
 * All actions write to `lessonProgress` (per-reader). The lesson doc
 * itself in `lessons_v2` is not modified — its `status` is the catalog state
 * (queued / drafting / published / archived), not the per-reader read state.
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import {
  lessonsV2Container,
  lessonProgressContainer,
  LessonV2,
  LessonProgress,
  FEEDBACK_COMMENT_MAX,
} from '../shared/cosmos.js';
import { resolveRequest, isHttpResponse } from '../shared/auth.js';

interface StateBody {
  action:
    | 'mark_read'
    | 'save'
    | 'unsave'
    | 'feedback_up'
    | 'feedback_down'
    | 'feedback_clear'
    | 'set_rating'
    | 'set_comment';
  rating?: number | null;
  comment?: string | null;
}

export async function updateLessonState(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const r = await resolveRequest(req);
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
    feedback: null,
    rating: null,
    feedbackComment: null,
    feedbackAt: null,
  };

  if (body.action === 'mark_read') {
    next.status = 'read';
    next.readAt = new Date().toISOString();
  } else if (body.action === 'save') {
    next.saved = true;
  } else if (body.action === 'unsave') {
    next.saved = false;
  } else if (body.action === 'feedback_up') {
    next.feedback = 'up';
  } else if (body.action === 'feedback_down') {
    next.feedback = 'down';
  } else if (body.action === 'feedback_clear') {
    next.feedback = null;
  } else if (body.action === 'set_rating') {
    const rating = body.rating;
    if (rating === null || rating === undefined) {
      next.rating = null;
    } else if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return { status: 400, jsonBody: { error: 'rating must be an integer 1-5, or null' } };
    } else {
      next.rating = rating;
    }
    next.feedbackAt = new Date().toISOString();
  } else if (body.action === 'set_comment') {
    const raw = body.comment;
    if (raw !== null && raw !== undefined && typeof raw !== 'string') {
      return { status: 400, jsonBody: { error: 'comment must be a string or null' } };
    }
    const comment = (raw ?? '').trim();
    if (comment.length > FEEDBACK_COMMENT_MAX) {
      return {
        status: 400,
        jsonBody: { error: `comment must be at most ${FEEDBACK_COMMENT_MAX} characters` },
      };
    }
    next.feedbackComment = comment.length > 0 ? comment : null;
    next.feedbackAt = new Date().toISOString();
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
      feedback: next.feedback ?? null,
      rating: next.rating ?? null,
      feedback_comment: next.feedbackComment ?? null,
      feedback_at: next.feedbackAt ?? null,
    },
  };
}

app.http('updateLessonState', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'lessons/{id}/state',
  handler: updateLessonState,
});
