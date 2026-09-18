import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testIgnore: '**/serviceWorker.spec.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: 2,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : [['list']],
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    ignoreHTTPSErrors: false,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: process.env.ATLAS_LOCAL_BASE_URL || process.env.ATLAS_SMOKE_ONLY === '1'
    ? undefined
    : {
        command: 'npm run dev -- --host 127.0.0.1 --port 43127 --strictPort',
        url: 'http://127.0.0.1:43127',
        reuseExistingServer: false,
        timeout: 60_000,
      },
});
