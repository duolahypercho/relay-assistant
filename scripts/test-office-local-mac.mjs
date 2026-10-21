// SPDX-License-Identifier: MIT
// Packaged local backend acceptance, including Worker imports inside the installed archive.
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { renderArtifact } from '../server/artifacts.mjs';
import { officeExamples } from './office-fixture.mjs';
import { artifactKinds } from '../shared/artifacts.mjs';
const directory = await mkdtemp(join(tmpdir(), 'relay-office-local-mac-'));
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
let app;
const checks = [];
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
  const page = await app.firstWindow({ timeout: 20000 });
  page.setDefaultTimeout(15000);
  const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
  await composer.fill('Keep my local Office draft');
  const before = await page.evaluate(async () => (await fetch('/api/state')).json());
  for (const [kind, source] of Object.entries(officeExamples)) {
    const { bytes } = await renderArtifact(source);
    const name = source.title + '.' + artifactKinds[kind].extension;
    await page
      .locator('.composer input[type=file]')
      .setInputFiles({ name, mimeType: artifactKinds[kind].mime, buffer: Buffer.from(bytes) });
    await page
      .locator('.composer')
      .getByRole('button', { name: `Open ${name}`, exact: true })
      .click();
    const preview = page.getByRole('region', { name: 'Office file text preview' });
    await expect(preview).toContainText('Tea');
    await expect(preview).toContainText('8');
    if (kind === 'spreadsheet') await expect(preview).toContainText('saved result: 33');
    await page.screenshot({ path: join(evidence, `office-local-mac-${kind}.png`) });
    await page.getByRole('button', { name: 'Back to chat' }).click();
    await expect(composer).toHaveValue('Keep my local Office draft');
    checks.push(
      `${kind}: bundled local backend starts an actual Office parsing Worker and returns the correct content`,
    );
  }
  const after = await page.evaluate(async () => (await fetch('/api/state')).json());
  expect(after.messages).toEqual(before.messages);
  await page.reload();
  await expect(composer).toHaveValue('Keep my local Office draft');
  await page
    .locator('.composer')
    .getByRole('button', { name: 'Open Weekend plan.docx', exact: true })
    .click();
  await expect(page.getByRole('region', { name: 'Office file text preview' })).toContainText(
    'Bring a book',
  );
  checks.push('Native reload preserves attachments/draft, and preview creates no messages');
  await writeFile(
    join(evidence, 'office-local-native-mac-acceptance.json'),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        checks,
        limits:
          'Unsigned macOS arm64; no live model or OS file chooser. Exercises the actual packaged local Node backend and Worker dependency resolution.',
      },
      null,
      2,
    ),
  );
  console.log('PASS: packaged local Mac Office parser, three formats, drafts and reload');
} finally {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
