import { test, expect, type Page, type Route } from '@playwright/test';
import type { AllowedRepo, AtlasMe, GithubRepoListItem, Lesson, RepoShare } from '../src/lib/api';

const baseURL = process.env.ATLAS_LOCAL_BASE_URL ?? 'http://127.0.0.1:43127';
const origin = new URL(baseURL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
  || !['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) {
  throw new Error('Support tests require a credential-free loopback server.');
}
test.use({ baseURL, serviceWorkers: 'block' });
test.setTimeout(20_000);
test.use({ actionTimeout: 5000 });

const repos: AllowedRepo[] = [
  { repoId: 'reader__alpha', name: 'Alpha', ownerId: 'reader', githubUrl: 'https://github.com/reader/alpha', visibility: 'private', role: 'owner' },
  { repoId: 'reader__beta', name: 'Beta', ownerId: 'reader', githubUrl: 'https://github.com/reader/beta', visibility: 'private', role: 'owner' },
];
const me: AtlasMe = {
  userId: 'reader', githubLogin: 'reader', githubId: 123, createdAt: '2026-01-01',
  allowedRepos: repos, preferences: { theme: 'light', lang: 'en' }, githubToken: { scopes: [], addedAt: '2026-01-01' },
  quota: { used: 0, limit: null, remaining: null, resetAt: '2026-09-19' },
};
const browseRepo: GithubRepoListItem = {
  fullName: 'reader/newrepo', owner: 'reader', repo: 'newrepo', htmlUrl: 'https://github.com/reader/newrepo',
  description: null, isPrivate: false, isFork: false, isArchived: false, defaultBranch: 'main',
  language: null, stargazersCount: 0, pushedAt: null, inAtlas: false, ownedByOther: false,
};
const newRepo: AllowedRepo = { ...repos[0], repoId: 'reader__newrepo', name: 'newrepo' };
const share = (repoId: string, githubLogin: string): RepoShare => ({
  id: `${repoId}_${githubLogin}`, repoId, githubLogin, role: 'member', invitedBy: 'reader', createdAt: '2026-01-01',
});
const json = (route: Route, value: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function mock(page: Page, handler?: (route: Route, url: URL) => Promise<boolean>) {
  const errors: string[] = [];
  const requests: URL[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('atlas-repo', 'reader__alpha'));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin.origin) return route.abort('blockedbyclient');
    if (url.pathname === '/.auth/me' || url.pathname.startsWith('/api/')) {
      requests.push(url);
      if (await handler?.(route, url)) return;
      if (url.pathname === '/.auth/me') return json(route, { clientPrincipal: {
        userId: 'reader', userDetails: 'reader', identityProvider: 'github', userRoles: ['authenticated'],
      } });
      if (url.pathname === '/api/me') return json(route, me);
      if (url.pathname === '/api/shares') return json(route, { shares: [] });
      if (url.pathname === '/api/github/repos') return json(route, { repos: [browseRepo] });
      if (url.pathname === '/api/lessons' || url.pathname === '/api/recommendations') return json(route, { lessons: [] });
      return json(route, { error: `Unexpected synthetic route ${url.pathname}` }, 500);
    }
    return route.continue();
  });
  return { errors, requests };
}
async function openMenuPage(page: Page, name: string) {
  await page.getByRole('button', { name: /^reader/ }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}
async function flushRender(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

for (const failedPath of ['/.auth/me', '/api/me']) {
  test(`bootstrap recovers from ${failedPath} failure without claiming access denial`, async ({ page }) => {
    let fail = true;
    const state = await mock(page, async (route, url) => {
      if (url.pathname !== failedPath || !fail) return false;
      if (failedPath === '/.auth/me') await route.abort('failed');
      else await json(route, { error: 'Synthetic outage' }, 503);
      return true;
    });
    await page.goto('/about');
    await expect(page.getByRole('alert')).toContainText(/load|connect/i, { timeout: 3000 });
    await expect(page.getByText(/isn.t on the access list yet/)).toHaveCount(0);
    fail = false;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'About atlas' })).toBeVisible();
    expect(state.errors).toEqual([]);
  });
}

