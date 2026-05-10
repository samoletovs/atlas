/**
 * E2E smoke tests for atlas — runs against the production deployment.
 *
 * Coverage:
 *   - Home loads, sign-in screen renders
 *   - Click "Sign in with GitHub" actually redirects to GitHub OAuth
 *   - .auth/me endpoint responds with JSON
 *   - /api/lessons returns 302 redirect to login when unauthenticated
 *
 * Auth-gated paths can't be exercised end-to-end without credentials,
 * so we test that they redirect correctly. Logged-in flows are covered
 * by the local-dev test (NODE_ENV !== 'production' bypasses isAuthorized).
 */
import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.ATLAS_BASE_URL ?? 'https://atlas.naurolabs.com';

async function getLoginRedirectChain(page: Page) {
  const chain: string[] = [];
  let nextUrl = `${BASE}/.auth/login/github?post_login_redirect_uri=/`;

  for (let hop = 0; hop < 5; hop += 1) {
    const resp = await page.request.get(nextUrl, { maxRedirects: 0 });
    chain.push(`${resp.status()} ${nextUrl}`);

    const location = resp.headers().location;
    if (!location) break;

    nextUrl = new URL(location, nextUrl).toString();
    chain.push(nextUrl);

    if (nextUrl.includes('github.com/login')) {
      break;
    }
  }

  return chain;
}

test.describe('atlas smoke', () => {
  test.beforeEach(async ({ page }) => {
    // Disable any stale service worker before each test to avoid surprises.
    await page.goto(BASE);
    await page.evaluate(async () => {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const r of regs) await r.unregister();
      }
      if ('caches' in window) {
        const keys = await caches.keys();
        for (const k of keys) await caches.delete(k);
      }
    });
  });

  test('home renders sign-in screen', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.getByRole('heading', { name: 'atlas' })).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByRole('link', { name: /sign in with github/i })).toBeVisible();
  });

  test('clicking sign-in redirects to GitHub login (regression: SW must not intercept /.auth/*)', async ({
    page,
  }) => {
    await page.goto(BASE);
    await page.waitForSelector('a[href*=".auth/login/github"]', { timeout: 15000 });

    // Click and wait for the cross-origin GitHub login URL.
    await Promise.all([
      page.waitForURL(/github\.com\/login/, { timeout: 30000 }),
      page.click('a[href*=".auth/login/github"]'),
    ]);

    expect(page.url()).toMatch(/github\.com\/login/);
  });

  test('/.auth/login/github ultimately redirects to GitHub login', async ({
    page,
  }) => {
    const chain = await getLoginRedirectChain(page);
    expect(chain.join('\n')).toContain('github.com/login');
  });

  test('/.auth/me responds with JSON (anonymous = clientPrincipal: null)', async ({ page }) => {
    const resp = await page.request.get(`${BASE}/.auth/me`);
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body).toHaveProperty('clientPrincipal');
  });

  test('/.auth/login/github returns 302 to identity service', async ({
    page,
  }) => {
    const resp = await page.request.get(`${BASE}/.auth/login/github`, { maxRedirects: 0 });
    // SWA returns 302 Found — body should NOT be HTML
    expect([301, 302, 303, 307]).toContain(resp.status());
    const location = resp.headers()['location'];
    expect(location).toMatch(/identity\.\d+\.azurestaticapps\.net|github\.com/);
  });

  test('/.auth/login/aad returns 404 (regression: AAD provider explicitly disabled)', async ({
    page,
  }) => {
    // After the AAD → GitHub swap, /.auth/login/aad should be blocked
    // by a responseOverride so users can't accidentally hit the old route.
    const resp = await page.request.get(`${BASE}/.auth/login/aad`, { maxRedirects: 0 });
    expect(resp.status()).toBe(404);
  });

  test('/.auth/login/done does NOT return 404 (regression: post-login redirect must work)', async ({
    page,
  }) => {
    // After login completes, SWA redirects users back to /.auth/login/done.
    // It should redirect (302) or render successfully (200) — never 404.
    const resp = await page.request.get(`${BASE}/.auth/login/done`, { maxRedirects: 0 });
    expect(resp.status()).not.toBe(404);
    expect([200, 301, 302, 303, 307, 401]).toContain(resp.status());
  });

  test('/api/lessons (unauth) redirects to login, does not return 200 HTML', async ({ page }) => {
    const resp = await page.request.get(`${BASE}/api/lessons`, { maxRedirects: 0 });
    expect([301, 302, 401]).toContain(resp.status());
  });

  test('/api/lessons/queue (unauth) redirects to login, does not return 200', async ({ page }) => {
    // POST should be auth-gated identically to the other endpoints.
    const resp = await page.request.post(`${BASE}/api/lessons/queue`, {
      maxRedirects: 0,
      headers: { 'Content-Type': 'application/json' },
      data: { title: 'test', topic: 'test', language: 'en' },
    });
    expect([301, 302, 401]).toContain(resp.status());
  });

  test('/api/lessons/generate (unauth) redirects to login, does not return 200', async ({ page }) => {
    const resp = await page.request.post(`${BASE}/api/lessons/generate`, {
      maxRedirects: 0,
      headers: { 'Content-Type': 'application/json' },
      data: { title: 'test', topic: 'test', language: 'en' },
    });
    expect([301, 302, 401]).toContain(resp.status());
  });

  test('/api/repos (unauth POST) redirects to login, does not return 200', async ({ page }) => {
    const resp = await page.request.post(`${BASE}/api/repos`, {
      maxRedirects: 0,
      headers: { 'Content-Type': 'application/json' },
      data: { githubUrl: 'https://github.com/octocat/hello-world' },
    });
    expect([301, 302, 401]).toContain(resp.status());
  });

  test('manifest.webmanifest is served with correct content-type', async ({ page }) => {
    const resp = await page.request.get(`${BASE}/manifest.webmanifest`);
    expect(resp.status()).toBe(200);
    expect(resp.headers()['content-type']).toMatch(/manifest|json/);
  });
});

