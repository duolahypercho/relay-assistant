// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect as baseExpect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chatReadingFixture } from './chat-reading-fixture.mjs';
const expect = baseExpect.configure({ timeout: 12000 });
const native = process.argv.includes('--mac');
const browser = native
  ? null
  : await chromium.launch({
      channel: process.platform === 'darwin' ? 'chrome' : undefined,
      headless: true,
    });
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence');
await mkdir(evidence, { recursive: true });
const checks = [];
try {
  for (const mobile of native ? [false] : [false, true]) {
    const f = await chatReadingFixture();
    const directory = await mkdtemp(join(tmpdir(), 'relay-reading-client-'));
    const label = native ? 'mac' : mobile ? 'phone' : 'desktop';
    let app, context, page;
    try {
      if (native) {
        await writeFile(join(directory, 'desktop.json'), JSON.stringify({ server: f.url }));
        app = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${directory}`],
        });
        page = await app.firstWindow();
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().forEach((w) => w.hide()),
        );
      } else {
        context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 900 },
          isMobile: mobile,
          hasTouch: mobile,
          reducedMotion: 'reduce',
        });
        page = await context.newPage();
        await page.goto(f.url);
      }
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const composer = () => page.getByRole('textbox', { name: 'Message Relay', exact: true });
      const transcript = () => page.locator('.messages');
      const latest = () => page.getByRole('button', { name: 'Latest messages', exact: true });
      const atLatest = () =>
        transcript().evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
      const record = () =>
        transcript().evaluate((el) => {
          const bounds = el.getBoundingClientRect();
          const target = [...el.querySelectorAll('.message[id]')].find(
            (m) =>
              m.getBoundingClientRect().bottom > bounds.top + 1 &&
              m.getBoundingClientRect().top < bounds.bottom,
          );
          return { id: target.id, offset: target.getBoundingClientRect().top - bounds.top };
        });
      const verify = async (saved) => {
        await expect
          .poll(() =>
            transcript().evaluate(
              (el, saved) =>
                Math.abs(
                  document.getElementById(saved.id).getBoundingClientRect().top -
                    el.getBoundingClientRect().top -
                    saved.offset,
                ),
              saved,
            ),
          )
          .toBeLessThan(4);
        await expect(latest()).toBeVisible();
      };
      const older = async (distance) => {
        await transcript().hover();
        await page.mouse.wheel(0, -distance);
        await expect(latest()).toBeVisible();
        await expect.poll(atLatest).toBeGreaterThan(distance / 2);
        // Browser wheel dispatch completes asynchronously; wait for a settled reading position.
        let last = -1,
          stable = 0;
        await expect
          .poll(async () => {
            const next = await transcript().evaluate((el) => el.scrollTop);
            stable = Math.abs(next - last) < 1 ? stable + 1 : 0;
            last = next;
            return stable;
          })
          .toBeGreaterThan(1);
      };
      const switchChat = async (name) => {
        const sidebar = page.locator('#chat-sidebar');
        if (!(await sidebar.isVisible()))
          await page.getByRole('button', { name: 'Show chats', exact: true }).click();
        await sidebar.getByRole('button', { name, exact: true }).click();
        if (await sidebar.isVisible())
          await sidebar.getByRole('button', { name: 'Hide chats', exact: true }).click();
      };
      await expect(composer()).toHaveValue('Keep the main draft');
      await expect.poll(atLatest).toBeLessThan(2);
      await older(1500);
      const main = await record();
      await switchChat('Reading side chat');
      await expect(composer()).toHaveValue('Keep the side draft');
      await older(950);
      const side = await record();
      await switchChat('Main chat');
      await verify(main);
      await switchChat('Reading side chat');
      await verify(side);
      await switchChat('Main chat');
      await verify(main);
      await page.getByRole('button', { name: 'Files', exact: true }).click();
      f.addMessage();
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(
        page.getByText('A new result arrived while you were reading.', { exact: true }),
      ).toBeAttached();
      await verify(main);
      await page.reload();
      await expect(composer()).toHaveValue('Keep the main draft');
      await verify(main);
      // Explicit message links/search targets win over a saved reading position.
      await page.goto(f.url + '/#chat/main/reading-main-03');
      await expect
        .poll(() =>
          page
            .locator('#message-reading-main-03')
            .evaluate((el) =>
              Math.abs(
                el.getBoundingClientRect().top -
                  document.querySelector('.messages').getBoundingClientRect().top,
              ),
            ),
        )
        .toBeLessThan(4);
      await latest().click();
      await expect.poll(atLatest).toBeLessThan(2);
      await switchChat('Reading side chat');
      await verify(side);
      await switchChat('Main chat');
      await expect.poll(atLatest).toBeLessThan(2);
      await older(1200);
      const restart = await record();
      await page.getByRole('button', { name: 'Files', exact: true }).click(); // Flush and background the transcript.
      if (native) {
        await app.close();
        app = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${directory}`],
        });
        page = await app.firstWindow();
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().forEach((w) => w.hide()),
        );
      } else {
        // A new window has no sessionStorage; it restores the device-local copy.
        await page.close();
        page = await context.newPage();
        await page.goto(f.url);
      }
      await expect(composer()).toHaveValue('Keep the main draft');
      await verify(restart);
      const audit = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']);
      if (native) audit.setLegacyMode();
      const a11y = await audit.analyze();
      expect(a11y.violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(f.store.read().messages.length).toBe(65);
      expect(errors).toEqual([]);
      await page.screenshot({ path: join(evidence, `chat-reading-${label}.png`) });
      f.store.mutate((state) => {
        state.threads[0].createdAt = new Date().toISOString();
        state.threads[0].draft = 'A different workspace';
      });
      await expect(composer()).toHaveValue('A different workspace');
      await expect.poll(atLatest).toBeLessThan(2);

      checks.push({
        surface: label,
        passed: true,
        main,
        side,
        restart,
        checks: [
          'independent Main/side reading anchors',
          'separate page and background result',
          'reload',
          'explicit message target',
          'Latest restores live following',
          native ? 'full Mac quit/relaunch' : 'new window local recovery',
          'unchanged drafts and no navigation messages',
          'a replacement workspace does not inherit the old reading position',
          'no tested accessibility violations or overflow',
        ],
      });
    } finally {
      await app?.close();
      await context?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, `chat-reading-${native ? 'mac' : 'ui'}-acceptance.json`),
    JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), checks }, null, 2) + '\n',
  );
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} finally {
  await browser?.close();
}
