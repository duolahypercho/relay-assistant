// SPDX-License-Identifier: MIT
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const root = resolve('.');
const data = await mkdtemp(join(tmpdir(), 'relay-decisions-test-'));
const evidence = resolve('..', 'relay-evidence');
const executable = process.env.RELAY_DESKTOP_EXECUTABLE;
const env = {
  ...process.env,
  RELAY_MODE: 'sample',
  RELAY_ACCESS_KEY: '',
  RELAY_BROWSER_ENABLED: 'false',
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
};
const args = [...(executable ? [] : [root]), `--relay-test-data=${data}`, '--relay-local-port=0'];
let application;
const receipt = { packaged: Boolean(executable), checks: [], startedAt: new Date().toISOString() };
async function launch() {
  return await electron.launch({
    args,
    env,
    ...(executable ? { executablePath: executable } : {}),
    timeout: 40000,
  });
}
async function snapshot(page) {
  return await page.evaluate(async () => (await fetch('/api/state')).json());
}
try {
  await mkdir(evidence, { recursive: true });
  application = await launch();
  let page = await application.firstWindow();
  await expect(page.getByLabel('Message Relay', { exact: true })).toBeVisible({ timeout: 20000 });
  expect((await snapshot(page)).connections.runtime.storage).toBe('SQLite');
  await page.getByLabel('Message Relay', { exact: true }).fill('Help me plan my week');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const question = () =>
    page.getByRole('group', { name: 'What matters most for this plan?', exact: true });
  await expect(question()).toBeVisible({ timeout: 20000 });
  await page.getByLabel('Message Relay', { exact: true }).fill('Keep my native draft');
  await expect
    .poll(async () => (await snapshot(page)).threads[0].draft)
    .toBe('Keep my native draft');
  await page.screenshot({ path: join(evidence, 'native-desktop-question-pending.png') });
  receipt.checks.push(
    'The installed desktop runtime creates an inline question through the real SQLite worker.',
  );
  await application.close();
  application = await launch();
  page = await application.firstWindow();
  await expect(question()).toBeVisible({ timeout: 20000 });
  await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
    'Keep my native draft',
  );
  receipt.checks.push(
    'An unanswered question and separate composer draft survive a full native app restart.',
  );
  await question()
    .getByRole('button', { name: /^Make time to rest/ })
    .click();
  await expect(question()).toContainText('Answered · Make time to rest');
  await expect
    .poll(async () => (await snapshot(page)).tasks[0]?.status, { timeout: 20000 })
    .toBe('completed');
  expect((await snapshot(page)).tasks).toHaveLength(1);
  expect((await snapshot(page)).questions[0].answer).toBe('Make time to rest');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  receipt.checks.push(
    'One choice resumes the request once, saves a task result and opens no decision dialog.',
  );
  const reacted = page.locator('.message.assistant').last();
  const reactedId = await reacted.getAttribute('id');
  await reacted.getByRole('button', { name: 'Message actions', exact: true }).click();
  await reacted.getByRole('button', { name: 'React ❤️', exact: true }).click();
  await reacted.getByRole('button', { name: 'Message actions', exact: true }).click();
  await reacted.getByRole('button', { name: 'Reply to message', exact: true }).click();
  await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
    'Keep my native draft',
  );
  await page
    .getByLabel('Message Relay', { exact: true })
    .fill('Remember I prefer a calm afternoon');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.message.user').last().locator('.quoted-message')).toBeVisible();
  await expect
    .poll(async () => (await snapshot(page)).runs.every((r) => r.status === 'completed'))
    .toBe(true);
  await page.getByLabel('Message Relay', { exact: true }).fill('Keep my native draft');
  await expect
    .poll(async () => (await snapshot(page)).threads[0].draft)
    .toBe('Keep my native draft');
  await page.screenshot({ path: join(evidence, 'native-desktop-message-bubbles.png') });
  receipt.checks.push(
    'A saved reaction and quoted reply use the real SQLite API; Reply preserves the existing draft.',
  );
  const beforeNavigation = await snapshot(page);
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await expect(page.getByLabel('Message Relay', { exact: true })).toBeHidden();
  expect((await snapshot(page)).messages).toEqual(beforeNavigation.messages);
  expect((await snapshot(page)).runs).toEqual(beforeNavigation.runs);
  receipt.checks.push('Task navigation opens a separate screen without messages or runs.');
  await page.getByLabel('What needs to get done?', { exact: true }).fill('Native inline task');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await page.screenshot({ path: join(evidence, 'native-desktop-task-inline.png') });
  await page.getByRole('button', { name: 'Start task', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await snapshot(page)).tasks.find((t) => t.title === 'Native inline task')?.status,
      { timeout: 20000 },
    )
    .toBe('completed');
  receipt.checks.push(
    'A task starts from its separate page and completes without adding synthetic chat messages.',
  );
  await application.close();
  application = await launch();
  page = await application.firstWindow();
  await expect(page.getByLabel('Message Relay', { exact: true })).toBeVisible({ timeout: 20000 });
  const restarted = await snapshot(page);
  expect(restarted.questions[0].status).toBe('answered');
  expect(restarted.messages.find((m) => `message-${m.id}` === reactedId).reaction).toBe('❤️');
  expect(
    restarted.messages.some((m) => m.quoted && m.text === 'Remember I prefer a calm afternoon'),
  ).toBe(true);
  expect(restarted.tasks).toHaveLength(2);
  expect(restarted.tasks.every((t) => t.status === 'completed')).toBe(true);
  await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
    'Keep my native draft',
  );
  receipt.checks.push(
    'Answered receipt, both completed tasks and the original draft survive another full restart.',
  );
  receipt.completedAt = new Date().toISOString();
  await writeFile(
    join(evidence, 'native-desktop-questions.json'),
    JSON.stringify(receipt, null, 2),
  );
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await application?.close().catch(() => {});
  await rm(data, { recursive: true, force: true });
}
