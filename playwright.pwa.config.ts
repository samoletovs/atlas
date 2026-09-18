import { defineConfig } from '@playwright/test';
import { join } from 'node:path';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testMatch: 'serviceWorker.spec.ts',
  testIgnore: [],
  outputDir: join('test-results', 'pwa'),
  webServer: undefined,
  use: { ...base.use, serviceWorkers: 'allow' },
});
