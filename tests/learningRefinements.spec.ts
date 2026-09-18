import type { Page } from '@playwright/test';
import { test, expect, LOCAL_BASE_URL, REPOS, type PortalBackend } from './fixtures/learningPortal';

test.use({ baseURL: LOCAL_BASE_URL, serviceWorkers: 'block' });

const main = (page: Page) => page.getByRole('main');
const navigation = (page: Page, name: string) => page.getByRole('navigation', { name: 'Main navigation' })
  .getByRole('link', { name, exact: true });
const savedLink = (page: Page, id: string) => main(page).locator(`a[href="/lesson/${id}"]`);
const countMe = (portal: PortalBackend) => portal.requests.filter(request => request.pathname === '/api/me').length;
const countSaved = (portal: PortalBackend, repoId: string) => portal.requests
  .filter(request => request.status === 'saved' && request.repoId === repoId).length;
const quota = (remaining: number) => ({
  used: 1 - remaining, limit: 1, remaining, resetAt: '2099-01-01T00:00:00.000Z',
});

for (const action of ['save', 'unsave'] as const) {
  test(`a delayed ${action} updates the active Saved collection without marking the lesson read`, async ({ page, portal }) => {
    const { recommended } = portal.lessons();
    recommended.saved = action === 'unsave';
    const pending = portal.holdNextPost(`/api/lessons/${recommended.id}/state`);
    await portal.goto(`/lesson/${recommended.id}`);
    await main(page).getByRole('button', { name: action === 'save' ? 'Save' : 'Saved ✓', exact: true }).click();
    await pending.entered;
    await navigation(page, 'Saved').click();
    await expect(main(page).getByRole('status').filter({ hasText: /^Loading / })).toHaveCount(0);
    await expect(savedLink(page, recommended.id)).toHaveCount(action === 'save' ? 0 : 1);
    const before = countSaved(portal, REPOS[0].repoId);
    await pending.release();
    await expect(savedLink(page, recommended.id)).toHaveCount(action === 'save' ? 1 : 0);
    expect(countSaved(portal, REPOS[0].repoId)).toBeGreaterThan(before);
    expect(recommended.status).toBe('published');
    await navigation(page, 'Learn').click();
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(recommended.title);
  });
}

test('a late saved write does not invalidate another repository collection', async ({ page, portal }) => {
  const { recommended } = portal.lessons();
  const pending = portal.holdNextPost(`/api/lessons/${recommended.id}/state`);
  await portal.goto(`/lesson/${recommended.id}`);
  await main(page).getByRole('button', { name: 'Save', exact: true }).click();
  await pending.entered;
  await navigation(page, 'Saved').click();
  await expect(main(page).getByRole('heading', { level: 1 })).toHaveText('Saved');
  await page.getByRole('combobox', { name: 'Switch repo' }).selectOption(REPOS[1].repoId);
  await expect(main(page).getByRole('heading', { name: 'No saved lessons yet' })).toBeVisible();
  await expect(main(page).getByRole('status').filter({ hasText: /^Loading / })).toHaveCount(0);
  const before = countSaved(portal, REPOS[1].repoId);
  await pending.release();
  expect(countSaved(portal, REPOS[1].repoId)).toBe(before);
  await expect(savedLink(page, recommended.id)).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Switch repo' }).selectOption(REPOS[0].repoId);
  await expect(savedLink(page, recommended.id)).toBeVisible();
});

