import { test as base, expect, type Page } from '@playwright/test';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';

interface WorkerServer {
  origin: string;
  saved: boolean;
  status: number;
  disconnected: boolean;
}

const test = base.extend<{ workerServer: WorkerServer }>({
  workerServer: async ({}, use) => {
    const dist = resolve('dist');
    // Fail clearly when this post-build suite is accidentally run before build.
    await readFile(resolve(dist, 'sw.js'));
    const state: WorkerServer = { origin: '', saved: false, status: 200, disconnected: false };
    const server = createServer(async (req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (pathname.startsWith('/api/') || pathname.startsWith('/.auth/')) {
        if (state.disconnected) {
          req.socket.destroy();
          return;
        }
        res.writeHead(state.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(state.status === 200 ? { saved: state.saved } : { error: 'Synthetic failure' }));
        return;
      }
      if (pathname === '/worker-probe') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><html lang="en"><title>Local worker probe</title><body>Worker probe</body></html>');
        return;
      }
      const file = resolve(dist, pathname === '/' ? 'index.html' : pathname.slice(1).split('/').join(sep));
      if (!file.startsWith(dist + sep)) {
        res.writeHead(404).end();
        return;
      }
      try {
        const content = await readFile(file);
        const types: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
        res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(content);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
          console.error('Worker fixture failed to serve a built asset', error);
        }
        res.writeHead(404).end();
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Worker fixture did not bind a TCP port');
    state.origin = `http://127.0.0.1:${address.port}`;
    try {
      await use(state);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  },
});

async function activateWorker(page: Page, origin: string) {
  await page.goto(`${origin}/worker-probe`);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
    }
  });
}

async function readApi(page: Page, path: string) {
  return page.evaluate(async url => {
    const response = await fetch(url);
    return { status: response.status, body: await response.json() };
  }, path);
}

async function waitForCachedSnapshot(page: Page, path: string, saved: boolean) {
  await page.waitForFunction(async ({ url, expected }) => {
    const response = await caches.match(url);
    return response && (await response.json()).saved === expected;
  }, { url: path, expected: saved });
}

for (const path of [
  '/api/lessons?repoId=synthetic',
  '/api/lessons/example?repoId=synthetic',
  '/api/recommendations?repoId=synthetic',
  '/api/lessons/recommended?repoId=synthetic',
]) {
  test(`refreshes online progress and preserves offline reading for ${path}`, async ({ page, workerServer }) => {
    await activateWorker(page, workerServer.origin);
    expect(await readApi(page, path)).toEqual({ status: 200, body: { saved: false } });
    await waitForCachedSnapshot(page, path, false);

    workerServer.saved = true;
    expect(await readApi(page, path)).toEqual({ status: 200, body: { saved: true } });
    await waitForCachedSnapshot(page, path, true);

    workerServer.disconnected = true;
    expect(await readApi(page, path)).toEqual({ status: 200, body: { saved: true } });
  });
}

test('does not replace explicit HTTP errors with cached success', async ({ page, workerServer }) => {
  const path = '/api/lessons?repoId=synthetic';
  await activateWorker(page, workerServer.origin);
  await readApi(page, path);
  await waitForCachedSnapshot(page, path, false);

  for (const status of [401, 403, 404, 500]) {
    workerServer.status = status;
    expect(await readApi(page, path)).toEqual({ status, body: { error: 'Synthetic failure' } });
  }
});

test('never caches auth or account responses or replaces their navigations with the app shell', async ({ page, workerServer }) => {
  await activateWorker(page, workerServer.origin);
  for (const path of ['/.auth/me', '/api/me']) {
    expect((await readApi(page, path)).status).toBe(200);
    expect(await page.evaluate(async url => !!await caches.match(url), path)).toBe(false);
    workerServer.status = 401;
    expect((await readApi(page, path)).status).toBe(401);
    workerServer.status = 200;
  }
  for (const path of ['/.auth/login/github', '/api/unknown']) {
    workerServer.status = 404;
    const response = await page.goto(`${workerServer.origin}${path}`);
    expect(response?.status()).toBe(404);
    await expect(page.locator('body')).toContainText('Synthetic failure');
  }
});
