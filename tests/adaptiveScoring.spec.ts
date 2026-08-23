/**
 * Unit tests for the adaptive-learning-path scoring logic used by
 * api/src/functions/getRecommendations.ts.
 *
 * Pure logic — no browser, Cosmos DB or deployment needed.
 */
import { test, expect } from '@playwright/test';
import {
  buildTopicProfile,
  scoreLesson,
  ScorableLesson,
  ScorableProgress,
} from '../api/src/shared/adaptiveScoring';

interface FakeLesson extends ScorableLesson {
  id: string;
}

function lesson(over: Partial<FakeLesson> & { id: string; topic: string }): FakeLesson {
  return {
    depth: 'intro',
    ...over,
  };
}

function progress(over: Partial<ScorableProgress> = {}): ScorableProgress {
  return { status: 'read', ...over };
}

test.describe('buildTopicProfile', () => {
  test('tracks the highest depth read per topic', () => {
    const readLessons = [
      lesson({ id: 'a', topic: 'react', depth: 'intro' }),
      lesson({ id: 'b', topic: 'react', depth: 'intermediate' }),
    ];
    const progressByLesson = new Map([
      ['a', progress()],
      ['b', progress()],
    ]);

    const profile = buildTopicProfile(readLessons, progressByLesson, (l) => l.id);

    expect(profile.get('react')).toEqual({ highestDepthRead: 'intermediate', hasSaved: false });
  });

  test('ignores lessons without a "read" progress record', () => {
    const readLessons = [lesson({ id: 'a', topic: 'react', depth: 'intro' })];
    const progressByLesson = new Map([['a', progress({ status: 'unread' })]]);

    const profile = buildTopicProfile(readLessons, progressByLesson, (l) => l.id);

    expect(profile.has('react')).toBe(false);
  });

  test('marks a topic as saved when any read lesson on it is saved', () => {
    const readLessons = [lesson({ id: 'a', topic: 'react', depth: 'intro' })];
    const progressByLesson = new Map([['a', progress({ saved: true })]]);

    const profile = buildTopicProfile(readLessons, progressByLesson, (l) => l.id);

    expect(profile.get('react')?.hasSaved).toBe(true);
  });
});

test.describe('scoreLesson', () => {
  test('prefers intro lessons for brand-new topics', () => {
    const profile = new Map();
    expect(scoreLesson(lesson({ id: 'x', topic: 'go', depth: 'intro' }), profile).score).toBe(5);
    expect(
      scoreLesson(lesson({ id: 'x', topic: 'go', depth: 'intermediate' }), profile).score,
    ).toBe(2);
    expect(scoreLesson(lesson({ id: 'x', topic: 'go', depth: 'deep' }), profile).score).toBe(1);
  });

  test('recommends intermediate next once intro is read', () => {
    const profile = new Map([['go', { highestDepthRead: 'intro' as const, hasSaved: false }]]);

    expect(
      scoreLesson(lesson({ id: 'x', topic: 'go', depth: 'intermediate' }), profile).score,
    ).toBe(5);
    expect(scoreLesson(lesson({ id: 'x', topic: 'go', depth: 'deep' }), profile).score).toBe(3);
    expect(scoreLesson(lesson({ id: 'x', topic: 'go', depth: 'intro' }), profile).score).toBe(1);
  });

  test('recommends deep dives once intermediate is read', () => {
    const profile = new Map([
      ['go', { highestDepthRead: 'intermediate' as const, hasSaved: false }],
    ]);

    expect(scoreLesson(lesson({ id: 'x', topic: 'go', depth: 'deep' }), profile).score).toBe(5);
    expect(
      scoreLesson(lesson({ id: 'x', topic: 'go', depth: 'intermediate' }), profile).score,
    ).toBe(1);
    expect(scoreLesson(lesson({ id: 'x', topic: 'go', depth: 'intro' }), profile).score).toBe(0);
  });

  test('deprioritizes a topic once fully mastered at depth', () => {
    const profile = new Map([['go', { highestDepthRead: 'deep' as const, hasSaved: false }]]);

    expect(scoreLesson(lesson({ id: 'x', topic: 'go', depth: 'deep' }), profile).score).toBe(1);
  });

  test('applies a +2 bonus and rewrites the reason when the topic is saved', () => {
    const profile = new Map([['go', { highestDepthRead: null, hasSaved: true }]]);

    const result = scoreLesson(lesson({ id: 'x', topic: 'go', depth: 'intro' }), profile);

    expect(result.score).toBe(7);
    expect(result.reason).toMatch(/^Saved interest:/);
  });
});
