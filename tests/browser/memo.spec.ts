import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
// Media capture and accessibility scans may run alongside native builds on the host.
test.setTimeout(90000);
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence');
async function newChat(page: Page) {
  await page.goto('/#chat');
  // Navigation can resolve before React mounts the responsive drawer controls.
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
async function reply(page: Page, text: string) {
  const composer = page.getByLabel('Message Relay', { exact: true });
  await composer.fill(text);
  const before = await page.locator('.message.assistant').count();
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.message.assistant')).toHaveCount(before + 1);
  await expect(page.getByRole('button', { name: 'Stop reply', exact: true })).toBeHidden();
  const message = page.locator('.message.assistant').last();
  await message.getByRole('button', { name: 'Message actions', exact: true }).click();
  await expect(
    message.getByRole('button', { name: 'Create voice memo', exact: true }),
  ).toBeVisible();
  return message;
}
test('saved voice memo plays inline, seeks, downloads and survives reload without affecting draft', async ({
  page,
}, info) => {
  await newChat(page);
  const message = await reply(page, `Remember the voice memo journey ${info.project.name}`);
  await page.getByLabel('Message Relay', { exact: true }).fill('Keep my next message.');
  await message.getByRole('button', { name: 'Create voice memo', exact: true }).click();
  const memo = message.getByRole('group', { name: 'Voice memo', exact: true });
  await expect(memo).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(memo).toHaveClass(/voice-memo-inline/);
  await expect(memo.getByText('AI voice', { exact: true })).toBeVisible();
  await expect(memo.getByRole('slider')).toBeEnabled();
  await memo.getByRole('button', { name: 'Play voice memo', exact: true }).click();
  await expect
    .poll(() => memo.locator('audio').evaluate((a: HTMLAudioElement) => a.currentTime))
    .toBeGreaterThan(0);
  await memo.getByRole('button', { name: 'Pause voice memo', exact: true }).click();
  await memo.getByRole('slider').fill('0.5');
  await expect
    .poll(() => memo.locator('audio').evaluate((a: HTMLAudioElement) => a.currentTime))
    .toBeCloseTo(0.5, 1);
  await expect(memo.locator('details')).toHaveCount(0);
  await expect(message.locator('.message-bubble')).toContainText('I’ll keep that in mind.');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: resolve(evidence, `${info.project.name}-memo.png`) });
  const download = page.waitForEvent('download');
  await memo.getByRole('link', { name: 'Download voice memo', exact: true }).click();
  const file = await download;
  const path = test.info().outputPath('voice.wav');
  await file.saveAs(path);
  const wav = await readFile(path);
  expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
  const url = await memo.locator('audio').getAttribute('src');
  const chatIndex = await page
    .locator('.conversation-list .thread-link')
    .evaluateAll((els) => els.findIndex((el) => el.getAttribute('aria-current') === 'page'));
  expect(chatIndex).toBeGreaterThanOrEqual(0);
  await page.reload();
  // React may not have mounted when reload resolves. Wait before deciding
  // whether the responsive chat drawer needs to be opened.
  await expect(page.getByLabel('Message Relay', { exact: true })).toBeVisible();
  const show = page.getByRole('button', { name: 'Show chats', exact: true });
  if (await show.isVisible()) await show.click();
  await page.locator('.conversation-list .thread-link').nth(chatIndex).click();
  const restored = page.locator(`audio[src="${url}"]`);
  await expect(restored).toHaveCount(1);
  await expect
    .poll(() => restored.evaluate((a: HTMLAudioElement) => a.readyState))
    .toBeGreaterThan(0);
  await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
    'Keep my next message.',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('only one memo plays; backgrounding pauses it and audio failure keeps the transcript', async ({
  page,
}) => {
  await newChat(page);
  for (const name of ['first', 'second']) {
    const message = await reply(page, `Remember ${name} playback test`);
    await message.getByRole('button', { name: 'Create voice memo', exact: true }).click();
    await expect(message.getByRole('group', { name: 'Voice memo' })).toBeVisible();
  }
  const savedReply = await page
    .locator('.message.assistant')
    .last()
    .locator('.message-bubble')
    .innerText();
  expect(savedReply.trim()).not.toBe('');
  const memos = page.getByRole('group', { name: 'Voice memo' });
  const one = memos.nth((await memos.count()) - 2),
    two = memos.last();
  await one.getByRole('button', { name: 'Play voice memo', exact: true }).click();
  await two.getByRole('button', { name: 'Play voice memo', exact: true }).click();
  await expect
    .poll(() => one.locator('audio').evaluate((a: HTMLAudioElement) => a.paused))
    .toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect
    .poll(() => two.locator('audio').evaluate((a: HTMLAudioElement) => a.paused))
    .toBe(true);
  await page.route('**/api/voice-memos/*/audio', (route) =>
    route.fulfill({ status: 404, body: '' }),
  );
  const chatIndex = await page
    .locator('.conversation-list .thread-link')
    .evaluateAll((els) => els.findIndex((el) => el.getAttribute('aria-current') === 'page'));
  expect(chatIndex).toBeGreaterThanOrEqual(0);
  await page.reload();
  await expect(page.getByLabel('Message Relay', { exact: true })).toBeVisible();
  const show = page.getByRole('button', { name: 'Show chats', exact: true });
  if (await show.isVisible()) await show.click();
  await page.locator('.conversation-list .thread-link').nth(chatIndex).click();
  const last = page.getByRole('group', { name: 'Voice memo' }).last();
  await last.getByRole('button', { name: 'Play voice memo', exact: true }).click();
  await expect(last.getByRole('alert')).toContainText(/unavailable|could not play/);
  await expect(last.locator('details')).toHaveCount(0);
  await expect(page.locator('.message.assistant').last().locator('.message-bubble')).toHaveText(
    savedReply,
  );
  await page.unroute('**/api/voice-memos/*/audio');
  await last.getByRole('button', { name: 'Reload audio', exact: true }).click();
  await expect(last.getByRole('alert')).toBeHidden();
  await expect
    .poll(() => last.locator('audio').evaluate((a: HTMLAudioElement) => a.readyState))
    .toBeGreaterThan(0);
});
test('voice creation errors and cancellation stay inline and allow an explicit retry', async ({
  page,
}) => {
  await newChat(page);
  const message = await reply(page, 'Remember inline memo cancellation');
  let requests = 0;
  await page.route('**/api/messages/*/voice', (route) => {
    requests++;
    return route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Speech is unavailable. Please try again.' }),
    });
  });
  await message.getByRole('button', { name: 'Create voice memo', exact: true }).click();
  await expect(message.getByRole('alert')).toContainText('Speech is unavailable');
  expect(requests).toBe(1);
  await page.unroute('**/api/messages/*/voice');
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/api/messages/*/voice', async (route) => {
    await held;
    await route.abort().catch(() => {});
  });
  await message.getByRole('button', { name: 'Create voice memo', exact: true }).click();
  await expect(message.getByRole('status')).toHaveText('Creating voice…');
  await message.getByRole('button', { name: 'Cancel voice creation', exact: true }).click();
  release();
  await expect(message.getByRole('group', { name: 'Voice memo' })).toHaveCount(0);
  await page.unroute('**/api/messages/*/voice');
  await message.getByRole('button', { name: 'Create voice memo', exact: true }).click();
  await expect(message.getByRole('group', { name: 'Voice memo' })).toBeVisible();
});
