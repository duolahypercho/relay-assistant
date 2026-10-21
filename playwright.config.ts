import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
const testPort = Number(process.env.RELAY_TEST_BASE_PORT || 5180);
if (!Number.isInteger(testPort) || testPort < 1024 || testPort > 65534)
  throw new Error('Choose a test base port between 1024 and 65534.');
const previewUrl = `http://127.0.0.1:${testPort}`;
const serverUrl = `http://127.0.0.1:${testPort + 1}`;
export default defineConfig({
  testDir: 'tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  expect: { timeout: 8000 },
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  use: {
    baseURL: previewUrl,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    // Full Chromium supports the synthetic microphone; the minimal Linux headless shell does not.
    channel:
      process.env.RELAY_TEST_BROWSER_CHANNEL ||
      (process.platform === 'darwin' && existsSync('/Applications/Google Chrome.app')
        ? 'chrome'
        : 'chromium'),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      testMatch: ['workspace.spec.ts', 'questions.spec.ts'],
      use: { viewport: { width: 1440, height: 950 } },
    },
    {
      name: 'mobile',
      testMatch: ['workspace.spec.ts', 'questions.spec.ts'],
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
    {
      name: 'server',
      testMatch: 'server.spec.ts',
      use: { baseURL: serverUrl, viewport: { width: 1280, height: 900 } },
    },
    ...[false, true].map((mobile) => ({
      name: mobile ? 'decisions-mobile' : 'decisions-desktop',
      testMatch: 'questions.spec.ts',
      use: {
        baseURL: serverUrl,
        viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
        isMobile: mobile,
        hasTouch: mobile,
      },
    })),
    ...[false, true].map((mobile) => ({
      name: mobile ? 'voice-mobile' : 'voice-desktop',
      testMatch: ['voice.spec.ts', 'memo.spec.ts'],
      use: {
        baseURL: serverUrl,
        viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
        isMobile: mobile,
        hasTouch: mobile,
        permissions: ['microphone'],
        launchOptions: { args: ['--use-fake-device-for-media-stream'] },
      },
    })),
  ],
  webServer: [
    {
      command: `node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port ${testPort} --strictPort`,
      url: previewUrl,
      reuseExistingServer: false,
      timeout: 20000,
    },
    {
      command: 'node scripts/test-server.mjs',
      env: { RELAY_TEST_SERVER_PORT: String(testPort + 1) },
      url: `${serverUrl}/api/health`,
      reuseExistingServer: false,
      timeout: 20000,
    },
  ],
});
