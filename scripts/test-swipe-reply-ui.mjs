import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { swipeReplyFixture, question, draft, answer } from './swipe-reply-fixture.mjs';

const mac = process.argv.includes('--mac');
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const browser = mac ? null : await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const mobile of mac ? [false] : process.argv.includes('--phone') ? [true] : [false, true]) {
    const surface = mac ? 'native-mac' : mobile ? 'phone' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-swipe-reply-'));
    const f = await swipeReplyFixture(directory);
    let app, context, page;
    try {
      if (mac) {
        const data = join(directory, 'desktop');
        await mkdir(data);
        await writeFile(join(data, 'desktop.json'), JSON.stringify({ server: f.url }));
        app = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${data}`],
        });
        context = app.context();
        page = await app.firstWindow();
      } else {
        context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 950 },
          isMobile: mobile,
          hasTouch: mobile,
          reducedMotion: 'reduce',
        });
        page = await context.newPage();
        await page.goto(f.url);
      }
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
      const original = page.locator(`#message-${f.original.id}`);
      const bubble = original.locator('.message-bubble');
      const quote = page.locator('.reply-preview');
      const attachments = page.getByRole('group', { name: 'Draft attachments', exact: true });
      await expect(composer).toHaveValue(draft);
      await expect(attachments).toContainText('Picnic note.txt');
      const before = f.store.read().messages;
      const cdp = mobile ? await context.newCDPSession(page) : null;
      async function gesture(target, dx, dy = 0, options = {}) {
        await target.scrollIntoViewIfNeeded();
        // A prior native scroll can still be decelerating after its finger lifts.
        await target.evaluate(async (el) => {
          let last = NaN,
            stable = 0;
          for (let i = 0; i < 120 && stable < 10; i++) {
            await new Promise(requestAnimationFrame);
            const y = el.getBoundingClientRect().y;
            stable = Math.abs(y - last) < 0.1 ? stable + 1 : 0;
            last = y;
          }
        });
        const box = await target.boundingBox();
        const x = Math.max(30, box.x + Math.min(box.width * 0.3, 70));
        const y = box.y + box.height * 0.5;
        const point = (step) => ({ x: x + dx * step, y: y + dy * step, id: 1 });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(0)] });
        if (options.hold) await new Promise((r) => setTimeout(r, 450));
        for (let i = 1; i <= 8; i++) {
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [point(i / 8), ...(options.multi ? [{ x: x + 8, y: y + 30, id: 2 }] : [])],
          });
          await new Promise((r) => setTimeout(r, 18));
        }
        if (options.inspect) await options.inspect();
        if (options.retract)
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [point(0.1)],
          });
        await cdp.send('Input.dispatchTouchEvent', {
          type: options.cancel ? 'touchCancel' : 'touchEnd',
          touchPoints: [],
        });
      }
      async function cancelReply() {
        await page.getByRole('button', { name: 'Cancel reply', exact: true }).click();
        await expect(quote).toHaveCount(0);
        await expect(composer).toHaveValue(draft);
        await expect(attachments.locator('.attachment-item')).toHaveCount(1);
      }
      if (mobile) {
        await gesture(bubble, 30);
        await expect(quote).toHaveCount(0);
        await gesture(bubble, -55);
        await expect(quote).toHaveCount(0);
        for (const options of [
          { retract: true },
          { cancel: true },
          { multi: true },
          { hold: true },
        ]) {
          await gesture(bubble, 95, 0, options);
          await expect(quote).toHaveCount(0);
          if (options.hold) {
            await composer.tap();
            await composer.press('ArrowRight');
          }
        }
        const messages = page.locator('.messages');
        const scrollBefore = await messages.evaluate((el) => el.scrollTop);
        await gesture(bubble, 8, 130);
        await expect(quote).toHaveCount(0);
        expect(await messages.evaluate((el) => el.scrollTop)).toBeLessThan(scrollBefore - 20);
        // Embedded horizontal content and links keep their own touch behavior.
        await gesture(page.locator('.message-bubble pre'), -80);
        expect(
          await page.locator('.message-bubble pre').evaluate((el) => el.scrollLeft),
        ).toBeGreaterThan(20);
        await expect(quote).toHaveCount(0);
        await gesture(page.getByRole('link', { name: 'picnic guide' }), 90);
        await expect(quote).toHaveCount(0);
        await gesture(bubble, 95, 0, {
          inspect: async () => {
            await expect(bubble).toHaveAttribute('data-swipe', 'ready');
            await page.screenshot({ path: join(evidence, `swipe-reply-gesture-${surface}.png`) });
            expect(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            ).toBe(true);
          },
        });
        await expect(quote).toContainText(question);
        await expect(composer).toBeFocused();
        await cancelReply();
        await gesture(page.locator(`#message-${f.outgoing.id} .message-bubble`), 80);
        await expect(quote).toContainText('Replying to your message');
        await cancelReply();
        await gesture(bubble, 85);
      } else {
        await bubble.scrollIntoViewIfNeeded();
        const box = await bubble.boundingBox();
        await page.mouse.move(box.x + 20, box.y + 15);
        await page.mouse.down();
        await page.mouse.move(box.x + 130, box.y + 15, { steps: 10 });
        await page.mouse.up();
        await expect(quote).toHaveCount(0);
        await original.getByRole('button', { name: 'Message actions', exact: true }).click();
        await original
          .getByRole('button', { name: 'Reply to message', exact: true })
          .press('Enter');
      }
      await expect(quote).toContainText(question);
      await expect(composer).toBeFocused();
      await expect(composer).toHaveValue(draft);
      await expect(attachments.locator('.attachment-item')).toHaveCount(1);
      expect(f.store.read().messages).toEqual(before);
      expect(f.requests).toHaveLength(0);
      await page.screenshot({
        path: join(evidence, `swipe-reply-draft-${surface}.png`),
        animations: 'disabled',
      });
      expect((await new AxeBuilder({ page }).setLegacyMode(mac).analyze()).violations).toEqual([]);
      // Navigation remains a separate page and does not send the reply.
      await page
        .getByRole('navigation', { name: 'Workspace shortcuts' })
        .getByRole('button', { name: 'Files', exact: true })
        .click();
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(quote).toContainText(question);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(page.locator('.messages').getByText(answer, { exact: true })).toBeVisible({
        timeout: 30000,
      });
      await expect(quote).toHaveCount(0);
      const sent = f.store.read().messages.find((m) => m.quoted?.id === f.original.id);
      expect(sent.text).toBe(draft);
      expect(sent.fileIds).toEqual([f.file.id]);
      expect(f.errors).toEqual([]);
      expect(f.requests).toHaveLength(1);
      await page.screenshot({
        path: join(evidence, `swipe-reply-sent-${surface}.png`),
        animations: 'disabled',
      });
      // The same gesture uses the existing original-author routing in a group.
      await page.getByRole('button', { name: 'Show chats', exact: true }).click();
      await page
        .locator('#chat-sidebar')
        .getByRole('button', { name: 'Picnic planning', exact: true })
        .click();
      const groupRoot = page.locator(`#message-${f.groupMessage.id}`);
      if (mobile) await gesture(groupRoot.locator('.message-bubble'), 90);
      else {
        await groupRoot.getByRole('button', { name: 'Message actions', exact: true }).click();
        await groupRoot.getByRole('button', { name: 'Reply to message', exact: true }).click();
      }
      await expect(quote).toContainText('Replying to Pip');
      await page.locator('.composer textarea').fill('Please share it.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(
        page.locator('.messages').getByText('Pip: Your checklist is ready.', { exact: true }),
      ).toBeVisible();
      const groupSent = f.store.read().messages.find((m) => m.quoted?.id === f.groupMessage.id);
      expect(groupSent.recipientIds).toEqual([f.pip.id]);
      expect(f.errors).toEqual([]);
      expect(errors).toEqual([]);
      checks.push({
        surface,
        passed: true,
        checks: mobile
          ? [
              'trusted browser touch events',
              'threshold, reverse, cancellation, multitouch, long press',
              'vertical and code scrolling, links',
              'incoming and outgoing quote',
              'draft, attachment, no implicit send',
              'real quoted HTTP model context',
              'group author routing',
              'reduced motion, accessibility, viewport fit',
            ]
          : [
              'mouse selection',
              'keyboard reply action',
              'draft and attachment preservation',
              'real quoted HTTP model context',
              'group author routing',
              'accessibility',
            ],
      });
    } finally {
      if (app) await app.close();
      else await context?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, `swipe-reply-${mac ? 'native-mac' : 'ui'}-acceptance.json`),
    JSON.stringify({ checkedAt: new Date().toISOString(), passed: true, checks }, null, 2),
  );
  console.log(JSON.stringify(checks, null, 2));
} finally {
  await browser?.close();
}
