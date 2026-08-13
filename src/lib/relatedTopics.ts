/**
 * Interactive topic suggestions.
 *
 * Ranks lessons already in the reader's library by how related they are to the
 * lesson currently open, so the reader can keep exploring without waiting for
 * (or paying for) a generation round-trip. Pure + synchronous: it only uses the
 * library the reader has already fetched.
 *
 * Scoring:
 *   - same topic slug, different lesson  → +6 ("More on <topic>")
 *   - each shared topic-slug keyword     → +3
 *   - each shared title keyword          → +1
 *   - never read yet                     → +1
 */
import type { Lesson } from './api';

export interface RelatedTopic {
  lesson: Lesson;
  /** Higher = more related. Not persisted. */
  score: number;
  /** Short, human-readable explanation shown under the link. */
  reason: string;
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'how',
  'in', 'into', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'via', 'what', 'when',
  'why', 'with', 'your',
]);

/** Split a topic slug or title into lowercase, de-noised keywords. */
function keywords(value: string): Set<string> {
  const out = new Set<string>();
  for (const raw of value.toLowerCase().split(/[^a-z0-9а-яё]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

function overlap(a: Set<string>, b: Set<string>): string[] {
  const shared: string[] = [];
  for (const token of a) {
    if (b.has(token)) shared.push(token);
  }
  return shared;
}

/** Lessons the reader can actually open right now. */
function isReadable(lesson: Lesson): boolean {
  return lesson.status === 'published' || lesson.status === 'read';
}

export interface RelatedTopicsOptions {
  /** Max suggestions to return. Default 4. */
  limit?: number;
  /** Topic slugs already surfaced elsewhere (e.g. "What to learn next"). */
  excludeTopics?: Iterable<string>;
}

/**
 * Return the most related lessons from `library` for `current`, best first.
 * Lessons with no overlap at all are dropped, so an unrelated library yields
 * an empty list rather than noise.
 */
export function findRelatedTopics(
  current: Lesson,
  library: Lesson[],
  options: RelatedTopicsOptions = {},
): RelatedTopic[] {
  const limit = options.limit ?? 4;
  if (limit <= 0) return [];

  const excluded = new Set<string>();
  for (const topic of options.excludeTopics ?? []) {
    excluded.add(topic.toLowerCase());
  }

  const currentTopic = current.topic.toLowerCase();
  const currentTopicWords = keywords(current.topic);
  const currentTitleWords = keywords(current.title);

  const scored: RelatedTopic[] = [];

  for (const candidate of library) {
    if (candidate.id === current.id) continue;
    if (!isReadable(candidate)) continue;
    const candidateTopic = candidate.topic.toLowerCase();
    if (excluded.has(candidateTopic)) continue;

    let score = 0;
    let reason: string;

    const sharedTopicWords = overlap(currentTopicWords, keywords(candidate.topic));
    const sharedTitleWords = overlap(currentTitleWords, keywords(candidate.title));

    if (candidateTopic === currentTopic) {
      score += 6;
      reason = `More on ${candidate.topic} — ${candidate.depth} level`;
    } else if (sharedTopicWords.length > 0) {
      score += 3 * sharedTopicWords.length;
      reason = `Related to ${sharedTopicWords.join(', ')}`;
    } else if (sharedTitleWords.length > 0) {
      reason = `Shares ${sharedTitleWords.join(', ')} with this lesson`;
    } else {
      continue;
    }

    score += sharedTitleWords.length;
    if (candidate.status !== 'read') {
      score += 1;
      reason += ' · not read yet';
    }

    scored.push({ lesson: candidate, score, reason });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Tie-break: most recently created first.
    return a.lesson.created_at < b.lesson.created_at ? 1 : -1;
  });

  return scored.slice(0, limit);
}
