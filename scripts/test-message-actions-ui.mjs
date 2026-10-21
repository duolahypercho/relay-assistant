// SPDX-License-Identifier: MIT
// Original messenger content; real UI/worker/storage with a controlled local model.
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assistantsFixture } from './assistants-fixture.mjs';
import { appendAssistant } from '../shared/assistant.mjs';
import { command } from '../shared/domain.mjs';
const audit = process.argv.includes('--audit');
const mac = process.argv.includes('--mac');
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence/message-actions');
await mkdir(evidence, { recursive: true });
const browser = mac ? null : await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const width of mac ? [1365] : audit ? [390, 1365] : [320, 390, 720, 1365]) {
    for (const theme of audit ? ['light'] : ['light', 'dark']) {
      const directory = await mkdtemp(join(tmpdir(), 'relay-message-actions-'));
      const f = await assistantsFixture(directory, {
        configure(store) {
          store.mutate((s) => {
            s.profile.theme = theme;
            s.profile.memoryLearning = false;
            const addUser = (id, text) =>
              s.messages.push({
                id,
                role: 'user',
                threadId: 'main',
                text,
                cards: [],
                fileIds: [],
                createdAt: new Date().toISOString(),
              });
            addUser('simple-day', 'Can we keep today simple?');
            appendAssistant(s, 'main', { text: 'Of course. One thing at a time.', cards: [] });
            addUser('walk', 'A walk after lunch sounds good.');
            appendAssistant(s, 'main', {
              text: 'A short walk by the river would be lovely.',
              cards: [],
            });
            command(s, 'thread.update', { id: 'main', draft: 'Keep this thought for later.' });
          });
        },
        respond() {
          return { role: 'assistant', content: 'A little time outside sounds good.' };
        },
      });
      const context = mac
        ? null
        : await browser.newContext({
            viewport: { width, height: 950 },
            isMobile: width < 800,
            hasTouch: width < 800,
            reducedMotion: 'reduce',
            permissions: ['clipboard-read', 'clipboard-write'],
          });
      if (mac) await writeFile(join(directory, 'desktop.json'), JSON.stringify({ server: f.url }));
      const app = mac
        ? await electron.launch({
            executablePath: resolve(
              'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
            ),
            args: [`--relay-test-data=${directory}`],
          })
        : null;
      const page = mac ? await app.firstWindow() : await context.newPage();
      if (mac)
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().forEach((w) => w.hide()),
        );
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const record = { width, theme, audit, mac, passed: false };
      try {
        await page.goto(f.url);
        const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
        await expect(composer).toHaveValue('Keep this thought for later.');
        record.viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        await page.mouse.move(0, 0);
        record.layout = await page.locator('.messages > .message').evaluateAll((items) =>
          items.map((item) => {
            const bounds = (el) => {
              const r = el.getBoundingClientRect();
              return {
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
                bottom: r.bottom,
                right: r.right,
              };
            };
            return {
              message: bounds(item),
              bubble: bounds(item.querySelector('.message-bubble')),
              more: bounds(item.querySelector('.message-more')),
            };
          }),
        );
        record.tokens = await page.evaluate(() => {
          const s = getComputedStyle(document.documentElement);
          return Object.fromEntries(
            ['--surface', '--soft', '--muted', '--ink', 'font-family'].map((p) => [
              p,
              s.getPropertyValue(p),
            ]),
          );
        });
        await page.screenshot({
          path: join(evidence, `${audit ? 'before' : 'after'}-${width}-${theme}.png`),
        });
        if (!audit) {
          // The closed action affordance belongs beside the message, not in a new row.
          for (const { bubble, more } of record.layout) {
            assert(
              more.x >= 0 && more.right <= record.viewport.width,
              'Message action target overflows the viewport',
            );
            if (width < 800) {
              assert(
                more.width >= 44 && more.height >= 44,
                'Phone message actions need a 44px target',
              );
              assert(
                Math.abs(more.y + more.height / 2 - (bubble.y + bubble.height / 2)) <= 1,
                'More belongs alongside its bubble',
              );
            }
          }
          const message = page.locator('.message.assistant').last();
          const more = message.locator('.message-more');
          await more.focus();
          await page.keyboard.press('Enter');
          await expect(more).toHaveAttribute('aria-expanded', 'true');
          await expect(message.getByRole('group', { name: 'React to message' })).toBeVisible();
          assert.equal(await page.getByRole('dialog').count(), 0);
          await message.getByRole('button', { name: 'Copy message', exact: true }).click();
          assert.equal(
            mac
              ? await app.evaluate(({ clipboard }) => clipboard.readText())
              : await page.evaluate(() => navigator.clipboard.readText()),
            'A short walk by the river would be lovely.',
          );
          await expect(composer).toHaveValue('Keep this thought for later.');
          await message.getByRole('button', { name: 'React 👍', exact: true }).click();
          await expect(
            message.getByRole('button', { name: 'Remove 👍 reaction', exact: true }),
          ).toBeVisible();
          await more.click();
          await message.getByRole('button', { name: 'Reply to message', exact: true }).click();
          await expect(page.locator('.reply-preview')).toContainText('A short walk by the river');
          await expect(composer).toHaveValue('Keep this thought for later.');
          await page.getByRole('button', { name: 'Cancel reply', exact: true }).click();
          await more.click();
          await expect(more).toHaveAttribute('aria-expanded', 'true');
          await page.keyboard.press('Escape');
          await expect(more).toHaveAttribute('aria-expanded', 'false');
          await composer.click();
          await expect(message.locator('.message-actions')).toBeHidden();
          assert.equal(
            f.store.read().messages.length,
            4,
            'Controls must not add conversation messages',
          );
          assert.equal(f.requests.length, 0, 'Controls must not invoke a model');
          await page.reload();
          await expect(composer).toHaveValue('Keep this thought for later.');
          assert.equal(
            await page.getByRole('button', { name: 'Remove 👍 reaction', exact: true }).count(),
            1,
          );
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
          assert.deepEqual(
            (
              await new AxeBuilder({ page })
                .setLegacyMode(mac)
                .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
                .analyze()
            ).violations,
            [],
          );
          assert.deepEqual(errors, []);
          await page.screenshot({ path: join(evidence, `verified-${width}-${theme}.png`) });
        }
        record.passed = true;
      } catch (error) {
        record.error = String(error);
        await page
          .screenshot({ path: join(evidence, `failure-${width}-${theme}.png`) })
          .catch(() => {});
        throw error;
      } finally {
        checks.push(record);
        if (app) await app.close();
        else await context.close();
        await f.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
} finally {
  await browser?.close();
  await writeFile(
    join(evidence, `${audit ? 'before' : 'message-actions'}-acceptance.json`),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: checks.length === (mac || audit ? 2 : 8) && checks.every((c) => c.passed),
        scope: mac
          ? 'Packaged Mac connected to an isolated test backend; controlled synthetic chat, real actions/storage and native clipboard. Not live-model or bundled-backend evidence.'
          : 'Controlled synthetic chat; production browser UI, real actions and storage. Not live-model or native-device evidence.',
        checks,
      },
      null,
      2,
    ),
  );
}
