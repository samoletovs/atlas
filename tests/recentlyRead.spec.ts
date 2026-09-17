import { test, expect } from '@playwright/test';
import {
  getRecentlyReadVersion,
  isRecentlyRead,
  markRecentlyRead,
  subscribeRecentlyRead,
} from '../src/lib/recentlyRead';

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
