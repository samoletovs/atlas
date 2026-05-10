/**
 * GET /api/lessons/{id}?repoId=<id>
 *
 * Reads a lesson from `lessons_v2` and joins the caller's progress
 * (`lessonProgress`) so the response shape stays compatible with v1.
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import {
  lessonsV2Container,
  lessonProgressContainer,
  LessonV2,
  LessonProgress,
} from '../shared/cosmos.js';
import { resolveRequest, isHttpResponse } from '../shared/auth.js';

export async function getLesson(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const r = resolveRequest(req);
  if (isHttpResponse(r)) return r;
  const { userId, repoId } = r;

  const id = req.params.id;
  if (!id) return { status: 400, jsonBody: { error: 'Missing id' } };

  try {
    const { resource: lesson } = await lessonsV2Container()
      .item(id, repoId)
      .read<LessonV2>();
    if (!lesson) return { status: 404, jsonBody: { error: 'Not found' } };

    let progress: LessonProgress | undefined;
    try {
      const { resource } = await lessonProgressContainer()
        .item(`${userId}_${id}`, userId)
        .read<LessonProgress>();
      progress = resource ?? undefined;
    } catch (e: unknown) {
      // Missing progress doc is normal; only swallow 404.
      if (e instanceof Error && (e as { code?: number }).code !== 404) throw e;
    }

    return {
      status: 200,
      jsonBody: {
        ...lesson,
        status: progress?.status === 'read' ? 'read' : lesson.status,
        read_at: progress?.readAt ?? null,
        saved: progress?.saved ?? false,
      },
    };
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
