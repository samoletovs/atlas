/**
 * Pure adaptive-learning scoring logic, extracted from getRecommendations.ts
 * so it can be unit tested without a Cosmos DB connection.
 *
 * See api/src/functions/getRecommendations.ts for the full algorithm
 * description and how this is wired into the HTTP endpoint.
 */

export type Depth = 'intro' | 'intermediate' | 'deep';

export const DEPTH_RANK: Record<Depth, number> = { intro: 1, intermediate: 2, deep: 3 };

export interface TopicProfile {
  highestDepthRead: Depth | null;
  hasSaved: boolean;
}

/** Minimal shape of a lesson needed to build a topic profile / score it. */
export interface ScorableLesson {
  topic: string;
  depth: Depth;
}

/** Minimal shape of a per-reader progress record needed for scoring. */
export interface ScorableProgress {
  status: 'unread' | 'read';
  saved?: boolean;
}

/**
 * Build a map of topic → { highestDepthRead, hasSaved } from the user's
 * read lessons for this repo.
 */
export function buildTopicProfile<L extends ScorableLesson>(
  readLessons: L[],
  progressByLesson: Map<string, ScorableProgress>,
  lessonId: (lesson: L) => string,
): Map<string, TopicProfile> {
  const profile = new Map<string, TopicProfile>();

  for (const lesson of readLessons) {
    const prog = progressByLesson.get(lessonId(lesson));
    if (!prog || prog.status !== 'read') continue;

    const topic = lesson.topic;
    const existing: TopicProfile = profile.get(topic) ?? {
      highestDepthRead: null,
      hasSaved: false,
    };

    const currentRank = DEPTH_RANK[lesson.depth];
    const prevRank = existing.highestDepthRead
      ? DEPTH_RANK[existing.highestDepthRead]
      : 0;
    if (currentRank > prevRank) {
      existing.highestDepthRead = lesson.depth;
    }
    if (prog.saved) {
      existing.hasSaved = true;
    }

    profile.set(topic, existing);
  }

  return profile;
}

/** Compute an adaptive score and human-readable reason for an unread lesson. */
export function scoreLesson(
  lesson: ScorableLesson,
  topicProfile: Map<string, TopicProfile>,
): { score: number; reason: string } {
  const tp = topicProfile.get(lesson.topic);
  const depth = lesson.depth;

  let score: number;
  let reason: string;

  if (!tp || tp.highestDepthRead === null) {
    // Brand-new topic — prefer intro, then intermediate, then deep.
    if (depth === 'intro') {
      score = 5;
      reason = 'New topic — great starting point';
    } else if (depth === 'intermediate') {
      score = 2;
      reason = 'New topic — intro recommended first';
    } else {
      score = 1;
      reason = 'New topic — consider starting at intro';
    }
  } else if (tp.highestDepthRead === 'intro') {
    if (depth === 'intermediate') {
      score = 5;
      reason = 'Natural next step — you\'ve finished the intro';
    } else if (depth === 'deep') {
      score = 3;
      reason = 'Advanced — intermediate is the typical next step';
    } else {
      score = 1;
      reason = 'More on a familiar topic';
    }
  } else if (tp.highestDepthRead === 'intermediate') {
    if (depth === 'deep') {
      score = 5;
      reason = 'Ready for the deep dive — you\'ve covered intermediate';
    } else if (depth === 'intermediate') {
      score = 1;
      reason = 'More at your current level';
    } else {
      score = 0;
      reason = 'Already past this depth';
    }
  } else {
    // highestDepthRead === 'deep' — topic fully explored
    score = 1;
    reason = 'Topic you\'ve mastered — another perspective';
  }

  // Saved-topic bonus: user showed explicit interest.
  if (tp?.hasSaved) {
    score += 2;
    reason = `Saved interest: ${reason.toLowerCase()}`;
  }

  return { score, reason };
}