for (const menu of ['Settings', '+ Add repo']) {
  test(`${menu} reports and retries account-status errors`, async ({ page }) => {
    let fail = false;
    const state = await mock(page, async (route, url) => {
      if (url.pathname !== '/api/me' || !fail) return false;
      await json(route, { error: 'Synthetic outage' }, 503);
      return true;
    });
    await page.goto('/about');
    await expect(page.getByRole('heading', { name: 'About atlas' })).toBeVisible();
    fail = true;
    await openMenuPage(page, menu);
    await expect(page.getByRole('alert')).toContainText(/GitHub access/i, { timeout: 3000 });
    fail = false;
    await page.getByRole('button', { name: 'Retry GitHub access', exact: true }).click();
    if (menu === 'Settings') await expect(page.getByRole('button', { name: 'Forget token' })).toBeVisible();
    else await expect(page.getByRole('checkbox')).toBeVisible();
    expect(state.errors).toEqual([]);
  });
}

test('browse failures are not empty results and retry restores the picker', async ({ page }) => {
  let fail = true;
  await mock(page, async (route, url) => {
    if (url.pathname !== '/api/github/repos' || !fail) return false;
    await json(route, { error: 'Synthetic revoked-token explanation' }, 502);
    return true;
  });
  await page.goto('/repos/new');
  await expect(page.getByRole('alert')).toContainText('Synthetic revoked-token explanation', { timeout: 3000 });
  await expect(page.getByText(/No repos found/)).toHaveCount(0);
  fail = false;
  await page.getByRole('button', { name: 'Retry repository list', exact: true }).click();
  await expect(page.getByRole('checkbox')).toBeVisible();
});

test('missing token response offers connection instead of claiming an empty collection', async ({ page }) => {
  await mock(page, async (route, url) => {
    if (url.pathname !== '/api/github/repos') return false;
    await json(route, { error: 'No GitHub token on file' }, 412);
    return true;
  });
  await page.goto('/repos/new');
  await expect(page.getByRole('link', { name: 'Connect GitHub →', exact: true })).toBeVisible({ timeout: 3000 });
  await expect(page.getByText(/No repos found/)).toHaveCount(0);
});

test('late Admin responses cannot replace the selected repository shares', async ({ page }) => {
  const requested = latch();
  const release = latch();
  const finished = latch();
  await mock(page, async (route, url) => {
    if (url.pathname !== '/api/shares') return false;
    if (url.searchParams.get('repoId') === repos[0].repoId) {
      requested.resolve();
      await release.promise;
      await json(route, { shares: [share(repos[0].repoId, 'alpha-member')] });
      finished.resolve();
    } else await json(route, { shares: [share(repos[1].repoId, 'beta-member')] });
    return true;
  });
  await page.goto('/admin');
  await requested.promise;
  await page.getByRole('combobox', { name: 'Switch repo' }).selectOption(repos[1].repoId);
  await expect(page.getByRole('link', { name: 'beta-member', exact: true })).toBeVisible();
  const response = page.waitForResponse(url =>
    new URL(url.url()).pathname === '/api/shares' && new URL(url.url()).searchParams.get('repoId') === repos[0].repoId);
  release.resolve();
  await finished.promise;
  await (await response).finished();
  await flushRender(page);
  await expect(page.getByRole('heading', { name: 'Admin · Beta' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'alpha-member', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'beta-member', exact: true })).toBeVisible();
});

