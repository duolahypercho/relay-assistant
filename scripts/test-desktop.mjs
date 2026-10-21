// SPDX-License-Identifier: MIT
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const root = resolve('.');
const data = await mkdtemp(join(tmpdir(), 'relay-desktop-test-'));
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence');
const label = process.env.RELAY_DESKTOP_TEST_LABEL || '';
if (label && !/^[a-z0-9-]{1,40}$/.test(label)) throw Error('Use a simple desktop test label.');
await mkdir(evidence, { recursive: true });
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
const stem = `native-desktop${executable ? '-packaged' : ''}${label ? '-' + label : ''}`;
const receipt = {
  passed: false,
  packaged: Boolean(executable),
  platform: process.platform,
  arch: process.arch,
  checks: [],
  startedAt: new Date().toISOString(),
};
async function launch() {
  return await electron.launch({
    args,
    env,
    chromiumSandbox: true,
    ...(executable ? { executablePath: executable } : {}),
    timeout: 40000,
  });
}
async function snapshot(page) {
  return await page.evaluate(async () => (await fetch('/api/state')).json());
}
try {
  application = await launch();
  let page = await application.firstWindow();
  await expect(page.getByLabel('Message Relay', { exact: true })).toBeVisible({ timeout: 20000 });
  const base = new URL(page.url()).origin;
  const initial = await snapshot(page);
  expect(initial.connections.runtime.storage).toBe('SQLite');
  expect(await page.evaluate(() => typeof window.require)).toBe('undefined');
  receipt.runtime = await application.evaluate(({ app, BrowserWindow }) => ({
    versions: process.versions,
    desktopName: process.env.CHROME_DESKTOP || null,
    sandboxDisabled: app.commandLine.hasSwitch('no-sandbox'),
    preferences: Object.fromEntries(
      ['sandbox', 'contextIsolation', 'nodeIntegration'].map((key) => [
        key,
        BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()[key],
      ]),
    ),
  }));
  expect(receipt.runtime.sandboxDisabled).toBe(false);
  if (process.platform === 'linux')
    expect(receipt.runtime.desktopName).toBe('org.relay.assistant.desktop');
  expect(receipt.runtime.preferences).toEqual({
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
  });
  receipt.checks.push(
    'Native Electron window uses the real SQLite server with renderer Node access disabled.',
  );
  await page
    .getByLabel('Message Relay', { exact: true })
    .fill('Remember native desktop verification');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Memory saved', { exact: true })).toBeVisible();
  expect((await snapshot(page)).memories.map((m) => m.text)).toContain(
    'native desktop verification',
  );
  await application.evaluate(({ Menu }) =>
    Menu.getApplicationMenu().getMenuItemById('new-chat').click(),
  );
  await expect
    .poll(async () => (await snapshot(page)).threads.length)
    .toBe(initial.threads.length + 1);
  receipt.checks.push('A native menu command creates a server-backed conversation.');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Skills', exact: true }).click();
  await page.getByRole('button', { name: 'New skill', exact: true }).click();
  const skillForm = page.getByRole('region', { name: 'Save a skill', exact: true });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await skillForm.getByLabel('Skill name', { exact: true }).fill('Native skill');
  await skillForm.getByLabel('Shortcut', { exact: true }).fill('native-skill');
  await skillForm
    .getByLabel('Instructions', { exact: true })
    .fill('Remember native skill persistence');
  await skillForm.getByRole('button', { name: 'Save skill', exact: true }).click();
  await expect(skillForm).toBeHidden();
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  const composer = page.getByLabel('Message Relay', { exact: true });
  await composer.fill('/native');
  await expect(page.getByRole('listbox', { name: 'Saved skills' })).toBeVisible();
  await composer.press('Enter');
  await expect(composer).toHaveValue('/native-skill ');
  await composer.press('Enter');
  await expect
    .poll(
      async () => (await snapshot(page)).runs.find((r) => r.skill?.slug === 'native-skill')?.status,
    )
    .toBe('completed');
  receipt.checks.push(
    'A skill is created through native app controls, selected with slash, and executed by the SQLite worker.',
  );
  const taskId = await page.evaluate(async () => {
    const r = await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'task.create',
        payload: {
          title: 'Window-closed verification',
          description: 'A saved result must complete after closing the native window.',
          kind: 'general',
          threadId: 'main',
        },
      }),
    });
    return (await r.json()).result.id;
  });
  const routineId = await page.evaluate(async () => {
    const at = new Date(Math.ceil((Date.now() + 5000) / 60000) * 60000);
    async function act(action, payload) {
      const res = await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, payload }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      return body.result;
    }
    const r = await act('routine.create', {
      title: 'Native scheduled reminder',
      instructions: 'Your native reminder arrived with every window closed.',
      execution: 'reminder',
      threadId: 'main',
      schedule: {
        kind: 'once',
        date: at.toISOString().slice(0, 10),
        time: at.toISOString().slice(11, 16),
        timeZone: 'UTC',
      },
    });
    await act('routine.resume', { id: r.id });
    return r.id;
  });
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((window) => window.close()),
  );
  await expect
    .poll(
      async () => {
        const state = await (await fetch(`${base}/api/state`)).json();
        return state.tasks.find((task) => task.id === taskId)?.status;
      },
      { timeout: 15000 },
    )
    .toBe('completed');
  receipt.checks.push('The worker completes a durable task while all native windows are closed.');
  await expect
    .poll(
      async () => {
        const state = await (await fetch(`${base}/api/state`)).json();
        return state.messages.filter((m) => m.routineId === routineId).length;
      },
      { timeout: 90000, intervals: [500] },
    )
    .toBe(1);
  receipt.checks.push(
    'A real scheduled reminder fires once at its wall-clock time with every native window closed.',
  );
  const nextWindow = application.waitForEvent('window');
  await application.evaluate(({ Menu }) =>
    Menu.getApplicationMenu().getMenuItemById('search').click(),
  );
  page = await nextWindow;
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await mkdir(evidence, { recursive: true });
  await page.screenshot({
    path: join(evidence, `${stem}.png`),
  });
  await application.close();
  application = await launch();
  page = await application.firstWindow();
  await expect(page.getByLabel('Message Relay', { exact: true })).toBeVisible({ timeout: 20000 });
  const restarted = await snapshot(page);
  console.log(
    'Restarted synthetic-test memories:',
    restarted.memories.map((m) => m.text),
  );
  expect(restarted.memories.map((m) => m.text)).toContain('native desktop verification');
  expect(restarted.tasks.find((t) => t.id === taskId).status).toBe('completed');
  expect(restarted.messages.filter((m) => m.routineId === routineId)).toHaveLength(1);
  expect(restarted.skills.find((skill) => skill.slug === 'native-skill')?.version).toBe(1);
  expect(restarted.memories.some((m) => m.text === 'native skill persistence')).toBe(true);
  receipt.checks.push(
    'A complete application restart preserves memory, completed work and conversation state.',
  );
  receipt.passed = true;
  receipt.completedAt = new Date().toISOString();
  await writeFile(join(evidence, `${stem}.json`), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  receipt.error = error.stack;
  await application
    ?.firstWindow()
    .then((page) => page.screenshot({ path: join(evidence, `${stem}-failure.png`) }))
    .catch(() => {});
  await writeFile(join(evidence, `${stem}.json`), JSON.stringify(receipt, null, 2));
  throw error;
} finally {
  await application?.close().catch(() => {});
  await rm(data, { recursive: true, force: true });
}
