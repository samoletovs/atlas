/**
 * POST /api/lessons/queue
 * Body: { title, topic, language, rationale?, source_lesson_id? }
 *
 * Creates a queued lesson stub in Cosmos. The actual body is generated
 * later by `scripts/generate_lessons.py --pending`. Idempotent — if a
 * queued/published lesson already exists for the same (topic, language),
 * returns the existing record.
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { lessonsContainer, ATLAS_USER_ID, Lesson } from '../shared/cosmos.js';
import { getPrincipal, isAuthorized } from '../shared/auth.js';

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
  ctx: InvocationContext
): Promise<HttpResponseInit> {
  const principal = getPrincipal(req);
  if (!isAuthorized(principal)) {
    return { status: 401, jsonBody: { error: 'Unauthorized' } };
  }

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

  const container = lessonsContainer();

  // Idempotency: if a lesson with same topic+language already exists
  // (queued OR published), return it instead of creating a duplicate.
  const { resources: existing } = await container.items
    .query<Lesson>(
      {
        query:
          'SELECT * FROM c WHERE c.userId = @uid AND c.topic = @topic AND c.language = @lang AND c.status IN ("queued", "published", "read")',
        parameters: [
          { name: '@uid', value: ATLAS_USER_ID },
          { name: '@topic', value: topic },
          { name: '@lang', value: language },
        ],
      },
      { partitionKey: ATLAS_USER_ID },
    )
    .fetchAll();

  if (existing.length > 0) {
    ctx.log(`queueLesson: exists ${existing[0].id} (status=${existing[0].status})`);
    return { status: 200, jsonBody: existing[0] };
  }

  const slug = slugify(title) || slugify(topic) || 'untitled';
  const lesson: Lesson = {
    id: `lesson-${language}-${slug}-${Date.now().toString(36)}`,
    userId: ATLAS_USER_ID,
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
  ctx.log(`queueLesson: created ${lesson.id} [${language}] ${topic}`);
  return { status: 201, jsonBody: resource };
}

app.http('queueLesson', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'lessons/queue',
  handler: queueLesson,
});
