/**
 * GET /api/lessons?status=published|read|saved|all&lang=en|ru&repoId=<id>
 *
 * Lists lessons in the requested repo for the current user. Lessons live in
 * `lessons_v2` (partitioned by /repoId). Per-reader state (read, saved) lives
 * in `lessonProgress` (partitioned by /userId) and is joined in here so the
 * response shape stays compatible with the v1 client.
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import {
  lessonsV2Container,
  lessonProgressContainer,
  LessonV2,
  LessonProgress,
} from '../shared/cosmos.js';
import { resolveRequest, isHttpResponse } from '../shared/auth.js';

type StatusFilter = 'published' | 'read' | 'saved' | 'queued' | 'all';

interface LessonResponse extends Omit<LessonV2, 'status'> {
  /** Hydrated from lessonProgress so the v1 client still works. */
  status: LessonV2['status'] | 'read';
  read_at?: string | null;
  saved?: boolean;
}

function hydrate(
  lesson: LessonV2,
  progress: LessonProgress | undefined,
): LessonResponse {
  return {
    ...lesson,
    status: progress?.status === 'read' ? 'read' : lesson.status,
    read_at: progress?.readAt ?? null,
    saved: progress?.saved ?? false,
  };
}

export async function listLessons(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const r = resolveRequest(req);
  if (isHttpResponse(r)) return r;
  const { userId, repoId } = r;

  const status = (req.query.get('status') ?? 'published') as StatusFilter;
  const lang = req.query.get('lang') === 'ru' ? 'ru' : 'en';

  // 1) Pull progress for this (userId, repoId) — small set, < 100 docs.
  const progressContainer = lessonProgressContainer();
  const { resources: progressRows } = await progressContainer.items
    .query<LessonProgress>(
      {
        query: 'SELECT * FROM c WHERE c.userId = @uid AND c.repoId = @rid',
        parameters: [
          { name: '@uid', value: userId },
          { name: '@rid', value: repoId },
        ],
      },
      { partitionKey: userId },
    )
    .fetchAll();
  const progressByLesson = new Map<string, LessonProgress>(
    progressRows.map((p) => [p.lessonId, p]),
  );

  // 2) Fetch lessons. Filter on lesson.status server-side where possible;
  //    progress-derived filters (read, saved) we apply in-memory after hydrate.
  const lessons = lessonsV2Container();

  let query: string;
  if (status === 'published' || status === 'queued') {
    query =
      'SELECT * FROM c WHERE c.repoId = @rid AND c.status = @s AND c.language = @lang ORDER BY c.created_at DESC';
  } else {
    // read | saved | all → fetch all non-archived in this lang and filter
    query =
      'SELECT * FROM c WHERE c.repoId = @rid AND c.language = @lang AND c.status != "archived" ORDER BY c.created_at DESC';
  }

  const { resources: rawLessons } = await lessons.items
    .query<LessonV2>(
      {
        query,
        parameters: [
          { name: '@rid', value: repoId },
          { name: '@s', value: status === 'queued' ? 'queued' : 'published' },
          { name: '@lang', value: lang },
        ],
      },
      { partitionKey: repoId },
    )
    .fetchAll();

  const hydrated = rawLessons.map((l) => hydrate(l, progressByLesson.get(l.id)));

  // For 'published' we need to hide lessons the user has already read,
  // matching the v1 'next up' behaviour.
  let result: LessonResponse[];
  if (status === 'published') {
    result = hydrated.filter((l) => l.status !== 'read');
  } else if (status === 'queued') {
    result = hydrated;
  } else if (status === 'read') {
    result = hydrated.filter((l) => l.status === 'read');
  } else if (status === 'saved') {
    result = hydrated.filter((l) => l.saved);
  } else {
    // 'all'
    result = hydrated;
  }

  ctx.log(
    `listLessons: ${result.length} lessons (status=${status}, lang=${lang}, repo=${repoId}, user=${userId})`,
  );
  return { status: 200, jsonBody: { lessons: result } };
}

app.http('listLessons', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'lessons',
  handler: listLessons,
});
