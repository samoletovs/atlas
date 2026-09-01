/**
 * GET /api/lessons/recommended?repoId=<id>&lang=en|ru
 *
 * Adaptive learning path: returns unread published lessons ordered by how
 * well they match the user's current reading profile. The algorithm:
 *
 *   1. Build a topic profile from the user's lessonProgress (which topics
 *      they've read and at what depth).
 *   2. Score each unread published lesson:
 *      - Brand-new topic → prefer intro (score 5), intermediate (2), deep (1)
 *      - Topic where intro is read → prefer intermediate (5), deep (3), intro (1)
 *      - Topic where intermediate is read → prefer deep (5), intermediate (1)
 *      - Topic fully mastered (deep read) → low priority (1)
 *      - Bonus +2 if the user has saved a lesson on the same topic
 *   3. Return all lessons sorted by score descending, with a `recommendation_reason`
 *      field added so the UI can explain each recommendation.
 *
 * Response: { lessons: LessonRecommendation[] }
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import {
  lessonsV2Container,
  lessonProgressContainer,
  LessonV2,
  LessonProgress,
} from '../shared/cosmos.js';
import { resolveRequest, isHttpResponse } from '../shared/auth.js';
import { buildTopicProfile, scoreLesson } from '../shared/adaptiveScoring.js';

export interface LessonRecommendation extends Omit<LessonV2, 'status'> {
  /** Why this lesson is recommended at this position. */
  recommendation_reason: string;
  /** Numeric score (higher = more relevant). Not persisted. */
  recommendation_score: number;
  /** Per-reader read state, hydrated from lessonProgress. */
  status: LessonV2['status'] | 'read';
  read_at: string | null;
  saved: boolean;
}

export async function getRecommendations(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const r = await resolveRequest(req);
  if (isHttpResponse(r)) return r;
  const { userId, repoId } = r;

  const lang = req.query.get('lang') === 'ru' ? 'ru' : 'en';

  // 1) Fetch all user progress for this repo (small set, < 100 docs typically).
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

  // 2) Fetch all published lessons for this repo+lang.
  const lessons = lessonsV2Container();
  const { resources: allLessons } = await lessons.items
    .query<LessonV2>(
      {
        query:
          'SELECT * FROM c WHERE c.repoId = @rid AND c.language = @lang AND c.status = "published" ORDER BY c.created_at DESC',
        parameters: [
          { name: '@rid', value: repoId },
          { name: '@lang', value: lang },
        ],
      },
      { partitionKey: repoId },
    )
    .fetchAll();

  // 3) Separate read from unread.
  const readLessons: LessonV2[] = [];
  const unreadLessons: LessonV2[] = [];
  for (const l of allLessons) {
    const prog = progressByLesson.get(l.id);
    if (prog?.status === 'read') {
      readLessons.push(l);
    } else {
      unreadLessons.push(l);
    }
  }

  // 4) Build topic profile from read lessons.
  const topicProfile = buildTopicProfile(readLessons, progressByLesson, (l) => l.id);

  // 5) Score each unread lesson and sort descending.
  const scored: LessonRecommendation[] = unreadLessons.map((l) => {
    const { score, reason } = scoreLesson(l, topicProfile);
    const prog = progressByLesson.get(l.id);
    return {
      ...l,
      recommendation_score: score,
      recommendation_reason: reason,
      status: prog?.status === 'read' ? 'read' : l.status,
      read_at: prog?.readAt ?? null,
      saved: prog?.saved ?? false,
    };
  });

  scored.sort((a, b) => {
    const diff = b.recommendation_score - a.recommendation_score;
    // Tie-break: most recently created first.
    if (diff !== 0) return diff;
    return a.created_at < b.created_at ? 1 : -1;
  });

  ctx.log(
    `getRecommendations: ${scored.length} lessons (lang=${lang}, repo=${repoId}, user=${userId})`,
  );

  return { status: 200, jsonBody: { lessons: scored } };
}

app.http('getRecommendations', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'lessons/recommended',
  handler: getRecommendations,
});
