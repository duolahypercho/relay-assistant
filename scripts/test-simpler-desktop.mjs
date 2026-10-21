// SPDX-License-Identifier: MIT
import { _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const directory = await mkdtemp(join(tmpdir(), 'relay-simpler-mac-'));
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
let app;
try {
  app = await electron.launch({
    executablePath: resolve('release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay'),
    args: [`--relay-test-data=${directory}`, '--relay-local-port=0'],
    env: {
      ...process.env,
      RELAY_DESKTOP_ENV: '',
      RELAY_MODE: 'sample',
      RELAY_ACCESS_KEY: '',
      RELAY_MODEL_BASE_URL: '',
      RELAY_MODEL_ID: '',
      RELAY_MODEL_API_KEY: '',
      RELAY_TRANSCRIPTION_BASE_URL: '',
      RELAY_TRANSCRIPTION_MODEL: '',
      RELAY_TRANSCRIPTION_API_KEY: '',
      RELAY_SPEECH_BASE_URL: '',
      RELAY_SPEECH_MODEL: '',
      RELAY_SPEECH_API_KEY: '',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      RELAY_DESKTOP_ENABLED: 'false',
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const snapshot = () => page.evaluate(async () => (await fetch('/api/state')).json());
  const composer = page.getByLabel('Message Relay', { exact: true });
  await composer.fill('Keep this native desktop thought');
  const before = await snapshot();
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const query = page.getByLabel('Search your workspace', { exact: true });
  await expect(query).toBeFocused();
  await query.fill('dark mode');
  await page.screenshot({ path: join(evidence, 'simpler-search-native-mac.png') });
  await query.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Appearance & personality', exact: true }),
  ).toBeFocused();
  await page.getByLabel('Your name', { exact: true }).fill('Unfinished Mac edit');
  await page.getByRole('button', { name: 'All settings', exact: true }).click();
  await page.screenshot({ path: join(evidence, 'simpler-settings-native-mac.png') });
  await expect(
    page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button'),
  ).toHaveCount(9);
  await expect(page.getByLabel('Your name', { exact: true })).toBeHidden();
  for (const name of [
    'Voice',
    'Memory',
    'AI models',
    'Usage',
    'Connected apps',
    'Archived chats',
    'Data & devices',
    'Notifications',
  ]) {
    await page
      .getByRole('navigation', { name: 'Settings categories' })
      .getByRole('button', { name, exact: true })
      .click();
    expect((await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations, name).toEqual(
      [],
    );
    await page.getByRole('button', { name: 'All settings', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Appearance & personality', exact: true }).click();
  await expect(page.getByLabel('Your name', { exact: true })).toHaveValue('Unfinished Mac edit');
  expect((await snapshot()).profile.name).toBe(before.profile.name);
  await page.getByLabel('Appearance', { exact: true }).selectOption('dark');
  await page.getByRole('button', { name: 'Main chat', exact: true }).click();
  await expect(composer).toHaveValue('Keep this native desktop thought');
  expect((await snapshot()).messages).toEqual(before.messages);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await query.press('Escape');
  await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeFocused();
  await page.reload();
  await expect(composer).toHaveValue('Keep this native desktop thought');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await writeFile(
    join(evidence, 'simpler-native-mac-acceptance.json'),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        checks: [
          'Packaged Mac uses independent local workspace',
          'Search focus, navigation and keyboard dismissal',
          'Eight focused settings categories and accessibility',
          'Unfinished preferences retained without saving',
          'Theme persists; native draft and conversation preserved',
        ],
        limits:
          'Unsigned macOS arm64 app; live providers and other operating systems are outside this acceptance.',
      },
      null,
      2,
    ),
  );
  console.log('PASS: packaged Mac search, focused settings and retained drafts');
} finally {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
