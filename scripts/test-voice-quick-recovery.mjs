// SPDX-License-Identifier: MIT
// Isolated UI recovery checks. Verified cached runtime; no owner settings or microphone.
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { localListeningFixture } from './local-listening-fixture.mjs';

const directory = await mkdtemp(join(tmpdir(), 'relay-voice-quick-recovery-'));
const fixture = await localListeningFixture(directory);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  fixture.services.provider.select(null);
  fixture.listeningControls.hold = true;
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(fixture.url);
  const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
  await composer.fill('Keep this draft while I set up voice.');
  await page.evaluate(() => (location.hash = '#settings?section=voice'));
  await page.getByRole('button', { name: 'Set up voice', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel voice setup' })).toBeVisible();
  // Another device explicitly changes speech while the download is pending.
  fixture.voiceConnections.update('speech', {
    revision: fixture.voiceConnections.publicState().speech.revision,
    action: 'save',
    baseUrl: fixture.baseUrl,
    model: 'retained-speech',
    voice: 'test',
    apiKey: 'isolated-test-key',
  });
  fixture.listeningControls.hold = false;
  await expect.poll(() => fixture.installation.status().installation.phase).toBe('ready');
  await expect(page.getByRole('alert')).toContainText('neither connection was switched');
  expect(fixture.voiceConnections.publicState().transcription.mode).toBe('off');
  expect(fixture.voiceConnections.publicState().speech.mode).toBe('saved');
  expect(fixture.voiceConnections.publicState().speech.saved.model).toBe('retained-speech');
  checks.push(
    'Concurrent speech change is retained, neither local connection activates, and recovery is visible',
  );
  await page.getByRole('button', { name: 'Use local voice', exact: true }).click();
  await expect(page.getByText('Voice is ready.', { exact: true })).toBeVisible();
  expect(fixture.voiceConnections.publicState().transcription.mode).toBe('local');
  expect(fixture.voiceConnections.publicState().speech.mode).toBe('system');
  expect(fixture.voiceConnections.publicState().speech.saved.hasKey).toBe(true);
  await expect(
    page.getByText('Dictation is ready. Connect an AI model for voice chats.'),
  ).toBeVisible();
  expect(fixture.services.provider.configured).toBe(false);
  checks.push(
    'Explicit retry selects both installed capabilities, retains saved provider, and explains missing chat model',
  );
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: resolve('../relay-evidence/voice-quick-phone-no-model-dark.png') });
  await page.getByRole('button', { name: 'Connect AI', exact: true }).click();
  await expect(page).toHaveURL(/section=models/);
  await page.evaluate(() => (location.hash = '#chat'));
  await expect(composer).toHaveValue('Keep this draft while I set up voice.');
  expect(fixture.store.read().messages).toHaveLength(0);
  checks.push(
    'Connect AI opens model settings; draft and history remain unchanged; dark phone has no overflow or AXE violations',
  );
  expect(errors).toEqual([]);
  await writeFile(
    resolve('../relay-evidence/voice-quick-recovery-acceptance.json'),
    JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), checks, errors }, null, 2),
  );
  console.log('PASS:', checks);
} finally {
  await browser.close();
  await fixture.close();
  await rm(directory, { recursive: true, force: true });
}
