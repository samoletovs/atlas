import { test, expect } from '@playwright/test';
import { LESSON_API_CACHE_PATTERN, RECOMMENDATIONS_PATH } from '../src/lib/apiRoutes';

test('the recommendation collection has an unambiguous top-level path', () => {
  expect(RECOMMENDATIONS_PATH).toBe('/api/recommendations');
});

test('offline caching includes canonical recommendations and existing lesson URLs only', () => {
  for (const path of [
    RECOMMENDATIONS_PATH,
    `${RECOMMENDATIONS_PATH}?lang=ru&repoId=example`,
    '/api/lessons?status=published&lang=en',
    '/api/lessons/example-id',
    '/api/lessons/recommended?lang=en',
  ]) {
    expect(LESSON_API_CACHE_PATTERN.test(`https://example.invalid${path}`), path).toBe(true);
  }
  for (const path of ['/.auth/me', '/api/me', '/api/recommendations-extra', '/api/recommendations/other', '/api/lessons-extra']) {
    expect(LESSON_API_CACHE_PATTERN.test(`https://example.invalid${path}`), path).toBe(false);
  }
});
