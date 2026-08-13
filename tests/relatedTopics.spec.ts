/**
 * Unit tests for the interactive topic-suggestion ranking.
 *
 * Pure logic — no browser or deployment needed.
 */
import { test, expect } from '@playwright/test';
import type { Lesson } from '../src/lib/api';
import { findRelatedTopics } from '../src/lib/relatedTopics';

function lesson(over: Partial<Lesson> & { id: string }): Lesson {
  return {
    title: 'Title',
    topic: 'topic',
    depth: 'intro',
    read_minutes: 3,
    body: '',
    citations: [],
    suggested_next: [],
    status: 'published',
    language: 'en',
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const current = lesson({
  id: 'cur',
  title: 'Cosmos DB partition keys',
  topic: 'cosmos-partitioning',
});

test.describe('findRelatedTopics', () => {
  test('ranks same-topic lessons above keyword matches', async () => {
    const related = findRelatedTopics(current, [
      current,
      lesson({ id: 'kw', title: 'Cosmos throughput', topic: 'cosmos-ru-budget' }),
      lesson({ id: 'same', title: 'Partition key pitfalls', topic: 'cosmos-partitioning' }),
    ]);

    expect(related.map((r) => r.lesson.id)).toEqual(['same', 'kw']);
    expect(related[0].reason).toContain('More on cosmos-partitioning');
    expect(related[1].reason).toContain('cosmos');
  });

  test('drops the current lesson, unrelated lessons and non-readable ones', async () => {
    const related = findRelatedTopics(current, [
      current,
      lesson({ id: 'unrelated', title: 'Bicep modules', topic: 'infra-bicep' }),
      lesson({ id: 'queued', title: 'Cosmos indexing', topic: 'cosmos-indexing', status: 'queued' }),
      lesson({
        id: 'archived',
        title: 'Cosmos indexing',
        topic: 'cosmos-indexing',
        status: 'archived',
      }),
    ]);

    expect(related).toEqual([]);
  });

  test('excludes topics already surfaced by "What to learn next"', async () => {
    const library = [
      lesson({ id: 'dupe', title: 'Cosmos indexing', topic: 'cosmos-indexing' }),
    ];

    expect(findRelatedTopics(current, library)).toHaveLength(1);
    expect(
      findRelatedTopics(current, library, { excludeTopics: ['cosmos-indexing'] }),
    ).toEqual([]);
  });

  test('honours the limit and prefers unread lessons on a tie', async () => {
    const related = findRelatedTopics(
      current,
      [
        lesson({ id: 'read', title: 'Cosmos indexing', topic: 'cosmos-indexing', status: 'read' }),
        lesson({ id: 'unread', title: 'Cosmos indexing', topic: 'cosmos-indexing' }),
      ],
      { limit: 1 },
    );

    expect(related).toHaveLength(1);
    expect(related[0].lesson.id).toBe('unread');
  });
});
