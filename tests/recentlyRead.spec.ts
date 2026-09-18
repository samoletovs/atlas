import { test, expect } from '@playwright/test';
import {
  getRecentlyReadVersion,
  isRecentlyRead,
  markRecentlyRead,
  subscribeRecentlyRead,
} from '../src/lib/recentlyRead';
import {
  getLessonProgressVersion,
  notifyLessonProgress,
  subscribeLessonProgress,
} from '../src/lib/lessonProgress';

test('saved progress invalidates only its repository without marking lessons read', () => {
  const calls: string[] = [];
  const before = getLessonProgressVersion('saved-store-a');
  const readBefore = getRecentlyReadVersion('saved-store-a');
  const unsubscribeA = subscribeLessonProgress('saved-store-a', () => calls.push('a'));
  const unsubscribeB = subscribeLessonProgress('saved-store-b', () => calls.push('b'));
  try {
    notifyLessonProgress('saved-store-a');
    expect(getLessonProgressVersion('saved-store-a')).toBe(before + 1);
    expect(getRecentlyReadVersion('saved-store-a')).toBe(readBefore);
    expect(isRecentlyRead('saved-lesson', 'saved-store-a')).toBe(false);
    expect(calls).toEqual(['a']);
    unsubscribeA();
    notifyLessonProgress('saved-store-a');
    expect(calls).toEqual(['a']);
  } finally {
    unsubscribeA();
    unsubscribeB();
  }
});

test('confirmed reads also invalidate progress-backed collections', () => {
  const before = getLessonProgressVersion('read-progress-store');
  markRecentlyRead('confirmed-lesson', 'read-progress-store');
  expect(getLessonProgressVersion('read-progress-store')).toBe(before + 1);
});

test('confirmed reads notify only their repository and unsubscribe cleanly', () => {
  const calls: string[] = [];
  const before = getRecentlyReadVersion('review-store-a');
  const unsubscribeA = subscribeRecentlyRead('review-store-a', () => calls.push('a'));
  const unsubscribeB = subscribeRecentlyRead('review-store-b', () => calls.push('b'));
  try {
    markRecentlyRead('same-document-id', 'review-store-a');
    expect(isRecentlyRead('same-document-id', 'review-store-a')).toBe(true);
    expect(isRecentlyRead('same-document-id', 'review-store-b')).toBe(false);
    expect(getRecentlyReadVersion('review-store-a')).toBe(before + 1);
    expect(calls).toEqual(['a']);
    unsubscribeA();
    markRecentlyRead('another-document', 'review-store-a');
    expect(calls).toEqual(['a']);
  } finally {
    unsubscribeA();
    unsubscribeB();
  }
});
