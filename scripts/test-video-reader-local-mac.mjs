// SPDX-License-Identifier: MIT
// Runs installed FFmpeg from the packaged local Node backend with a minimal PATH.
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { videoReaderFixture, videoQuestion, videoAnswer } from './video-reader-fixture.mjs';
const directory = await mkdtemp(join(tmpdir(), 'relay-video-local-mac-')),
  evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const f = await videoReaderFixture(join(directory, 'fixture'));
let app;
try {
  app = await electron.launch({
    executablePath: resolve('release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay'),
    args: [`--relay-test-data=${join(directory, 'desktop')}`, '--relay-local-port=0'],
    env: {
      ...process.env,
      PATH: '/usr/bin:/bin',
      RELAY_DESKTOP_ENV: '',
      RELAY_MODE: 'live',
      RELAY_ACCESS_KEY: '',
      RELAY_MODEL_BASE_URL: f.provider.publicState().connections[0].baseUrl,
      RELAY_MODEL_ID: 'assistant-test',
      RELAY_MODEL_API_KEY: '',
      RELAY_MODEL_PROTOCOL: 'chat',
      RELAY_TRANSCRIPTION_BASE_URL: f.transcriptionBaseUrl,
      RELAY_TRANSCRIPTION_MODEL: 'independent-listener',
      RELAY_TRANSCRIPTION_API_KEY: '',
      RELAY_SPEECH_BASE_URL: '',
      RELAY_SPEECH_MODEL: '',
      RELAY_SPEECH_API_KEY: '',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      RELAY_DESKTOP_ENABLED: 'false',
      RELAY_COMPUTER_ENABLED: 'false',
      RELAY_BROWSER_ENABLED: 'false',
    },
  });
  const page = await app.firstWindow({ timeout: 20000 });
  page.setDefaultTimeout(20000);
  const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
  await composer.fill(videoQuestion);
  await page
    .locator('.composer input[type=file]')
    .setInputFiles({ name: f.file.name, mimeType: 'video/mp4', buffer: f.bytes });
  await expect(page.getByRole('group', { name: 'Draft attachments', exact: true })).toContainText(
    f.file.name,
  );
  const before = await page.evaluate(async () => (await fetch('/api/state')).json());
  const saved = before.files.find((file) => file.name === 'Color study.mp4');
  expect(saved).toBeTruthy();
  // Point the independent model at the separately saved packaged-app file ID.
  f.file.id = saved.id;
  await page.reload();
  await expect(composer).toHaveValue(videoQuestion);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.chat-workspace').getByText(videoAnswer, { exact: true })).toBeVisible(
    {
      timeout: 40000,
    },
  );
  expect(f.frames).toHaveLength(3);
  expect(f.transcriptions).toHaveLength(1);
  expect(f.errors).toEqual([]);
  const after = await page.evaluate(async () => (await fetch('/api/state')).json());
  expect(after.messages).toHaveLength(before.messages.length + 2);
  expect(after.messages.at(-1).cards.filter((card) => card.kind === 'file')).toHaveLength(1);
  expect(after.files.find((file) => file.id === saved.id).base64).toBe(f.bytes.toString('base64'));
  await page.screenshot({ path: join(evidence, 'video-reader-local-native-mac.png') });
  await writeFile(
    join(evidence, 'video-reader-local-native-mac-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        checks: [
          'packaged local backend discovers the installed FFmpeg with a minimal PATH',
          'actual frame pixels and soundtrack bytes reach independent services',
          'three timestamped frames are delivered together with segment transcription',
          'upload, restart-safe draft and unchanged original',
        ],
        scope:
          'macOS arm64 packaged local server with a controlled HTTP model; no live vision-quality claim.',
      },
      null,
      2,
    ),
  );
  console.log('PASS: packaged local Mac video decoder, audio extraction and model payload');
} finally {
  await app?.close();
  await f.close();
  await rm(directory, { recursive: true, force: true });
}
