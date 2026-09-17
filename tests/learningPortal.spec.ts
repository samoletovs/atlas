import type { Page } from '@playwright/test';
import { RECOMMENDATIONS_PATH } from '../src/lib/apiRoutes';
import { test, expect, LOCAL_BASE_URL, REPOS, type ReviewState } from './fixtures/learningPortal';

// Deliberately independent of ATLAS_BASE_URL, which belongs to the production auth smoke suite.
test.use({ baseURL: LOCAL_BASE_URL, serviceWorkers: 'block' });

const navigation = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });
const main = (page: Page) => page.getByRole('main');
const lessonLink = (page: Page, id: string) => main(page).locator(`a[href="/lesson/${id}"]`);

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  await page.evaluate(async () => { await document.fonts.ready; });
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(dimensions.document, 'The document must not scroll horizontally').toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(dimensions.body, 'The body must not conceal a wider layout').toBeLessThanOrEqual(dimensions.viewport + 1);
  const controls = await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link').all();
  controls.push(page.getByRole('heading', { level: 1 }));
  for (const control of controls) {
    const box = await control.boundingBox();
    expect(box, 'Navigation and the complete title need a layout box').not.toBeNull();
    if (box) {
      expect(box.x).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width).toBeLessThanOrEqual(dimensions.viewport + 1);
    }
  }
}