test('a failed save does not invalidate Saved or claim a successful write', async ({ page, portal }) => {
  const { recommended } = portal.lessons();
  await page.route('**/api/lessons/*/state?*', route =>
    route.fulfill({ status: 503, json: { error: 'Synthetic save unavailable' } }));
  await portal.goto(`/lesson/${recommended.id}`);
  await main(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(main(page).getByRole('alert')).toContainText('Synthetic save unavailable');
  expect(recommended.saved).toBe(false);
  await navigation(page, 'Saved').click();
  await expect(main(page).getByRole('heading', { name: 'No saved lessons yet' })).toBeVisible();
});

type GenerationEntry = 'inline topic' | 'suggested lesson' | 'Topics suggestion' | 'Topics new topic';

async function openGeneration(page: Page, portal: PortalBackend, entry: GenerationEntry) {
  if (entry.startsWith('Topics')) {
    await portal.goto('/atlas');
    if (entry === 'Topics new topic') {
      await main(page).getByText('Generate a lesson on a new topic', { exact: true }).click();
      await main(page).getByRole('textbox', { name: 'New topic name' }).fill('Synthetic recovery policy');
      return main(page).locator('.atlas-generate-form button[type="submit"]');
    }
    return main(page).getByRole('region', { name: 'Suggested topics' })
      .getByRole('button', { name: /Generate lesson/ });
  }
  await portal.goto(`/lesson/${portal.lessons().recommended.id}`);
  return entry === 'inline topic'
    ? main(page).getByRole('button', { name: 'Generate lesson about automated rollback', exact: true })
    : main(page).getByRole('button', { name: 'Generate this →', exact: true });
}

for (const entry of ['inline topic', 'suggested lesson', 'Topics suggestion', 'Topics new topic'] as const) {
  test(`${entry} generation refreshes the account quota before further generation`, async ({ page, portal }) => {
    portal.me.quota = quota(1);
    const generate = await openGeneration(page, portal, entry);
    await expect(generate).toBeEnabled();
    const before = countMe(portal);
    await generate.click();
    await expect(page).toHaveURL(/\/lesson\/.*-generated-/);
    await expect(page.locator('.quota-badge')).toHaveText('1/1');
    expect(countMe(portal)).toBeGreaterThan(before);
    await navigation(page, 'Learn').click();
    await expect(main(page).getByRole('button', { name: 'Generate lesson', exact: true })).toBeDisabled();
    await navigation(page, 'Topics').click();
    await expect(main(page).getByRole('status').filter({ hasText: /generation limit has been reached/ })).toBeVisible();
    await main(page).getByText('Generate a lesson on a new topic', { exact: true }).click();
    await expect(main(page).getByRole('textbox', { name: 'New topic name' })).toBeDisabled();
  });
}

for (const entry of ['inline topic', 'suggested lesson', 'Topics suggestion'] as const) {
  test(`${entry} generation failure refreshes exhausted quota and preserves its error`, async ({ page, portal }) => {
    portal.me.quota = quota(1);
    await page.route('**/api/lessons/generate?*', async route => {
      portal.me.quota = quota(0);
      await route.fulfill({ status: 429, json: { error: 'Synthetic daily cap reached' } });
    });
    const dialogs: string[] = [];
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
    const generate = await openGeneration(page, portal, entry);
    await expect(generate).toBeEnabled();
    const before = countMe(portal);
    await generate.click();
    await expect(page.locator('.quota-badge')).toHaveText('1/1');
    expect(countMe(portal)).toBeGreaterThan(before);
    await expect(generate).toBeDisabled();
    if (entry === 'inline topic') {
      expect(dialogs).toEqual([expect.stringContaining('Synthetic daily cap reached')]);
    } else {
      await expect(main(page).getByText(/Synthetic daily cap reached/).first()).toBeVisible();
    }
  });
}

test('a failed quota refresh is retryable without discarding the generation error', async ({ page, portal }) => {
  portal.me.quota = quota(1);
  const generate = await openGeneration(page, portal, 'Topics suggestion');
  await expect(generate).toBeEnabled();
  let failRefresh = true;
  await page.route('**/api/me', async route => {
    if (failRefresh) await route.fulfill({ status: 503, json: { error: 'Synthetic account outage' } });
    else await route.fallback();
  });
  await page.route('**/api/lessons/generate?*', route =>
    route.fulfill({ status: 502, json: { error: 'Synthetic generation unavailable' } }));
  await generate.click();
  await expect(main(page).getByText(/Synthetic generation unavailable/).first()).toBeVisible();
  const retry = main(page).getByRole('button', { name: 'Retry daily limit', exact: true });
  await expect(retry).toBeEnabled();
  failRefresh = false;
  portal.me.quota = quota(0);
  await retry.click();
  await expect(retry).toHaveCount(0);
  await expect(page.locator('.quota-badge')).toHaveText('1/1');
  await expect(generate).toBeDisabled();
  await expect(main(page).getByText(/Synthetic generation unavailable/).first()).toBeVisible();
});

for (const entry of ['inline topic', 'suggested lesson', 'Topics suggestion'] as const) {
  test(`departed ${entry} generation updates only authoritative quota, not navigation`, async ({ page, portal }) => {
    portal.me.quota = quota(1);
    const pending = portal.holdNextPost('/api/lessons/generate');
    const generate = await openGeneration(page, portal, entry);
    await generate.click();
    await pending.entered;
    await navigation(page, 'Saved').click();
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText('Saved');
    await page.getByRole('combobox', { name: 'Switch repo' }).selectOption(REPOS[1].repoId);
    await expect(main(page).getByRole('heading', { name: 'No saved lessons yet' })).toBeVisible();
    await pending.release();
    await expect(page.locator('.quota-badge')).toHaveText('1/1');
    await expect(page).toHaveURL(new URL('/saved', LOCAL_BASE_URL).href);
    await expect(page.getByRole('combobox', { name: 'Switch repo' })).toHaveValue(REPOS[1].repoId);
    await expect(main(page).getByRole('heading', { name: 'No saved lessons yet' })).toBeVisible();
  });
}

for (const entry of ['inline topic', 'suggested lesson', 'Topics suggestion'] as const) {
  test(`${entry} respects a known exhausted limit and resets it without reloading`, async ({ page, portal }) => {
    await page.clock.install({ time: new Date('2026-01-01T23:59:00.000Z') });
    portal.me.quota = { ...quota(0), resetAt: '2026-01-02T00:00:00.000Z' };
    const generate = await openGeneration(page, portal, entry);
    await expect(generate).toBeDisabled();
    const before = countMe(portal);
    portal.me.quota = { ...quota(1), resetAt: '2026-01-03T00:00:00.000Z' };
    await page.clock.fastForward(61_000);
    await expect(page.locator('.quota-badge')).toHaveText('0/1');
    await expect(generate).toBeEnabled();
    expect(countMe(portal)).toBeGreaterThan(before);
    expect(portal.requests.filter(request => request.pathname.endsWith('/generate'))).toHaveLength(0);
  });
}
