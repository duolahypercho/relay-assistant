import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
// Media capture and accessibility scans may run alongside native builds on the host.
test.setTimeout(90000);
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence');
const voice = (page: Page) => page.getByRole('region', { name: 'Voice input', exact: true });
async function newChat(page: Page) {
  await page.goto('/#chat');
  await expect(page.getByLabel('Message Relay', { exact: true })).toBeVisible();
  const show = page.getByRole('button', { name: 'Show chats', exact: true });
  if (await show.isVisible()) await show.click();
  await page
    .getByRole('complementary', { name: 'Your chats', exact: true })
    .locator('button.new-side-chat')
    .click();
  await expect(page.locator('.conversation-list .thread-link[aria-current="page"]')).toHaveCount(1);
  await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue('');
}
async function openVoice(page: Page, draft = '') {
  await newChat(page);
  await page.getByLabel('Message Relay', { exact: true }).fill(draft);
  await page.getByRole('button', { name: 'Start voice input', exact: true }).click();
  return voice(page);
}
async function ready(page: Page) {
  await expect(voice(page).getByRole('status')).toHaveText('Listening…');
  await expect(voice(page).locator('time')).toHaveText('0:01');
}
async function stopped(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__voiceStreams
          .flatMap((s: MediaStream) => s.getTracks())
          .every((t: MediaStreamTrack) => t.readyState === 'ended'),
      ),
    )
    .toBe(true);
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__voiceStreams = [];
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await original(constraints);
      (window as any).__voiceStreams.push(stream);
      return stream;
    };
  });
});
test('two-click inline dictation; current draft stays editable and only sends explicitly', async ({
  page,
}, info) => {
  const panel = await openVoice(page, 'My existing draft.');
  await ready(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Editing while recording must not be overwritten by a stale callback.
  const composer = page.getByLabel('Message Relay', { exact: true });
  await composer.fill('My edited draft.');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: resolve(evidence, `${info.project.name}-inline.png`) });
  const before = await page.locator('.message.user').count();
  await panel.getByRole('button', { name: 'Done recording', exact: true }).click();
  await expect(panel).toBeHidden();
  await stopped(page);
  await expect(composer).toHaveValue('My edited draft. Please plan a quiet morning.');
  expect(await page.locator('.message.user').count()).toBe(before);
  await composer.fill(`Edited voice draft ${info.project.name}.`);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.message.user').last()).toContainText(
    `Edited voice draft ${info.project.name}.`,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('denied microphone and late permission preserve draft; cancel immediately stops capture', async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).__originalVoiceMedia = navigator.mediaDevices.getUserMedia;
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException('Denied', 'NotAllowedError');
    };
  });
  const panel = await openVoice(page, 'Keep this draft.');
  await expect(panel.getByRole('alert')).toContainText('Microphone access was not allowed');
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = (window as any).__originalVoiceMedia;
  });
  await panel.getByRole('button', { name: 'Try microphone again', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Listening…');
  await panel.getByRole('button', { name: 'Cancel voice input', exact: true }).click();
  await stopped(page);
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = () =>
      new Promise((resolve) => {
        (window as any).__resolveVoicePermission = async () =>
          resolve(await (window as any).__originalVoiceMedia({ audio: true }));
      });
  });
  const composer = page.getByLabel('Message Relay', { exact: true });
  await composer.press('Control+d');
  await expect(panel.getByRole('status')).toContainText('Waiting');
  await panel.getByRole('button', { name: 'Cancel voice input', exact: true }).click();
  await page.evaluate(() => (window as any).__resolveVoicePermission());
  await stopped(page);
  await expect(composer).toHaveValue('Keep this draft.');
});
test('failed dictation keeps playable audio for explicit retry; overflow and cancel preserve draft', async ({
  page,
}) => {
  let requests = 0;
  await page.route('**/api/transcribe', async (route) => {
    requests++;
    await route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'The speech service is temporarily unavailable.' }),
    });
  });
  const panel = await openVoice(page, 'Keep this typed draft.');
  await ready(page);
  await panel.getByRole('button', { name: 'Done recording', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('temporarily unavailable');
  expect(requests).toBe(1);
  await stopped(page);
  const audio = panel.locator('audio');
  await audio.evaluate((el: HTMLAudioElement) => el.play());
  await expect
    .poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime))
    .toBeGreaterThan(0);
  await audio.evaluate((el: HTMLAudioElement) => el.pause());
  await page.unroute('**/api/transcribe');
  await page.route('**/api/transcribe', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ text: 'x'.repeat(12000) }),
    }),
  );
  await panel.getByRole('button', { name: 'Retry transcription', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('12,000 characters');
  await page.unroute('**/api/transcribe');
  await panel.getByRole('button', { name: 'Retry transcription', exact: true }).click();
  await expect(panel).toBeHidden();
  const composer = page.getByLabel('Message Relay', { exact: true });
  await expect(composer).toHaveValue(/Please plan a quiet morning\.$/);
  const preservedDraft = await composer.inputValue();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/api/transcribe', async (route) => {
    await held;
    await route
      .fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ text: 'This must never enter the draft.' }),
      })
      .catch(() => {});
  });
  await page.getByRole('button', { name: 'Start voice input', exact: true }).click();
  await ready(page);
  await panel.getByRole('button', { name: 'Done recording', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Transcribing…');
  await panel.getByRole('button', { name: 'Cancel transcription', exact: true }).click();
  release();
  await expect(panel).toBeHidden();
  await expect(composer).toHaveValue(preservedDraft);
  await page.unroute('**/api/transcribe');
});
test('background and the two-minute cap stop capture without sending audio; switching chat stops it too', async ({
  page,
}) => {
  let requests = 0;
  page.on('request', (r) => {
    if (r.url().endsWith('/api/transcribe')) requests++;
  });
  await page.clock.install();
  const panel = await openVoice(page);
  await ready(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(panel.getByRole('status')).toHaveText('Recording saved for retry');
  await stopped(page);
  await page.evaluate(() =>
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    }),
  );
  await panel.getByRole('button', { name: 'Record again', exact: true }).click();
  // Let the real MediaRecorder produce audio before advancing the JS deadline.
  await ready(page);
  await page.clock.fastForward(120001);
  await expect(panel.getByRole('status')).not.toHaveText('Listening…');
  await expect(panel.locator('time')).toHaveText('2:00');
  await stopped(page);
  expect(requests).toBe(0);
  await panel.getByRole('button', { name: 'Record again', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Listening…');
  const sidebar = page.getByRole('button', { name: 'Show chats', exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page
    .getByRole('complementary', { name: 'Your chats', exact: true })
    .locator('button.new-side-chat')
    .click();
  await expect(panel).toBeHidden();
  await stopped(page);
});
