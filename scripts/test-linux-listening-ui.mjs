// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { linuxListeningFixture } from './linux-listening-fixture.mjs';
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
let f, browser, activePage;
const report = {
  startedAt: new Date().toISOString(),
  checks: [],
  limits:
    'Original synthetic speech through real browser encoders and actual CPU Whisper on Linux. Controlled chat and speech-output providers; physical microphones, noise, Android and Linux AMD64 runtime remain unverified.',
};
try {
  f = await linuxListeningFixture();
  browser = await chromium.launch();
  for (const mobile of [false, true]) {
    const label = mobile ? 'phone' : 'desktop';
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 900 },
      isMobile: mobile,
      hasTouch: mobile,
      ignoreHTTPSErrors: true,
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    activePage = page;
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(f.url + '/#chat');
    await page.getByLabel('Server access key', { exact: true }).fill(f.key);
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    const composer = page.getByLabel('Message Relay', { exact: true });
    await expect(composer).toBeVisible();
    const draft = `Keep my ${label} listening draft.`;
    await composer.fill(draft);
    const before = (await f.state()).messages.length;
    await page.goto(f.url + '/#settings?section=voice');
    const panel = page.getByRole('article', { name: 'Voice settings', exact: true });
    if (!mobile) {
      await expect(
        panel.getByText('148 MB download · No account needed', { exact: true }),
      ).toBeVisible();
      await panel.getByRole('button', { name: 'Set up local listening', exact: true }).click();
      await panel.getByRole('button', { name: 'Cancel listening setup', exact: true }).click();
      await expect(
        panel.getByRole('button', { name: 'Continue listening setup', exact: true }),
      ).toBeVisible();
      assert.equal((await f.json('/api/voice-connections')).transcription.mode, 'off');
      const started = Date.now();
      await panel.getByRole('button', { name: 'Continue listening setup', exact: true }).click();
      await page.reload();
      await expect
        .poll(async () => (await f.json('/api/voice-connections/local')).installed, {
          timeout: 300000,
          intervals: [1000],
        })
        .toBe(true);
      report.installMs = Date.now() - started;
      await expect(panel.getByLabel('Listening connection', { exact: true })).toHaveValue('local', {
        timeout: 30000,
      });
    } else {
      await panel.getByLabel('Listening connection', { exact: true }).selectOption('off');
      await expect(
        panel.getByRole('button', { name: 'Use local listening', exact: true }),
      ).toBeVisible();
      await panel.getByRole('button', { name: 'Use local listening', exact: true }).click();
      await expect(panel.getByLabel('Listening connection', { exact: true })).toHaveValue('local');
    }
    assert.equal((await f.state()).messages.length, before);
    assert.deepEqual(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
      [],
    );
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: resolve(evidence, `linux-listening-${label}-setup.png`) });
    await page.goto(f.url + '/#chat');
    await expect(composer).toHaveValue(draft);
    await page.getByRole('button', { name: 'Start voice input', exact: true }).click();
    await f.pulse();
    const started = Date.now();
    await page.getByRole('button', { name: 'Done recording', exact: true }).click();
    await expect(composer).toHaveValue(/water the plants tomorrow morning/i, { timeout: 90000 });
    assert.ok((await composer.inputValue()).startsWith(draft));
    report[label + 'RecognitionMs'] = Date.now() - started;
    assert.equal((await f.state()).messages.length, before);
    await page.reload();
    await expect(composer).toHaveValue(/water the plants tomorrow morning/i);
    await page.screenshot({ path: resolve(evidence, `linux-listening-${label}-dictation.png`) });
    const priorMessageIds = new Set((await f.state()).messages.map((m) => m.id));
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect
      .poll(
        async () => {
          const state = await f.state();
          return (
            state.messages.some((m) => !priorMessageIds.has(m.id) && m.role === 'assistant') &&
            !state.runs.some((r) => ['queued', 'running'].includes(r.status))
          );
        },
        { timeout: 30000 },
      )
      .toBe(true);
    await expect(
      page
        .locator('.message.assistant .markdown')
        .filter({ hasText: 'I have your message.' })
        .last(),
    ).toBeVisible();
    await composer.fill('');
    await page.getByRole('button', { name: 'Start voice chat', exact: true }).click();
    const callPanel = page.getByRole('region', { name: 'Voice chat', exact: true });
    await expect(callPanel.getByRole('status')).toHaveText('Listening');
    await composer.fill(`Keep my ${label} call draft.`);
    await f.pulse();
    await expect(callPanel.getByRole('status')).toHaveText('Relay is speaking', { timeout: 90000 });
    await expect(callPanel.getByRole('status')).toHaveText('Listening', { timeout: 30000 });
    await page.getByRole('button', { name: 'End call', exact: true }).click();
    await expect(composer).toHaveValue(`Keep my ${label} call draft.`);
    const call = (await f.state()).voiceCalls.at(-1);
    assert.equal(call.status, 'ended');
    assert.equal(call.turns.length, 1);
    assert.deepEqual(errors, []);
    report.checks.push(
      `${label}: explicit setup/selection, real captured speech, editable dictation, reload, explicit send, one live voice turn, retained draft and clean accessibility`,
    );
    await context.close();
  }
  const wav = await readFile(resolve('../../work/local-listening-research/probe.wav'));
  const started = Date.now();
  const recognized = await f.json('/api/transcribe', {
    method: 'POST',
    bytes: wav,
    headers: { 'Content-Type': 'audio/wav' },
  });
  assert.match(recognized.text, /water the plants tomorrow morning/i);
  report.directRecognition = { text: recognized.text, durationMs: Date.now() - started };
  const transport = await f.json('/__linux/state');
  assert.equal(transport.transcriptions, 0);
  assert.ok(transport.spoken >= 2);
  report.transport = {
    externalTranscriptionRequests: transport.transcriptions,
    controlledSpeechRequests: transport.spoken,
  };
  await f.restart();
  assert.equal((await f.json('/api/voice-connections/local')).installed, true);
  assert.equal((await f.json('/api/voice-connections')).transcription.mode, 'local');
  const after = await f.json('/api/transcribe', {
    method: 'POST',
    bytes: wav,
    headers: { 'Content-Type': 'audio/wav' },
  });
  assert.match(after.text, /water the plants tomorrow morning/i);
  report.checks.push(
    'Model and selection survive actual Linux container replacement; real recognition succeeds again without a model download',
  );
  report.passed = true;
  console.log(
    'PASS real Linux local listening, desktop/phone dictation, voice calls and container replacement',
  );
} catch (error) {
  report.error = error.stack;
  if (activePage && !activePage.isClosed()) {
    report.failurePage = (await activePage.locator('body').innerText()).slice(-14000);
    await activePage.screenshot({ path: resolve(evidence, 'linux-listening-ui-failure.png') });
  }
  if (f) {
    const state = await f.state().catch(() => ({}));
    report.failureState = { runs: state.runs, voiceCalls: state.voiceCalls };
  }
  throw error;
} finally {
  await browser?.close();
  report.finishedAt = new Date().toISOString();
  if (f && !report.passed)
    await writeFile(resolve(evidence, 'linux-listening-ui-failure.log'), await f.logs());
  await writeFile(
    resolve(evidence, 'linux-listening-ui-acceptance.json'),
    JSON.stringify(report, null, 2),
  );
  await f?.close();
}