test('pending Admin invitation cannot clear a different repository draft or replace its shares', async ({ page }) => {
  const entered = latch();
  const release = latch();
  const finished = latch();
  await mock(page, async (route, url) => {
    if (url.pathname === '/api/shares/invite') {
      entered.resolve();
      await release.promise;
      await json(route, { share: share(repos[0].repoId, 'alpha-invite') });
      finished.resolve();
      return true;
    }
    return false;
  });
  await page.goto('/admin');
  await page.getByLabel('GitHub username', { exact: true }).fill('alpha-invite');
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  await entered.promise;
  await page.getByRole('combobox', { name: 'Switch repo' }).selectOption(repos[1].repoId);
  await expect(page.getByLabel('GitHub username', { exact: true })).toBeEnabled({ timeout: 3000 });
  await page.getByLabel('GitHub username', { exact: true }).fill('beta-draft');
  const response = page.waitForResponse(url => new URL(url.url()).pathname === '/api/shares/invite');
  release.resolve();
  await finished.promise;
  await (await response).finished();
  await flushRender(page);
  await expect(page.getByLabel('GitHub username', { exact: true })).toHaveValue('beta-draft');
});

for (const mode of ['browse', 'url']) {
  test(`${mode} addition retries only account refresh after a committed add`, async ({ page }) => {
    let added = false;
    let failRefresh = true;
    let posts = 0;
    const state = await mock(page, async (route, url) => {
      if (url.pathname === '/api/repos') {
        posts++;
        added = true;
        await json(route, { repo: newRepo, starterLesson: null }, 201);
        return true;
      }
      if (url.pathname === '/api/me' && added) {
        await json(route, failRefresh ? { error: 'Refresh outage' } : { ...me, allowedRepos: [...repos, newRepo] }, failRefresh ? 503 : 200);
        return true;
      }
      return false;
    });
    await page.goto('/repos/new');
    await expect(page.getByRole('checkbox')).toBeVisible();
    if (mode === 'browse') {
      await page.getByRole('checkbox').check();
      await page.getByRole('button', { name: 'Add 1 repo', exact: true }).click();
    } else {
      await page.getByText('Paste URL', { exact: true }).click();
      await page.getByRole('textbox', { name: /^GitHub repo URL/ }).fill(browseRepo.htmlUrl);
      await page.getByRole('button', { name: 'Add repo', exact: true }).click();
    }
    await expect(page.getByRole('alert')).toContainText(/added.*refresh/i, { timeout: 3000 });
    failRefresh = false;
    await page.getByRole('button', { name: 'Retry account refresh', exact: true }).click();
    await expect(page).toHaveURL(`${baseURL}/`);
    await expect(page.getByRole('combobox', { name: 'Switch repo' })).toHaveValue(newRepo.repoId);
    expect(posts).toBe(1);
    expect(state.errors).toEqual([]);
  });
}

test('accepted account refresh reconciles repository label, role and request context', async ({ page }) => {
  let changed = false;
  const state = await mock(page, async (route, url) => {
    if (url.pathname === '/api/me/github-token') {
      changed = true;
      await route.fulfill({ status: 204 });
      return true;
    }
    if (url.pathname === '/api/me' && changed) {
      await json(route, { ...me, allowedRepos: [repos[1]], githubToken: null });
      return true;
    }
    return false;
  });
  await page.goto('/settings');
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Forget token', exact: true }).click();
  await expect(page.locator('.brand-repo')).toHaveText('Beta');
  await openMenuPage(page, 'Admin');
  await expect(page.getByRole('heading', { name: 'Admin · Beta' })).toBeVisible();
  await expect.poll(() => state.requests.filter(url => url.pathname === '/api/shares')
    .at(-1)?.searchParams.get('repoId')).toBe(repos[1].repoId);
});

test('repository modes use ordinary keyboard-operable pressed buttons', async ({ page }) => {
  await mock(page);
  await page.goto('/repos/new');
  const methods = page.getByRole('group', { name: 'Add repository method' });
  const browse = methods.getByRole('button', { name: 'Browse my repos', exact: true });
  await expect(browse).toHaveAttribute('aria-pressed', 'true', { timeout: 3000 });
  await browse.focus();
  await page.keyboard.press('Tab');
  const url = methods.getByRole('button', { name: 'Paste URL', exact: true });
  await expect(url).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(url).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('textbox', { name: /^GitHub repo URL/ })).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(0);
});

