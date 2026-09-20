import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:3001',
    browserName: 'chromium',
    channel: 'chrome',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm start',
    url: 'http://127.0.0.1:3001',
    reuseExistingServer: false,
    timeout: 30000,
    env: {
      PORT: '3001',
      BRANDO_APPLICATION: 'browser-tests',
      BRANDO_SCHEMA: process.env.BRANDO_SCHEMA ?? 'brando_browser_tests',
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? 'postgres://brando:brando@127.0.0.1:55432/brando',
    },
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
  },
});
