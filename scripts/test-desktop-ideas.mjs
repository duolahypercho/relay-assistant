// SPDX-License-Identifier: MIT
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { ideasFixture } from './ideas-fixture.mjs';
const data = await mkdtemp(join(tmpdir(), 'relay-native-ideas-')),
  fixtureDir = await mkdtemp(join(tmpdir(), 'relay-native-ideas-provider-'));
const fixture = await ideasFixture(fixtureDir),
  evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const executable =
  process.env.RELAY_DESKTOP_EXECUTABLE ||
  resolve('release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay');
const env = {
  ...process.env,
  RELAY_MODE: 'live',
  RELAY_ACCESS_KEY: '',
  RELAY_MODEL_BASE_URL: fixture.provider.current.baseUrl,
  RELAY_MODEL_PROTOCOL: 'chat',
  RELAY_MODEL_ID: 'ideas-test',
  RELAY_MODEL_API_KEY: '',
  RELAY_BROWSER_ENABLED: 'false',
  RELAY_DESKTOP_ENABLED: 'false',
  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',
};
delete env.RELAY_DESKTOP_ENV;
const launch = () =>
  electron.launch({
    executablePath: executable,
    args: [`--relay-test-data=${data}`, '--relay-local-port=0'],
    env,
    timeout: 40000,
  });
let application;
const checks = [];
try {
  application = await launch();
  let page = await application.firstWindow();
  await expect(page.getByLabel('Message Relay', { exact: true })).toBeVisible({ timeout: 20000 });
  await page.evaluate(async () => {
    const res = await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'goal.create',
        payload: {
          title: 'Walk outdoors',
          description: 'Make time for a short walk.',
          target: 3,
          unit: 'walks',
        },
      }),
    });
    if (!res.ok) throw new Error(await res.text());
  });
  await page.getByLabel('Message Relay', { exact: true }).fill('My native draft');
  await page.getByRole('button', { name: 'Ideas', exact: true }).click();
  await page.getByRole('button', { name: 'Check for ideas', exact: true }).click();
  const idea = page.getByRole('article', { name: 'A little room for a walk' });
  await expect(idea).toBeVisible({ timeout: 20000 });
  expect(
    await page.evaluate(async () => (await (await fetch('/api/state')).json()).messages.length),
  ).toBe(0);
  await page.screenshot({ path: join(evidence, 'ideas-native-mac.png') });
  await idea.getByRole('button', { name: 'Make a little progress' }).click();
  await idea
    .getByRole('textbox', { name: 'What would you like Relay to do?' })
    .fill('Plan a short walk after lunch.');
  await idea.getByRole('button', { name: 'Send to Main chat' }).click();
  await expect(
    page.getByText('Let’s start with a short route and choose a time that works for you.', {
      exact: true,
    }),
  ).toBeVisible({ timeout: 20000 });
  await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue('My native draft');
  checks.push({
    check:
      'packaged local worker uses configured HTTP model for ideas and edited chat request with draft preservation and no navigation messages',
    passed: true,
  });
  await application.close();
  application = await launch();
  page = await application.firstWindow();
  await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue('My native draft', {
    timeout: 20000,
  });
  await expect(page.getByText('Plan a short walk after lunch.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Ideas', exact: true }).click();
  await page.getByRole('button', { name: 'Check for ideas', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check for ideas', exact: true })).toBeEnabled({
    timeout: 20000,
  });
  await expect(page.getByRole('article', { name: 'A little room for a walk' })).toHaveCount(0);
  expect(
    await page.evaluate(
      async () =>
        (await (await fetch('/api/state')).json()).messages.filter((m) => m.role === 'user').length,
    ),
  ).toBe(1);
  checks.push({
    check: 'complete app restart preserves request, draft and accepted-topic suppression in SQLite',
    passed: true,
  });
  console.log('2 packaged Mac idea checks passed.');
} finally {
  if (application) await application.close();
  await fixture.close();
  await rm(data, { recursive: true, force: true });
  await rm(fixtureDir, { recursive: true, force: true });
  await writeFile(
    join(evidence, 'ideas-native-mac.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        executable,
        provider: 'controlled HTTP fixture',
        checks,
      },
      null,
      2,
    ),
  );
}