test('About explains queued content, owner generation and opt-in scheduling', async ({ page }) => {
  await mock(page);
  await page.goto('/about');
  await expect(page.getByRole('main')).toContainText(/queues.*starter lesson/i, { timeout: 3000 });
  await expect(page.getByRole('main')).toContainText(/owner.*generate/i);
  await expect(page.getByRole('main')).not.toContainText('within seconds');
  await expect(page.getByRole('main')).toContainText(/opt in.*Admin/i);
});

test('About distinguishes cached fallback from authenticated offline startup', async ({ page }) => {
  await mock(page);
  await page.goto('/about');
  await expect(page.getByRole('main')).toContainText(/cached-lesson fallback during network failures/i, { timeout: 3000 });
  await expect(page.getByRole('main')).toContainText(/starting the app or signing in still needs a network connection/i);
});

test('member Admin navigation redirects without requesting shares', async ({ page }) => {
  const state = await mock(page, async (route, url) => {
    if (url.pathname !== '/api/me') return false;
    await json(route, { ...me, allowedRepos: repos.map(repo => ({ ...repo, role: 'member' })) });
    return true;
  });
  await page.goto('/admin');
  await expect(page).toHaveURL(`${baseURL}/`);
  await page.getByRole('button', { name: /^reader/ }).click();
  await expect(page.getByRole('menuitem', { name: 'Admin', exact: true })).toHaveCount(0);
  expect(state.requests.filter(url => url.pathname === '/api/shares')).toEqual([]);
});

test('Admin collaborator loading retries without issuing mutations', async ({ page }) => {
  let fail = true;
  let mutations = 0;
  await mock(page, async (route, url) => {
    if (route.request().method() !== 'GET') mutations++;
    if (url.pathname !== '/api/shares') return false;
    await json(route, fail ? { error: 'Outage' } : { shares: [] }, fail ? 503 : 200);
    return true;
  });
  await page.goto('/admin');
  await expect(page.getByRole('alert')).toContainText('Failed to load collaborators');
  fail = false;
  await page.getByRole('button', { name: 'Retry collaborators', exact: true }).click();
  await expect(page.getByText('No collaborators yet — only you have access.')).toBeVisible();
  expect(mutations).toBe(0);
});

test('a pending settings save cannot report success on a different repository', async ({ page }) => {
  const entered = latch();
  const release = latch();
  const finished = latch();
  let saved = false;
  await mock(page, async (route, url) => {
    if (url.pathname === '/api/me' && saved) {
      await json(route, { ...me, allowedRepos: [repos[0], { ...repos[1], name: 'Beta refreshed' }] });
      return true;
    }
    if (url.pathname !== '/api/repos/settings') return false;
    expect(url.searchParams.get('repoId')).toBe(repos[0].repoId);
    entered.resolve();
    await release.promise;
    saved = true;
    await json(route, { repo: { ...repos[0], autoGenerate: true } });
    finished.resolve();
    return true;
  });
  await page.goto('/admin');
  await page.getByRole('checkbox', { name: 'Enable autonomous generation' }).check();
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await entered.promise;
  await page.getByRole('combobox', { name: 'Switch repo' }).selectOption(repos[1].repoId);
  release.resolve();
  await finished.promise;
  await expect(page.getByRole('heading', { name: 'Admin · Beta refreshed' })).toBeVisible();
  await expect(page.getByText('Saved.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Enable autonomous generation' })).not.toBeChecked();
});