test.describe('Clearway local learning portal', () => {
  test('promotes the top ready recommendation over published ordering and folds For you into Learn', async ({ page, portal }) => {
    const { recommended, companion, all, queued } = portal.lessons();
    if (!recommended.source_event) throw new Error('The primary recommendation fixture needs its own source event.');
    expect(companion.created_at > recommended.created_at).toBe(true);
    await portal.goto();

    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(recommended.title);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(navigation(page).getByRole('link')).toHaveText(['Learn', 'Topics', 'Saved', 'History']);
    for (const [label, href] of [['Learn', '/'], ['Topics', '/atlas'], ['Saved', '/saved'], ['History', '/read']]) {
      await expect(navigation(page).getByRole('link', { name: label, exact: true })).toHaveAttribute('href', href);
    }
    await expect(navigation(page).getByRole('link', { name: 'Learn', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(navigation(page).getByRole('link', { name: /for you/i })).toHaveCount(0);
    await expect(main(page).getByText(recommended.recommendation_reason, { exact: true })).toBeVisible();
    await expect(main(page).getByText(recommended.source_event.summary, { exact: true })).toBeVisible();
    await expect(main(page).getByText(/\b8 min\b/).first()).toBeVisible();
    await expect(main(page).getByText(/intermediate/i).first()).toBeVisible();
    await expect(main(page).getByRole('link', { name: 'Read lesson', exact: true })).toHaveAttribute('href', `/lesson/${recommended.id}`);
    for (const lesson of all.filter((candidate) => candidate.status === 'published')) {
      await expect(lessonLink(page, lesson.id).first(), `Ready lesson must remain accessible: ${lesson.title}`).toBeVisible();
    }
    await expect(lessonLink(page, queued.id)).toHaveCount(0);
    expect(portal.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ pathname: RECOMMENDATIONS_PATH, repoId: REPOS[0].repoId, lang: 'en' }),
      expect.objectContaining({ pathname: '/api/lessons', status: 'published', repoId: REPOS[0].repoId, lang: 'en' }),
    ]));
  });

  test('redirects the old /for-you bookmark to the same Learn home', async ({ page, portal }) => {
    await portal.goto('/for-you');
    await expect(page).toHaveURL(new URL('/', LOCAL_BASE_URL).href);
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(portal.lessons().recommended.title);
    await expect(navigation(page).getByRole('link', { name: 'Learn', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(navigation(page).getByRole('link', { name: /for you/i })).toHaveCount(0);
  });

  test('supports profile-menu keyboard navigation and returns focus on Escape', async ({ page, portal }) => {
    await portal.goto();
    const trigger = page.getByRole('button', { name: /example-reader/ });
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: '+ Add repo', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Settings', exact: true })).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.getByRole('menuitem', { name: 'Sign out', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name: 'Account', exact: true })).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('keeps theme metadata and install icons aligned with the app', async ({ page, portal }) => {
    await portal.goto();
    const background = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', await background());
    await page.getByRole('button', { name: /example-reader/ }).click();
    await page.getByRole('menuitem', { name: /^Theme\b/ }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', await background());
    for (const size of [180, 192, 512]) {
      const response = await page.request.get(`/icon-${size}.png`);
      expect(response.status()).toBe(200);
      const body = await response.body();
      expect(body.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(body.readUInt32BE(16)).toBe(size);
      expect(body.readUInt32BE(20)).toBe(size);
    }
  });

  test('keeps a due local review actionable when there are no new or queued lessons', async ({ page, portal }) => {
    const { review } = portal.lessons();
    await portal.reviewOnly();
    await portal.goto();
    await expect(main(page).getByRole('heading', { name: review.title, exact: true })).toBeVisible();
    await expect(main(page).getByRole('link', { name: 'Review lesson', exact: true })).toHaveAttribute('href', `/lesson/${review.id}`);
    await expect(main(page).getByRole('button', { name: 'Mark reviewed', exact: true })).toBeEnabled();
    const before = Date.now();
    await main(page).getByRole('button', { name: 'Mark reviewed', exact: true }).click();
    await expect(main(page).getByRole('button', { name: 'Mark reviewed', exact: true })).toHaveCount(0);
    const stored = await page.evaluate(({ repoId, id }) => {
      const state = JSON.parse(localStorage.getItem(`atlas-spaced-review:${repoId}`) ?? '{}') as Record<string, ReviewState>;
      return state[id];
    }, { repoId: REPOS[0].repoId, id: review.id });
    expect(stored.step).toBe(1);
    expect(Date.parse(stored.updatedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(stored.dueAt)).toBeGreaterThanOrEqual(before + 72 * 60 * 60 * 1000);
    expect(Date.parse(stored.dueAt)).toBeLessThanOrEqual(Date.now() + 72 * 60 * 60 * 1000);
    await page.reload();
    await expect(navigation(page)).toBeVisible();
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText('No ready lessons right now');
    await expect(main(page).getByRole('status').filter({ hasText: /^Loading / })).toHaveCount(0);
    await expect(main(page).getByRole('button', { name: 'Mark reviewed', exact: true })).toHaveCount(0);
    await main(page).getByRole('link', { name: 'Explore Topics', exact: true }).click();
    await expect(page).toHaveURL(new URL('/atlas', LOCAL_BASE_URL).href);
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText('Topics');
  });

  test('shows a recommendations failure while keeping published lessons available, then retries', async ({ page, portal }) => {
    const { recommended, all } = portal.lessons();
    portal.failures.add('recommended');
    await portal.goto();
    const warning = main(page).getByRole('alert').filter({ hasText: /Recommendations couldn't be loaded/ });
    await expect(warning).toBeVisible();
    for (const lesson of all.filter((candidate) => candidate.status === 'published')) {
      await expect(lessonLink(page, lesson.id).first()).toBeVisible();
    }
    await expect(main(page).getByText(recommended.recommendation_reason, { exact: true })).toHaveCount(0);
    portal.failures.clear();
    await main(page).getByRole('button', { name: 'Retry recommendations', exact: true }).click();
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(recommended.title);
    await expect(main(page).getByText(recommended.recommendation_reason, { exact: true })).toBeVisible();
    await expect(warning).toHaveCount(0);
  });

  for (const width of [390, 713]) {
    test(`keeps retry text on one line at ${width}px`, async ({ page, portal }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      portal.failures.add('recommended');
      await portal.goto();
      const retry = main(page).getByRole('button', { name: 'Retry recommendations', exact: true });
      await expect(retry).toBeVisible();
      const metrics = await retry.evaluate(element => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return {
          lines: [...range.getClientRects()].filter(rect => rect.width > 0).length,
          client: element.clientWidth,
          scroll: element.scrollWidth,
          right: element.getBoundingClientRect().right,
          viewport: document.documentElement.clientWidth,
        };
      });
      expect(metrics.lines).toBe(1);
      expect(metrics.scroll).toBeLessThanOrEqual(metrics.client + 1);
      expect(metrics.right).toBeLessThanOrEqual(metrics.viewport);
      const notice = main(page).getByRole('alert').filter({ hasText: "Recommendations couldn't be loaded" });
      await testInfo.attach('retry-message', { body: await notice.screenshot(), contentType: 'image/png' });
    });
  }

  test('exposes complete source failure and recovers through Retry instead of an empty success state', async ({ page, portal }) => {
    for (const source of ['recommended', 'published', 'queued', 'read'] as const) portal.failures.add(source);
    await portal.goto();
    await expect(main(page).getByRole('alert')).toHaveCount(4);
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText("Couldn't load ready lessons");
    await expect(main(page).getByRole('link', { name: 'Read lesson', exact: true })).toHaveCount(0);
    portal.failures.clear();
    const sources = ['recommendations', 'ready lessons', 'queued lessons', 'reading history'];
    for (const [index, source] of sources.entries()) {
      await main(page).getByRole('button', { name: `Retry ${source}`, exact: true }).click();
      await expect(main(page).getByRole('alert')).toHaveCount(sources.length - index - 1);
    }
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(portal.lessons().recommended.title);
    await expect(main(page).getByRole('alert')).toHaveCount(0);
    await expect(main(page).getByRole('link', { name: 'Read lesson', exact: true })).toBeEnabled();
  });

  test('ignores a late recommendation response after switching repository', async ({ page, portal }) => {
    const hold = portal.holdRecommendations(REPOS[0].repoId, 'en');
    await portal.goto();
    await hold.entered;
    await page.getByRole('combobox', { name: 'Switch repo', exact: true }).selectOption(REPOS[1].repoId);
    const next = portal.lessons(REPOS[1].repoId, 'en').recommended;
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(next.title);
    await hold.release();
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(next.title);
    await expect(main(page).getByRole('link', { name: 'Read lesson', exact: true })).toHaveAttribute('href', `/lesson/${next.id}`);
    await expect(lessonLink(page, portal.lessons().recommended.id)).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Switch repo', exact: true })).toHaveValue(REPOS[1].repoId);
  });

  test('ignores a late English recommendation after switching lesson language to Russian', async ({ page, portal }) => {
    const hold = portal.holdRecommendations(REPOS[0].repoId, 'en');
    await portal.goto();
    await hold.entered;
    await page.getByRole('button', { name: /example-reader/ }).click();
    await page.getByRole('menuitem', { name: /^Language\b/ }).click();
    await page.keyboard.press('Escape');
    const next = portal.lessons(REPOS[0].repoId, 'ru').recommended;
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(next.title);
    await hold.release();
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(next.title);
    await expect(main(page).getByRole('link', { name: 'Read lesson', exact: true })).toHaveAttribute('href', `/lesson/${next.id}`);
    await expect(lessonLink(page, portal.lessons().recommended.id)).toHaveCount(0);
    await expect(navigation(page).getByRole('link')).toHaveText(['Learn', 'Topics', 'Saved', 'History']);
    expect(portal.me.preferences.lang).toBe('ru');
  });

  for (const destination of ['Learn', 'History'] as const) {
    test(`applies a confirmed read after navigating to ${destination} while the write is pending`, async ({ page, portal }) => {
      const { recommended } = portal.lessons();
      const pending = portal.holdNextPost(`/api/lessons/${recommended.id}/state`);
      await portal.goto(`/lesson/${recommended.id}`);
      await main(page).getByRole('button', { name: 'Mark read', exact: true }).click();
      await pending.entered;
      await navigation(page).getByRole('link', { name: destination, exact: true }).click();
      if (destination === 'Learn') {
        await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(recommended.title);
      } else {
        await expect(main(page).getByRole('heading', { level: 1 })).toHaveText('History');
        await expect(lessonLink(page, recommended.id)).toHaveCount(0);
      }
      await expect(main(page).getByRole('status').filter({ hasText: /^Loading / })).toHaveCount(0);
      await pending.release();
      await expect(page).toHaveURL(new URL(destination === 'Learn' ? '/' : '/read', LOCAL_BASE_URL).href);
      if (destination === 'Learn') {
        await expect(main(page).getByRole('heading', { level: 1 })).not.toHaveText(recommended.title);
        await expect(lessonLink(page, recommended.id)).toHaveCount(0);
      } else {
        await expect(lessonLink(page, recommended.id)).toBeVisible();
      }
      expect(recommended.status).toBe('read');
    });
  }

  test('does not revive an old Topics generation after returning to the same repository', async ({ page, portal }) => {
    const older = portal.holdNextPost('/api/lessons/generate');
    const newer = portal.holdNextPost('/api/lessons/generate');
    await portal.goto('/atlas');
    const suggestions = main(page).getByRole('region', { name: 'Suggested topics' });
    await suggestions.getByRole('button', { name: /Generate lesson/ }).click();
    await older.entered;
    await page.getByRole('combobox', { name: 'Switch repo', exact: true }).selectOption(REPOS[1].repoId);
    await expect(main(page).getByRole('button', { name: portal.lessons(REPOS[1].repoId).recommended.title, exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: 'Switch repo', exact: true }).selectOption(REPOS[0].repoId);
    await expect(main(page).getByRole('button', { name: portal.lessons().recommended.title, exact: true })).toBeVisible();
    await main(page).getByText('Generate a lesson on a new topic', { exact: true }).click();
    await main(page).getByRole('textbox', { name: 'New topic name', exact: true }).fill('Retry policy');
    const generate = main(page).locator('.atlas-generate-form button[type="submit"]');
    await generate.click();
    await newer.entered;
    await older.release();
    await expect(page).toHaveURL(new URL('/atlas', LOCAL_BASE_URL).href);
    await expect(generate).toBeDisabled();
    await expect(main(page).getByRole('textbox', { name: 'New topic name', exact: true })).toBeDisabled();
    await newer.release();
    await expect(page).toHaveURL(/\/lesson\/.*-generated-/);
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText('Retry policy');
  });

  test('refreshes an expired quota window without requiring a page reload', async ({ page, portal }) => {
    await page.clock.install({ time: new Date('2026-01-01T23:59:00.000Z') });
    portal.me.quota = { used: 2, limit: 2, remaining: 0, resetAt: '2026-01-02T00:00:00.000Z' };
    await portal.goto();
    const generate = main(page).getByRole('region', { name: 'Not ready yet', exact: true })
      .getByRole('button', { name: 'Generate lesson', exact: true });
    await expect(generate).toBeDisabled();
    const requests = portal.requests.filter(request => request.pathname === '/api/me').length;
    portal.me.quota = { used: 0, limit: 2, remaining: 2, resetAt: '2026-01-03T00:00:00.000Z' };
    await page.clock.fastForward(61_000);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(generate).toBeEnabled();
    await expect(page.locator('.quota-badge')).toHaveText('0/2');
    expect(portal.requests.filter(request => request.pathname === '/api/me').length).toBeGreaterThan(requests);
  });

  test('separates queued work from ready lessons and lets an owner generate it', async ({ page, portal }) => {
    const { recommended, queued } = portal.lessons();
    await portal.goto();
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(recommended.title);
    const queue = main(page).getByRole('region', { name: 'Not ready yet', exact: true });
    await expect(queue).toBeVisible();
    await expect(lessonLink(page, queued.id)).toHaveCount(0);
    const queuedCard = queue.getByRole('article').filter({
      has: page.getByRole('heading', { name: queued.title, exact: true }),
    });
    const generate = queuedCard.getByRole('button', { name: 'Generate lesson', exact: true });
    await expect(generate).toBeEnabled();
    const request = page.waitForRequest((candidate) => new URL(candidate.url()).pathname === '/api/lessons/generate');
    await generate.click();
    const sent = await request;
    expect(new URL(sent.url()).searchParams.get('repoId')).toBe(REPOS[0].repoId);
    expect(sent.postDataJSON()).toMatchObject({ title: queued.title, topic: queued.topic, language: 'en' });
    await expect(page).toHaveURL(/\/lesson\/.*-generated-/);
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(queued.title);
    const generated = portal.lessons().all.find((lesson) => lesson.id.includes('-generated-'));
    expect(generated).toMatchObject({ status: 'published', title: queued.title });
    await expect(main(page).getByText('A deterministic Example Company example.', { exact: true })).toBeVisible();
  });

  test.describe('member viewer', () => {
    test.use({ viewerRole: 'member' });

    test('keeps queued and missing topics non-generating for members without losing reader actions', async ({ page, portal }) => {
      const { recommended, queued, companion } = portal.lessons();
      await portal.goto();
      await expect(main(page).getByRole('region', { name: 'Not ready yet', exact: true })).toBeVisible();
      await expect(main(page).getByText(queued.title, { exact: true })).toBeVisible();
      await expect(main(page).getByRole('button', { name: /^Generate / })).toHaveCount(0);
      await main(page).getByRole('link', { name: 'Read lesson', exact: true }).click();
      await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(recommended.title);
      await expect(lessonLink(page, companion.id).first()).toBeVisible();
      await expect(main(page).getByText('automated rollback', { exact: true })).toBeVisible();
      await expect(main(page).getByRole('button', { name: /automated rollback/i })).toHaveCount(0);
      await expect(main(page).getByRole('button', { name: /generate/i })).toHaveCount(0);
      await expect(main(page).getByRole('button', { name: 'Mark read', exact: true })).toBeEnabled();
      await main(page).getByRole('button', { name: 'Save', exact: true }).click();
      await expect(main(page).getByRole('button', { name: /^Saved/ })).toBeVisible();
      await main(page).getByText('Ask atlas', { exact: true }).click();
      await main(page).getByRole('textbox', { name: 'Your question', exact: true }).fill('How can I recover safely?');
      await main(page).getByRole('button', { name: 'Ask', exact: true }).click();
      await expect(main(page).getByText(portal.answers[0], { exact: true })).toBeVisible();
      await main(page).getByText('How was this lesson?', { exact: true }).click();
      await main(page).getByRole('textbox', { name: 'Lesson feedback comment', exact: true }).fill('A useful member view.');
      await main(page).getByRole('button', { name: 'Save feedback', exact: true }).click();
      await expect(main(page).getByRole('status').filter({ hasText: /your feedback is saved/ })).toBeVisible();
      expect(recommended.feedback_comment).toBe('A useful member view.');
      expect(portal.requests.filter((request) => /\/(generate|queue)$/.test(request.pathname))).toEqual([]);
    });
  });

  test('persists save, unsave, and read changes across Saved, History, and a reload', async ({ page, portal }) => {
    const { recommended } = portal.lessons();
    await portal.goto();
    await main(page).getByRole('link', { name: 'Read lesson', exact: true }).click();
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(recommended.title);
    await main(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(main(page).getByRole('button', { name: /^Saved/ })).toBeVisible();
    await navigation(page).getByRole('link', { name: 'Saved', exact: true }).click();
    await expect(lessonLink(page, recommended.id)).toBeVisible();
    await page.reload();
    await lessonLink(page, recommended.id).click();
    await main(page).getByRole('button', { name: /^Saved/ }).click();
    await expect(main(page).getByRole('button', { name: 'Save', exact: true })).toBeVisible();
    await navigation(page).getByRole('link', { name: 'Saved', exact: true }).click();
    await expect(main(page).getByRole('heading', { name: 'No saved lessons yet', exact: true })).toBeVisible();
    await expect(lessonLink(page, recommended.id)).toHaveCount(0);
    await navigation(page).getByRole('link', { name: 'Learn', exact: true }).click();
    await main(page).getByRole('link', { name: 'Read lesson', exact: true }).click();
    await main(page).getByRole('button', { name: 'Mark read', exact: true }).click();
    await expect(page).toHaveURL(new URL('/', LOCAL_BASE_URL).href);
    await expect(main(page).getByRole('heading', { level: 1 })).not.toHaveText(recommended.title);
    await expect(lessonLink(page, recommended.id)).toHaveCount(0);
    await navigation(page).getByRole('link', { name: 'History', exact: true }).click();
    await expect(lessonLink(page, recommended.id)).toBeVisible();
    await page.reload();
    await expect(lessonLink(page, recommended.id)).toBeVisible();
    expect(recommended).toMatchObject({ saved: false, status: 'read' });
    expect(portal.requests.filter((request) => request.pathname.endsWith('/state')).map((request) => request.body)).toEqual([
      { action: 'save' }, { action: 'unsave' }, { action: 'mark_read' },
    ]);
  });

  test('preserves source links, topic navigation, two-turn Ask, rating, and saved comments', async ({ page, portal }) => {
    const { recommended, companion } = portal.lessons();
    await portal.goto(`/lesson/${recommended.id}`);
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(recommended.title);
    await main(page).getByText('Sources and context', { exact: true }).click();
    await expect(main(page).getByRole('heading', { name: 'Sources', exact: true })).toBeVisible();
    const citation = main(page).getByRole('link', { name: recommended.citations[0], exact: true });
    await expect(citation).toHaveAttribute('href', recommended.citations[0]);
    await expect(citation).toHaveAttribute('rel', /noopener/);
    const topicLink = main(page).getByRole('link', { name: 'readiness probes', exact: true });
    await expect(topicLink).toHaveAttribute('href', `/lesson/${companion.id}`);
    await topicLink.click();
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(companion.title);
    await page.goBack();
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(recommended.title);
    const generateTopic = main(page).getByRole('button', { name: 'Generate lesson about automated rollback', exact: true });
    await expect(generateTopic).toBeEnabled();
    await expect(generateTopic).toHaveAttribute('data-topic-generate', 'rollback-automation');

    await main(page).getByText('Ask atlas', { exact: true }).click();
    const draft = main(page).getByRole('textbox', { name: 'Your question', exact: true });
    await draft.fill('How can I recover safely?');
    await main(page).getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(main(page).getByText(portal.answers[0], { exact: true })).toBeVisible();
    await draft.fill('What should I compare first?');
    await main(page).getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(main(page).getByText(portal.answers[1], { exact: true })).toBeVisible();
    expect(portal.requests.filter((request) => request.pathname.endsWith('/ask')).map((request) => request.body)).toEqual([
      { question: 'How can I recover safely?', history: [] },
      {
        question: 'What should I compare first?',
        history: [
          { role: 'user', content: 'How can I recover safely?' },
          { role: 'assistant', content: portal.answers[0] },
        ],
      },
    ]);
    await main(page).getByText('How was this lesson?', { exact: true }).click();
    await main(page).getByRole('button', { name: 'This lesson was helpful', exact: true }).click();
    await expect(main(page).getByRole('button', { name: 'This lesson was helpful', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await main(page).getByRole('button', { name: '5 stars', exact: true }).click();
    await expect(main(page).getByRole('button', { name: '5 stars', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const comment = main(page).getByRole('textbox', { name: 'Lesson feedback comment', exact: true });
    await comment.fill('  The rollback example made the trade-off clear.  ');
    await main(page).getByRole('button', { name: 'Save feedback', exact: true }).click();
    await expect(comment).toHaveValue('The rollback example made the trade-off clear.');
    await page.reload();
    await main(page).getByText('How was this lesson?', { exact: true }).click();
    await expect(main(page).getByRole('button', { name: '5 stars', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(main(page).getByRole('button', { name: 'This lesson was helpful', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(comment).toHaveValue('The rollback example made the trade-off clear.');
    expect(recommended).toMatchObject({ feedback: 'up', rating: 5, feedback_comment: 'The rollback example made the trade-off clear.' });
    expect(portal.requests.filter((request) => /\/(generate|queue)$/.test(request.pathname))).toEqual([]);
  });

  test('opens Topics as a readable list with an optional non-WebGL graph', async ({ page, portal }) => {
    await portal.goto('/atlas');
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText('Topics');
    const views = main(page).getByRole('group', { name: 'Topic view', exact: true });
    await expect(views.getByRole('button', { name: 'List', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(views.getByRole('button', { name: 'Graph', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(main(page).getByRole('img', { name: 'Topic map', exact: true })).toHaveCount(0);
    await expect(main(page).getByRole('button', { name: portal.lessons().companion.title, exact: true })).toBeVisible();
    await views.getByRole('button', { name: 'Graph', exact: true }).click();
    await expect(main(page).getByRole('img', { name: 'Topic map', exact: true })).toBeVisible();
    await expect(page.locator('canvas')).toHaveCount(0);
    await views.getByRole('button', { name: 'List', exact: true }).click();
    await main(page).getByRole('button', { name: portal.lessons().companion.title, exact: true }).click();
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(portal.lessons().companion.title);
  });

  for (const { width, appearance } of [{ width: 320, appearance: 'light' }, { width: 390, appearance: 'dark' }] as const) {
    test.describe(`${width}px ${appearance} Russian content`, () => {
      test.use({ viewport: { width, height: 844 }, lessonLanguage: 'ru', appearance, colorScheme: appearance });

      test('keeps Learn and the long-title reader within the phone width', async ({ page, portal }) => {
        await portal.goto();
        await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(portal.lessons().recommended.title);
        await expect(page.locator('html')).toHaveAttribute('data-theme', appearance);
        await expect(navigation(page).getByRole('link')).toHaveText(['Learn', 'Topics', 'Saved', 'History']);
        await assertNoHorizontalOverflow(page);
        await expect(page.locator('canvas')).toHaveCount(0);
        await main(page).getByRole('link', { name: 'Read lesson', exact: true }).click();
        await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(portal.lessons().recommended.title);
        await expect(main(page).getByRole('heading', { name: 'Практическая проверка', exact: true })).toBeVisible();
        await assertNoHorizontalOverflow(page);
        await expect(main(page).getByRole('button', { name: 'Mark read', exact: true })).toBeEnabled();
        await expect(main(page).getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
        await expect(page.locator('canvas')).toHaveCount(0);
      });
    });
  }

  test.describe('reduced motion', () => {
    test.use({ reducedMotion: 'reduce', viewport: { width: 390, height: 844 } });

    test('retains keyboard navigation and essential read/save actions', async ({ page, portal }) => {
      await portal.goto();
      await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(portal.lessons().recommended.title);
      expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
      const read = main(page).getByRole('link', { name: 'Read lesson', exact: true });
      await read.focus();
      await expect(read).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(portal.lessons().recommended.title);
      const save = main(page).getByRole('button', { name: 'Save', exact: true });
      await save.focus();
      await page.keyboard.press('Enter');
      await expect(main(page).getByRole('button', { name: /^Saved/ })).toBeVisible();
      await main(page).getByRole('button', { name: 'Mark read', exact: true }).click();
      await expect(page).toHaveURL(new URL('/', LOCAL_BASE_URL).href);
      await navigation(page).getByRole('link', { name: 'History', exact: true }).click();
      await expect(lessonLink(page, portal.lessons().recommended.id)).toBeVisible();
      await expect(page.locator('canvas')).toHaveCount(0);
    });
  });
});
