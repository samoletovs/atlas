/**
 * E2E smoke tests for atlas — runs against the production deployment.
 *
 * Coverage:
 *   - Home loads, sign-in screen renders
 *   - Click "Sign in with Google" actually redirects to a Google domain
 *     (catches the SW-eats-redirect bug we hit on 2026-05-09)
 *   - .auth/me endpoint responds with JSON
 *   - /api/lessons returns 302 redirect to login when unauthenticated
 *
 * Auth-gated paths can't be exercised end-to-end without credentials,
 * so we test that they redirect correctly. Logged-in flows are covered
 * by the local-dev test (NODE_ENV !== 'production' bypasses isAuthorized).
 */
import { test, expect } from '@playwright/test';

const BASE = process.env.ATLAS_BASE_URL ?? 'https://atlas.naurolabs.com';

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
    await expect(page.getByRole('link', { name: /sign in with google/i })).toBeVisible();
  });

  test('clicking sign-in redirects to Google (regression: SW must not intercept /.auth/*)', async ({
    page,
  }) => {
    await page.goto(BASE);
    await page.waitForSelector('a[href*=".auth/login/google"]', { timeout: 15000 });

    // Click and wait for the cross-origin Google login URL
    await Promise.all([
      page.waitForURL(/accounts\.google\.com|oauth2/, { timeout: 30000 }),
      page.click('a[href*=".auth/login/google"]'),
    ]);

    expect(page.url()).toMatch(/accounts\.google\.com|oauth2/);
  });

  test('/.auth/me responds with JSON (anonymous = clientPrincipal: null)', async ({ page }) => {
    const resp = await page.request.get(`${BASE}/.auth/me`);
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body).toHaveProperty('clientPrincipal');
  });

  test('/.auth/login/google returns 302 to identity service (not the React shell)', async ({
    page,
  }) => {
    const resp = await page.request.get(`${BASE}/.auth/login/google`, { maxRedirects: 0 });
    // SWA returns 302 Found — body should NOT be HTML
    expect([301, 302, 303, 307]).toContain(resp.status());
    const location = resp.headers()['location'];
    expect(location).toMatch(/identity\.\d+\.azurestaticapps\.net|accounts\.google\.com/);
  });

  test('/.auth/login/done does NOT return 404 (regression: post-login redirect must work)', async ({
    page,
  }) => {
    // After Google completes, SWA redirects users back to /.auth/login/done.
    // It should redirect (302) or render successfully (200) — never 404.
    const resp = await page.request.get(`${BASE}/.auth/login/done`, { maxRedirects: 0 });
    expect(resp.status()).not.toBe(404);
    expect([200, 301, 302, 303, 307, 401]).toContain(resp.status());
  });

  test('/api/lessons (unauth) redirects to login, does not return 200 HTML', async ({ page }) => {
    const resp = await page.request.get(`${BASE}/api/lessons`, { maxRedirects: 0 });
    expect([301, 302, 401]).toContain(resp.status());
  });

  test('manifest.webmanifest is served with correct content-type', async ({ page }) => {
    const resp = await page.request.get(`${BASE}/manifest.webmanifest`);
    expect(resp.status()).toBe(200);
    expect(resp.headers()['content-type']).toMatch(/manifest|json/);
  });
});