test('partial batch additions keep successes disabled and retry only failed repositories', async ({ page }) => {
  const other = { ...browseRepo, fullName: 'reader/second', repo: 'second', htmlUrl: 'https://github.com/reader/second' };
  const posts: string[] = [];
  let fail = true;
  let added = false;
  await mock(page, async (route, url) => {
    if (url.pathname === '/api/github/repos') {
      await json(route, { repos: [browseRepo, other] });
      return true;
    }
    if (url.pathname === '/api/repos') {
      const body = route.request().postDataJSON() as { githubUrl: string };
      posts.push(body.githubUrl);
      const second = body.githubUrl === other.htmlUrl;
      const success = !second || !fail;
      added ||= success;
      await json(route, success ? { repo: newRepo, starterLesson: null } : { error: 'Synthetic add failure' }, success ? 201 : 502);
      return true;
    }
    if (url.pathname === '/api/me' && added) {
      await json(route, { ...me, allowedRepos: [...repos, newRepo] });
      return true;
    }
    return false;
  });
  await page.goto('/repos/new');
  await page.getByRole('checkbox').nth(0).check();
  await page.getByRole('checkbox').nth(1).check();
  await page.getByRole('button', { name: 'Add 2 repos', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('1 added.');
  await expect(page.getByRole('checkbox').nth(0)).toBeDisabled();
  await expect(page.getByRole('checkbox').nth(1)).toBeChecked();
  fail = false;
  await page.getByRole('button', { name: 'Add 1 repo', exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/`);
  expect(posts).toEqual([browseRepo.htmlUrl, other.htmlUrl, other.htmlUrl]);
});

test('empty account context stays in onboarding and can open repository setup', async ({ page }) => {
  await mock(page, async (route, url) => {
    if (url.pathname !== '/api/me') return false;
    await json(route, { ...me, allowedRepos: [], githubToken: null });
    return true;
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to atlas' })).toBeVisible();
  await page.getByRole('link', { name: '+ Add a public repo', exact: true }).click();
  await expect(page.getByRole('textbox', { name: /^GitHub repo URL/ })).toBeVisible();
});

for (const scenario of [
  { requests: 2, latestStatus: 200 },
  { requests: 3, latestStatus: 200 },
  { requests: 2, latestStatus: 503 },
  { requests: 2, latestStatus: 401 },
]) {
  test(`account refresh coalesces ${scenario.requests} requests from generation and addition, latest ${scenario.latestStatus}`, async ({ page }) => {
    const jobs = Array.from({ length: scenario.requests - 1 }, (_, index) => ({
      entered: latch(), release: latch(),
      lesson: {
        id: `queued-${index}`, repoId: repos[0].repoId, ownerId: 'reader', title: `Synthetic queued lesson ${index}`,
        topic: `synthetic-${index}`, depth: 'intro', read_minutes: 4, body: '', citations: [], suggested_next: [],
        status: 'queued', language: 'en', created_at: '2026-01-01',
      } satisfies Lesson,
    }));
    const account = Array.from({ length: scenario.requests }, () => ({ entered: latch(), release: latch(), finished: latch() }));
    const authoritative: AtlasMe = {
      ...me, allowedRepos: [...repos, newRepo],
      quota: { used: scenario.requests, limit: 5, remaining: 5 - scenario.requests, resetAt: '2099-01-01' },
    };
    let added = false;
    let posts = 0;
    let refreshes = 0;
    const state = await mock(page, async (route, url) => {
      if (url.pathname === '/api/lessons' && url.searchParams.get('status') === 'queued') {
        await json(route, { lessons: added ? [] : jobs.map(job => job.lesson) });
        return true;
      }
      if (url.pathname === '/api/lessons/generate') {
        const body = route.request().postDataJSON() as { topic: string };
        const job = jobs.find(candidate => candidate.lesson.topic === body.topic);
        if (!job) throw new Error('Unexpected synthetic generation');
        job.entered.resolve();
        await job.release.promise;
        await json(route, { ...job.lesson, status: 'published', body: 'Synthetic generated lesson.' });
        return true;
      }
      if (url.pathname === '/api/repos') {
        posts++;
        added = true;
        await json(route, { repo: newRepo, starterLesson: null }, 201);
        return true;
      }
      if (url.pathname === '/api/me' && added) {
        const index = refreshes++;
        const hold = account[index];
        if (!hold) {
          await json(route, authoritative);
          return true;
        }
        hold.entered.resolve();
        await hold.release.promise;
        const latest = index === account.length - 1;
        if (latest) {
          await json(route, scenario.latestStatus === 200 ? authoritative : { error: 'Synthetic authoritative failure' }, scenario.latestStatus);
        } else {
          await json(route, me, index === 1 ? 502 : 200);
        }
        hold.finished.resolve();
        return true;
      }
      return false;
    });
    try {
      await page.goto('/');
      for (const job of jobs) {
        await page.locator('.learn-queued-row').filter({ has: page.getByRole('heading', { name: job.lesson.title, exact: true }) })
          .getByRole('button', { name: 'Generate lesson', exact: true }).click();
        await job.entered.promise;
      }
      await openMenuPage(page, '+ Add repo');
      await page.getByRole('checkbox').check();
      await page.getByRole('button', { name: 'Add 1 repo', exact: true }).click();
      await account[0].entered.promise;
      for (const [index, job] of jobs.entries()) {
        job.release.resolve();
        await account[index + 1].entered.promise;
      }
      account.at(-1)!.release.resolve();
      await account.at(-1)!.finished.promise;
      if (scenario.latestStatus === 200) {
        // A stalled superseded request must not hold the successful caller hostage.
        await expect(page).toHaveURL(`${baseURL}/`, { timeout: 3000 });
      } else {
        await expect(page.getByRole('alert')).toContainText(
          scenario.latestStatus === 401 ? 'updated repository list is not available' : 'fetchMe failed: 503',
          { timeout: 3000 },
        );
        await page.getByRole('button', { name: 'Retry account refresh', exact: true }).click();
        await expect(page).toHaveURL(`${baseURL}/`);
      }
      await expect(page.getByRole('combobox', { name: 'Switch repo' })).toHaveValue(newRepo.repoId);
      await expect(page.locator('.quota-badge')).toHaveText(`${scenario.requests}/5`);
      const staleResponses = page.waitForResponse(response =>
        new URL(response.url()).pathname === '/api/me' && response.status() === 200);
      account[0].release.resolve();
      await (await staleResponses).finished();
      for (const hold of account.slice(1, -1)) hold.release.resolve();
      await Promise.all(account.map(hold => hold.finished.promise));
      await flushRender(page);
      await expect(page.getByRole('combobox', { name: 'Switch repo' })).toHaveValue(newRepo.repoId);
      await expect(page.locator('.quota-badge')).toHaveText(`${scenario.requests}/5`);
      expect(refreshes).toBe(scenario.requests + (scenario.latestStatus === 200 ? 0 : 1));
      expect(posts).toBe(1);
      expect(state.errors).toEqual([]);
    } finally {
      jobs.forEach(job => job.release.resolve());
      account.forEach(hold => hold.release.resolve());
    }
  });
}

for (const mode of ['url', 'browse']) {
  for (const firstRepo of [true, false]) {
    test(`committed ${mode} addition after navigation refreshes ${firstRepo ? 'first-repo onboarding' : 'the preserved current repo'}`, async ({ page }) => {
      const entered = latch();
      const release = latch();
      const initialRepos = firstRepo ? [] : repos;
      const posts: string[] = [];
      let committed = false;
      let refreshes = 0;
      const state = await mock(page, async (route, url) => {
        if (url.pathname === '/api/me') {
          if (committed) refreshes++;
          await json(route, { ...me, allowedRepos: committed ? [...initialRepos, newRepo] : initialRepos });
          return true;
        }
        if (url.pathname === '/api/github/repos') {
          await json(route, { repos: [browseRepo, { ...browseRepo, repo: 'second', fullName: 'reader/second', htmlUrl: 'https://github.com/reader/second' }] });
          return true;
        }
        if (url.pathname === '/api/repos') {
          posts.push((route.request().postDataJSON() as { githubUrl: string }).githubUrl);
          entered.resolve();
          await release.promise;
          committed = true;
          await json(route, { repo: newRepo, starterLesson: null }, 201);
          return true;
        }
        return false;
      });
      try {
        await page.goto('/repos/new');
        await expect(page.getByRole('checkbox')).toHaveCount(2);
        if (mode === 'url') {
          await page.getByRole('button', { name: 'Paste URL', exact: true }).click();
          await page.getByRole('textbox', { name: /^GitHub repo URL/ }).fill(browseRepo.htmlUrl);
          await page.getByRole('button', { name: 'Add repo', exact: true }).click();
        } else {
          await page.getByRole('checkbox').nth(0).check();
          await page.getByRole('checkbox').nth(1).check();
          await page.getByRole('button', { name: 'Add 2 repos', exact: true }).click();
        }
        await entered.promise;
        await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Learn', exact: true }).click();
        if (firstRepo) {
          await expect(page.getByRole('heading', { name: 'Welcome to atlas' })).toBeVisible();
        } else {
          await page.getByRole('combobox', { name: 'Switch repo' }).selectOption(repos[1].repoId);
        }
        release.resolve();
        await expect.poll(() => refreshes, { timeout: 3000 }).toBe(1);
        if (firstRepo) {
          await expect(page.locator('.brand-repo')).toHaveText(newRepo.name);
          await expect(page.getByRole('heading', { name: 'Welcome to atlas' })).toHaveCount(0);
        } else {
          await expect(page.getByRole('combobox', { name: 'Switch repo' })).toHaveValue(repos[1].repoId);
          await expect(page.getByRole('combobox', { name: 'Switch repo' }).locator('option', { hasText: newRepo.name })).toHaveCount(1);
        }
        await expect(page).toHaveURL(`${baseURL}/`);
        await flushRender(page);
        expect(posts).toEqual([browseRepo.htmlUrl]);
        expect(state.errors).toEqual([]);
      } finally {
        release.resolve();
      }
    });
  }
}

test('departed batch refreshes an earlier committed success when the pending addition fails', async ({ page }) => {
  const entered = latch();
  const release = latch();
  const posts: string[] = [];
  let committed = false;
  let refreshes = 0;
  await mock(page, async (route, url) => {
    if (url.pathname === '/api/me') {
      if (committed) refreshes++;
      await json(route, { ...me, allowedRepos: committed ? [...repos, newRepo] : repos });
      return true;
    }
    if (url.pathname === '/api/github/repos') {
      await json(route, { repos: [browseRepo, ...['second', 'third'].map(repo => ({
        ...browseRepo, repo, fullName: `reader/${repo}`, htmlUrl: `https://github.com/reader/${repo}`,
      }))] });
      return true;
    }
    if (url.pathname === '/api/repos') {
      posts.push((route.request().postDataJSON() as { githubUrl: string }).githubUrl);
      if (posts.length === 1) {
        committed = true;
        await json(route, { repo: newRepo, starterLesson: null }, 201);
      } else {
        entered.resolve();
        await release.promise;
        await json(route, { error: 'Synthetic failed addition' }, 502);
      }
      return true;
    }
    return false;
  });
  try {
    await page.goto('/repos/new');
    await expect(page.getByRole('checkbox')).toHaveCount(3);
    for (const checkbox of await page.getByRole('checkbox').all()) await checkbox.check();
    await page.getByRole('button', { name: 'Add 3 repos', exact: true }).click();
    await entered.promise;
    await openMenuPage(page, 'About');
    release.resolve();
    await expect.poll(() => refreshes, { timeout: 3000 }).toBe(1);
    await expect(page.getByRole('combobox', { name: 'Switch repo' }).locator('option', { hasText: newRepo.name })).toHaveCount(1);
    await expect(page).toHaveURL(`${baseURL}/about`);
    await expect(page.getByRole('combobox', { name: 'Switch repo' })).toHaveValue(repos[0].repoId);
    await flushRender(page);
    expect(posts).toEqual([browseRepo.htmlUrl, 'https://github.com/reader/second']);
  } finally {
    release.resolve();
  }
});
