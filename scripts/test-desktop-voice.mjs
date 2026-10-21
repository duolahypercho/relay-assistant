// SPDX-License-Identifier: MIT
import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { audioFixture } from './audio-fixture.mjs';
const root = resolve('.');
const data = await mkdtemp(join(tmpdir(), 'relay-voice-desktop-'));
const executable = process.env.RELAY_DESKTOP_EXECUTABLE;
let received = 0;
const fixture = createServer(async (req, res) => {
  if (req.url === '/v1/audio/speech') {
    for await (const _ of req) {
    }
    res.setHeader('Content-Type', 'audio/wav');
    res.end(audioFixture());
    return;
  }
  const form = await new Request('http://localhost', {
    method: 'POST',
    headers: req.headers,
    body: req,
    duplex: 'half',
  }).formData();
  expect(form.get('file').size).toBeGreaterThan(12);
  received++;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ text: 'Remember a quiet morning.' }));
}).listen(0, '127.0.0.1');
await once(fixture, 'listening');
let application;
const receipt = {
  packaged: !!executable,
  syntheticMicrophone: true,
  permissionDialog: 'controlled Allow response; actual OS microphone permission unverified',
  checks: [],
  startedAt: new Date().toISOString(),
};
try {
  const launch = () =>
    electron.launch({
      args: [
        ...(executable ? [] : [root]),
        `--relay-test-data=${data}`,
        '--relay-local-port=0',
        '--use-fake-device-for-media-stream',
      ],
      ...(executable ? { executablePath: executable } : {}),
      env: {
        ...process.env,
        RELAY_MODE: 'sample',
        RELAY_ACCESS_KEY: '',
        RELAY_BROWSER_ENABLED: 'false',
        RELAY_MODEL_BASE_URL: '',
        RELAY_MODEL_ID: '',
        RELAY_MODEL_API_KEY: '',
        GOOGLE_CLIENT_ID: '',
        GOOGLE_CLIENT_SECRET: '',
        RELAY_TRANSCRIPTION_BASE_URL: `http://127.0.0.1:${fixture.address().port}/v1`,
        RELAY_TRANSCRIPTION_MODEL: 'controlled-native-test',
        RELAY_TRANSCRIPTION_API_KEY: '',
        RELAY_SPEECH_BASE_URL: `http://127.0.0.1:${fixture.address().port}/v1`,
        RELAY_SPEECH_MODEL: 'controlled-native-speech',
        RELAY_SPEECH_API_KEY: '',
        RELAY_SPEECH_VOICE: 'coral',
      },
    });
  application = await launch();
  let page = await application.firstWindow();
  await expect(page.getByLabel('Message Relay', { exact: true })).toBeVisible({ timeout: 20000 });
  // Exercise Relay's actual permission filter without recording a real microphone.
  await application.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await page.getByLabel('Message Relay', { exact: true }).fill('Existing draft.');
  await page.getByRole('button', { name: 'Start voice input', exact: true }).click();
  const sheet = page.getByRole('region', { name: 'Voice input', exact: true });
  await expect(sheet.getByRole('status')).toHaveText('Listening…');
  await expect(sheet.locator('time')).toHaveText('0:01');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Done recording', exact: true }).click();
  receipt.checks.push(
    'Dictation starts from one microphone tap and finishes inline without a modal.',
  );
  await expect(sheet).toBeHidden();
  await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
    'Existing draft. Remember a quiet morning.',
  );
  expect(received).toBe(1);
  const state = await page.evaluate(async () => (await fetch('/api/state')).json());
  expect(state.messages.some((m) => m.text.includes('Remember a quiet morning.'))).toBe(false);
  receipt.checks.push(
    'Recorded bytes pass through the native SQLite server to a local transcription fixture; transcript enters the existing draft without sending.',
  );
  await page.getByLabel('Message Relay', { exact: true }).fill('Remember native voice editing');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Memory saved', { exact: true })).toBeVisible();
  receipt.checks.push(
    'Editing and sending the transcript uses the durable native chat and memory worker.',
  );
  const message = page.locator('.message.assistant').last();
  await message.getByRole('button', { name: 'Message actions', exact: true }).click();
  await message.getByRole('button', { name: 'Create voice memo', exact: true }).click();
  const memo = message.getByRole('group', { name: 'Voice memo' });
  await expect(memo).toBeVisible();
  await memo.getByRole('button', { name: 'Play voice memo', exact: true }).click();
  await expect.poll(() => memo.locator('audio').evaluate((a) => a.currentTime)).toBeGreaterThan(0);
  await memo.getByRole('button', { name: 'Pause voice memo', exact: true }).click();
  const memoSource = await memo.locator('audio').getAttribute('src');
  receipt.checks.push(
    'A reply creates a persisted inline voice memo and plays the controlled tone without a popup.',
  );
  await application.close();
  application = await launch();
  page = await application.firstWindow();
  await expect(page.getByLabel('Message Relay', { exact: true })).toBeVisible({ timeout: 20000 });
  const replay = page.locator(`audio[src="${memoSource}"]`);
  await expect(replay).toHaveCount(1);
  await expect.poll(() => replay.evaluate((a) => a.readyState)).toBeGreaterThan(0);
  await replay.evaluate((a) => a.play());
  await expect.poll(() => replay.evaluate((a) => a.currentTime)).toBeGreaterThan(0);
  await replay.evaluate((a) => a.pause());
  receipt.checks.push(
    'Closing and relaunching the native app preserves both the memo transcript and playable audio.',
  );
  receipt.completedAt = new Date().toISOString();
  const dir = resolve('../relay-evidence');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, executable ? 'native-desktop-voice-packaged.json' : 'native-desktop-voice.json'),
    JSON.stringify(receipt, null, 2) + '\n',
  );
  await page.screenshot({
    path: join(dir, executable ? 'native-desktop-voice-packaged.png' : 'native-desktop-voice.png'),
  });
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await application?.close();
  fixture.closeAllConnections();
  await new Promise((r) => fixture.close(r));
  await rm(data, { recursive: true, force: true });
}
