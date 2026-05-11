/**
 * POST /api/lessons/{id}/ask?repoId=<id>
 * Body: { question: string, history?: [{ role: 'user'|'assistant', content: string }] }
 *
 * Ask-more chat: takes a lesson and a follow-up question, calls Azure
 * OpenAI with the lesson body as grounding context, and returns a short
 * answer. The conversation is NOT persisted server-side — the client owns
 * the transcript and replays it on each turn.
 *
 * Anyone with read access to the repo (owner or member) can ask. The
 * caller's daily generation quota is reused as a soft rate limit so a
 * runaway chat can't drain Sam's tokens.
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { lessonsV2Container, LessonV2 } from '../shared/cosmos.js';
import { resolveRequest, isHttpResponse } from '../shared/auth.js';
import { consumeAskTurn } from '../shared/quota.js';
import { getOpenAIClientForUser } from '../shared/openaiClient.js';

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

interface AskBody {
  question?: string;
  history?: ChatTurn[];
}

const MAX_QUESTION_CHARS = 1000;
const MAX_HISTORY_TURNS = 8;
const MAX_HISTORY_TURN_CHARS = 2000;
const MAX_HISTORY_TOTAL_CHARS = 12000;
const MAX_ANSWER_TOKENS = 600;

const ASK_INSTRUCTIONS = `You are atlas — a personal teacher. The reader just finished a
short lesson and has a follow-up question. Answer it directly, grounded primarily in the
lesson they read.

Rules:

1. Keep answers concise (≤200 words). The reader is on a phone.
2. Stay on topic. If the question wanders far from the lesson, gently steer back or note
   "that's outside this lesson — atlas could write a new one on it".
3. Use plain language. The reader is functional, not deep technical.
4. Use short paragraphs and bullets when helpful. No code fences unless absolutely needed.
5. Don't invent citations. If you reference a fact, either cite a source the lesson
   already cited, or say "you'd want to verify this with Microsoft Learn / the docs".
6. Match the language of the question (English or Russian). The lesson language is a hint.
7. NEVER paste the lesson back verbatim. Build on it.`;

function buildSystemPrompt(lesson: LessonV2): string {
  // Trim very long bodies so we keep tokens for the conversation.
  const body = lesson.body.length > 6000 ? lesson.body.slice(0, 6000) + '…' : lesson.body;
  const citationsBlock = lesson.citations.length
    ? `\n\nCitations from the lesson:\n${lesson.citations.map((c) => `- ${c}`).join('\n')}`
    : '';
  return `${ASK_INSTRUCTIONS}

--- LESSON THE READER JUST FINISHED ---
Title: ${lesson.title}
Topic: ${lesson.topic}
Depth: ${lesson.depth}
Language: ${lesson.language}

${body}${citationsBlock}
--- END LESSON ---`;
}

export async function askLesson(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const r = await resolveRequest(req);
  if (isHttpResponse(r)) return r;
  const { userId, repoId } = r;

  const id = req.params.id;
  if (!id) return { status: 400, jsonBody: { error: 'Missing lesson id' } };

  // Per-user soft rate limit on follow-up chat turns. Atomically bumps a
  // counter on the user doc so a runaway client can't drain tokens.
  const quota = await consumeAskTurn(userId);
  if (quota.exceeded) {
    return {
      status: 429,
      jsonBody: {
        error: `Daily chat cap reached (${quota.used}/${quota.limit}). Resets at ${quota.resetAt}.`,
        used: quota.used,
        limit: quota.limit,
        resetAt: quota.resetAt,
      },
    };
  }

  let body: AskBody;
  try {
    body = (await req.json()) as AskBody;
  } catch {
    return { status: 400, jsonBody: { error: 'Invalid JSON body' } };
  }

  const question = (body.question ?? '').trim();
  if (!question) {
    return { status: 400, jsonBody: { error: 'question is required' } };
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return {
      status: 400,
      jsonBody: { error: `question too long (max ${MAX_QUESTION_CHARS} chars)` },
    };
  }

  // Load lesson.
  let lesson: LessonV2 | undefined;
  try {
    const { resource } = await lessonsV2Container().item(id, repoId).read<LessonV2>();
    lesson = resource ?? undefined;
  } catch (e: unknown) {
    if (e instanceof Error && (e as { code?: number }).code === 404) {
      return { status: 404, jsonBody: { error: 'Lesson not found' } };
    }
    throw e;
  }
  if (!lesson) return { status: 404, jsonBody: { error: 'Lesson not found' } };

  // Build chat history. Trim to last N turns, cap each turn's content to
  // bound input tokens, and reject the request if the total history payload
  // is still too large after truncation — that signals a misbehaving client.
  const rawHistory: ChatTurn[] = Array.isArray(body.history)
    ? body.history
        .filter(
          (t): t is ChatTurn =>
            !!t &&
            (t.role === 'user' || t.role === 'assistant') &&
            typeof t.content === 'string' &&
            t.content.trim().length > 0,
        )
        .slice(-MAX_HISTORY_TURNS)
    : [];

  const history: ChatTurn[] = rawHistory.map((t) => ({
    role: t.role,
    content:
      t.content.length > MAX_HISTORY_TURN_CHARS
        ? t.content.slice(0, MAX_HISTORY_TURN_CHARS) + '…'
        : t.content,
  }));

  const totalHistoryChars = history.reduce((n, t) => n + t.content.length, 0);
  if (totalHistoryChars > MAX_HISTORY_TOTAL_CHARS) {
    return {
      status: 400,
      jsonBody: {
        error: `history too large (got ${totalHistoryChars} chars, max ${MAX_HISTORY_TOTAL_CHARS})`,
      },
    };
  }

  const { client, deployment } = await getOpenAIClientForUser(userId);
  try {
    const completion = await client.chat.completions.create({
      model: deployment,
      temperature: 0.4,
      max_tokens: MAX_ANSWER_TOKENS,
      messages: [
        { role: 'system', content: buildSystemPrompt(lesson) },
        ...history.map((t) => ({ role: t.role, content: t.content })),
        { role: 'user', content: question },
      ],
    });
    const answer = (completion.choices[0]?.message?.content ?? '').trim();
    if (!answer) {
      return { status: 502, jsonBody: { error: 'Model returned empty response' } };
    }
    ctx.log(`askLesson: ${userId} on ${id} -> ${answer.length} chars`);
    return { status: 200, jsonBody: { answer, lessonId: id } };
  } catch (err: unknown) {
    ctx.error('askLesson model call failed', err);
    const message = err instanceof Error ? err.message : String(err);
    return { status: 502, jsonBody: { error: `Model call failed: ${message}` } };
  }
}

app.http('askLesson', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'lessons/{id}/ask',
  handler: askLesson,
});
