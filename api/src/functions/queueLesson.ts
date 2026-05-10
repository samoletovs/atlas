/**
 * POST /api/lessons/queue?repoId=<id>
 * Body: { title, topic, language, rationale?, source_lesson_id?, depth? }
 *
 * Creates a queued lesson stub in `lessons_v2`. The body is generated later
 * by `scripts/generate_lessons.py --pending`. Idempotent — if a queued or
 * published lesson already exists for the same (repoId, topic, language),
 * returns the existing record.
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { lessonsV2Container, LessonV2 } from '../shared/cosmos.js';
import { resolveRequest, isHttpResponse } from '../shared/auth.js';

interface QueueBody {
  title?: string;
  topic?: string;
  language?: 'en' | 'ru';
  rationale?: string;
  source_lesson_id?: string;
  depth?: 'intro' | 'intermediate' | 'deep';
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

export async function queueLesson(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const r = resolveRequest(req);
  if (isHttpResponse(r)) return r;
  const { repoId, ownerLogin } = r;

  let body: QueueBody;
  try {
    body = (await req.json()) as QueueBody;
  } catch {
    return { status: 400, jsonBody: { error: 'Invalid JSON body' } };
  }

  const title = (body.title ?? '').trim();
  const topic = (body.topic ?? '').trim();
  const language = body.language === 'ru' ? 'ru' : 'en';
  const depth = body.depth ?? 'intro';

  if (!title || !topic) {
    return { status: 400, jsonBody: { error: 'title and topic are required' } };
  }
  if (title.length > 200 || topic.length > 200) {
    return { status: 400, jsonBody: { error: 'title/topic too long' } };
  }

  const container = lessonsV2Container();

  // Idempotency: same repo + topic + language already queued/published.
  const { resources: existing } = await container.items
    .query<LessonV2>(
      {
        query:
          'SELECT * FROM c WHERE c.repoId = @rid AND c.topic = @topic AND c.language = @lang AND c.status IN ("queued", "published")',
        parameters: [
          { name: '@rid', value: repoId },
          { name: '@topic', value: topic },
          { name: '@lang', value: language },
        ],
      },
      { partitionKey: repoId },
    )
    .fetchAll();

  if (existing.length > 0) {
    ctx.log(`queueLesson: exists ${existing[0].id} (status=${existing[0].status})`);
    return { status: 200, jsonBody: existing[0] };
  }

  const slug = slugify(title) || slugify(topic) || 'untitled';
  const lesson: LessonV2 = {
    id: `lesson-${language}-${slug}-${Date.now().toString(36)}`,
    repoId,
    ownerId: ownerLogin,
    title,
    topic,
    depth,
    read_minutes: 4,
    body: '',
    citations: [],
    suggested_next: [],
    source_event: body.source_lesson_id
      ? {
          type: 'suggestion',
          ref: body.source_lesson_id,
          summary: body.rationale ?? `Queued from "${title}"`,
        }
      : null,
    status: 'queued',
    language,
    created_at: new Date().toISOString(),
  };

  const { resource } = await container.items.create(lesson);
  ctx.log(`queueLesson: created ${lesson.id} [${language}] ${topic} (repo=${repoId})`);
  return { status: 201, jsonBody: resource };
}

app.http('queueLesson', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'lessons/queue',
  handler: queueLesson,
});
