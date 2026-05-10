/**
 * POST /api/lessons/generate
 * Body: { title, topic, language, rationale?, source_lesson_id?, depth? }
 *
 * Generates a lesson body synchronously by calling Azure OpenAI with the
 * same instructions used by the Python `atlas-teacher` agent. Saves the
 * fully-populated lesson to Cosmos and returns it. ~5–15s wait.
 *
 * Auth: SP credentials in SWA App Settings (Free tier has no MI).
 *   AZURE_CLIENT_ID / AZURE_CLIENT_SECRET / AZURE_TENANT_ID
 *   FOUNDRY_AOAI_ENDPOINT (e.g. https://foundrylab-aiservices.cognitiveservices.azure.com)
 *   FOUNDRY_DEPLOYMENT (e.g. gpt-4o-mini)
 *   FOUNDRY_API_VERSION (e.g. 2024-08-01-preview)
 *
 * Idempotent: if a non-archived lesson already exists for (topic, language),
 * returns the existing record without calling the model.
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { lessonsContainer, ATLAS_USER_ID, Lesson } from '../shared/cosmos.js';
import { getPrincipal, isAuthorized } from '../shared/auth.js';
import { getOpenAIClientForUser } from '../shared/openaiClient.js';

interface GenerateBody {
  title?: string;
  topic?: string;
  language?: 'en' | 'ru';
  rationale?: string;
  source_lesson_id?: string;
  depth?: 'intro' | 'intermediate' | 'deep';
}

const LIBRARIAN_INSTRUCTIONS = `You are atlas — a personal teacher for a working consultant pivoting
from D365 functional work toward Azure / agentic solutions. Your job is to write phone-readable
lessons grounded in the user's actual build activity (commits, project docs) and authoritative
external knowledge.

Rules for every lesson you write:

1. Length: 300–900 words. Use the lower end for a single concept, higher for multi-concept.
2. Phone-friendly markdown. Short paragraphs (2–4 sentences). One main idea per paragraph.
3. Open with a 1-sentence hook. Tie it to the rationale provided when applicable.
4. Structure: Hook → Core concept → Trade-offs / when-it-applies → Why it matters in practice.
5. Use plain language. The reader is functional, not deep technical. Define jargon on first use.
6. Cite 1–3 authoritative sources at the end as plain URLs (Microsoft Learn preferred).
7. Avoid code blocks unless 3–6 lines maximum and absolutely necessary. Prefer prose.
8. Do NOT bury the lede. The "why this matters" should be in the first or second paragraph.
9. End every lesson with 2–3 "What to learn next" suggestions in JSON format the system can parse.

Markdown formatting (use these to make scanning the lesson on a phone effortless):

10. **Bold** every defined term on first use, plus 1–2 phrases per lesson that capture
    the central insight. Do not over-bold — fewer than ~6 bolded fragments per lesson.
11. Use exactly ONE callout per major section (max 3 per lesson) with this syntax:
       > [!KEY] One-line title (optional)
       > One or two short sentences with the central takeaway for that section.
    Available kinds: KEY (the big idea), TIP (practical advice), WARN (common pitfall),
    REMEMBER (worth memorizing). Pick the one that fits — don't use all four.
12. Cross-link 3–7 specific concepts to other lessons using the syntax
    [term](topic:slug-here). Use lowercase, hyphenated slugs that match how a topic
    would be named (e.g. [managed identity](topic:managed-identity),
    [retrieval augmented generation](topic:rag)). Only link genuinely useful
    follow-ups, not every noun. The reader can click the link to either jump
    to an existing lesson or generate one on demand.
13. Use bulleted or numbered lists for enumerable trade-offs, steps, or comparisons —
    they read much better than commas-in-a-paragraph on mobile.

You will be told the topic, depth, and rationale. Output a single JSON object with these
fields exactly:

{
  "title": "Short, descriptive title (max 60 chars)",
  "topic": "the topic slug provided",
  "depth": "intro|intermediate|deep",
  "read_minutes": <int 2..7>,
  "body": "the markdown body of the lesson",
  "citations": ["https://learn.microsoft.com/...", "..."],
  "suggested_next": [
    {"title": "...", "topic": "topic-slug", "rationale": "1-sentence why"},
    {"title": "...", "topic": "topic-slug", "rationale": "1-sentence why"}
  ]
}

Output ONLY the JSON. No prose around it. No markdown fences. Plain JSON.`;

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function buildUserPrompt(body: GenerateBody, lang: 'en' | 'ru'): string {
  const langInstruction =
    lang === 'ru'
      ? 'IMPORTANT: Write the ENTIRE lesson in Russian (Русский). Title, body — everything in Russian. Keep technical terms in English where natural (e.g. Azure, Cosmos DB, API).'
      : 'Write the lesson in English.';

  return JSON.stringify(
    {
      topic: body.topic,
      depth: body.depth ?? 'intro',
      title_hint: body.title,
      rationale: body.rationale ?? '',
      language_instruction: langInstruction,
      context_notes: `This lesson was queued from a 'What to learn next' suggestion in another lesson. Write a focused ${
        body.depth ?? 'intro'
      }-level piece on '${body.topic}'.`,
    },
    null,
    2,
  );
}

interface GeneratedLesson {
  title: string;
  topic: string;
  depth: 'intro' | 'intermediate' | 'deep';
  read_minutes: number;
  body: string;
  citations: string[];
  suggested_next: { title: string; topic: string; rationale: string }[];
}

async function callModel(input: GenerateBody, lang: 'en' | 'ru', userId: string): Promise<GeneratedLesson> {
  const { client, deployment } = await getOpenAIClientForUser(userId);
  const completion = await client.chat.completions.create({
    model: deployment,
    temperature: 0.4,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: LIBRARIAN_INSTRUCTIONS },
      { role: 'user', content: buildUserPrompt(input, lang) },
    ],
  });
  const text = completion.choices[0]?.message?.content ?? '';
  if (!text) throw new Error('Model returned empty response');
  // Strip code fences just in case
  const cleaned = text.replace(/^```(?:json)?\s*\n/, '').replace(/\n```\s*$/, '');
  const parsed = JSON.parse(cleaned) as GeneratedLesson;
  if (!parsed.title || !parsed.body) {
    throw new Error('Model response missing required fields');
  }
  return parsed;
}

export async function generateLesson(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const principal = getPrincipal(req);
  if (!isAuthorized(principal)) {
    return { status: 401, jsonBody: { error: 'Unauthorized' } };
  }

  let body: GenerateBody;
  try {
    body = (await req.json()) as GenerateBody;
  } catch {
    return { status: 400, jsonBody: { error: 'Invalid JSON body' } };
  }

  const title = (body.title ?? '').trim();
  const topic = (body.topic ?? '').trim();
  const language: 'en' | 'ru' = body.language === 'ru' ? 'ru' : 'en';

  if (!title || !topic) {
    return { status: 400, jsonBody: { error: 'title and topic are required' } };
  }
  if (title.length > 200 || topic.length > 200) {
    return { status: 400, jsonBody: { error: 'title/topic too long' } };
  }

  const container = lessonsContainer();

  // Idempotency: if a published/read/queued lesson with same (topic, language)
  // already exists, return it instead of re-generating.
  const { resources: existing } = await container.items
    .query<Lesson>(
      {
        query:
          'SELECT * FROM c WHERE c.userId = @uid AND c.topic = @topic AND c.language = @lang AND c.status IN ("published", "read")',
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
    ctx.log(`generateLesson: existing ${existing[0].id} (status=${existing[0].status})`);
    return { status: 200, jsonBody: existing[0] };
  }

  // Generate via the model. This is the slow part (5–15s).
  let generated: GeneratedLesson;
  try {
    generated = await callModel(body, language, ATLAS_USER_ID);
  } catch (err: unknown) {
    ctx.error('generateLesson model call failed', err);
    const message = err instanceof Error ? err.message : String(err);
    return { status: 502, jsonBody: { error: `Model call failed: ${message}` } };
  }

  const slug = slugify(generated.title) || slugify(topic) || 'untitled';
  const lesson: Lesson = {
    id: `lesson-${language}-${slug}-${Date.now().toString(36)}`,
    userId: ATLAS_USER_ID,
    title: generated.title,
    topic: generated.topic || topic,
    depth: generated.depth || body.depth || 'intro',
    read_minutes: Number.isFinite(generated.read_minutes) ? generated.read_minutes : 4,
    body: generated.body,
    citations: Array.isArray(generated.citations) ? generated.citations : [],
    suggested_next: Array.isArray(generated.suggested_next) ? generated.suggested_next : [],
    source_event: body.source_lesson_id
      ? {
          type: 'suggestion',
          ref: body.source_lesson_id,
          summary: body.rationale ?? `Generated from "${body.title}"`,
        }
      : null,
    status: 'published',
    language,
    created_at: new Date().toISOString(),
  };

  const { resource } = await container.items.create(lesson);
  ctx.log(`generateLesson: created ${lesson.id} [${language}] ${topic} (${lesson.body.length} chars)`);
  return { status: 201, jsonBody: resource };
}

app.http('generateLesson', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'lessons/generate',
  handler: generateLesson,
});
