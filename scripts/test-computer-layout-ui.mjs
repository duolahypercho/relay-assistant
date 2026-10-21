// SPDX-License-Identifier: MIT
// Real DOM/OS gestures against a controlled computer boundary, not guest execution.
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { computerLayoutFixture } from './computer-layout-fixture.mjs';

const f = await computerLayoutFixture();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const [width, height, theme] of [
    [390, 844, 'light'],
    [390, 844, 'dark'],
    [320, 568, 'light'],
    [768, 1024, 'light'],
    [1440, 950, 'light'],
  ]) {
    const mobile = width < 1000;
    f.actions.length = 0;
    f.state.controller = 'owner';
    f.state.state = 'running';
    const context = await browser.newContext({
      viewport: { width, height },
      isMobile: mobile,
      hasTouch: mobile,
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(f.url);
    const composer = page.getByLabel('Message Relay', { exact: true });
    const draft = `Unsent ${width} ${theme} draft`;
    await composer.fill(draft);
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('button', { name: 'Computer', exact: true }).click();
    await page.getByRole('button', { name: 'Desktop', exact: true }).click();
    const screen = page.getByRole('button', { name: 'Control private desktop', exact: true });
    await expect(screen).toBeVisible();
    if (theme === 'dark')
      await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
    const metrics = await page.evaluate(() => {
      const box = (selector) => {
        const r = document.querySelector(selector).getBoundingClientRect();
        return { y: r.y, bottom: r.bottom, height: r.height, width: r.width };
      };
      return {
        screen: box('.computer-display'),
        input: box('.computer-input'),
        dock: box('.workspace-page > .chat-dock'),
        teaching: box('.computer-teaching'),
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    assert(!metrics.overflow);
    assert(metrics.screen.y < Math.max(340, height * 0.42), JSON.stringify(metrics));
    assert(metrics.teaching.y > metrics.input.bottom);
    if (height >= 800) assert(metrics.input.bottom <= metrics.dock.y, JSON.stringify(metrics));
    await page.screenshot({
      path: resolve(`../relay-evidence/computer-simplicity-${width}-${theme}.png`),
    });
    assert.deepEqual(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
      [],
    );
    const scroll = page.locator('.workspace-page-scroll');
    const reset = async () => {
      await expect
        .poll(async () => {
          await scroll.evaluate((e) => (e.scrollTop = 0));
          await page.waitForTimeout(150);
          return scroll.evaluate((e) => e.scrollTop);
        })
        .toBe(0);
    };
    async function gesture(from, to) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ ...from, id: 1 }],
      });
      for (let i = 1; i <= 12; i++)
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [
            {
              x: from.x + ((to.x - from.x) * i) / 12,
              y: from.y + ((to.y - from.y) * i) / 12,
              id: 1,
            },
          ],
        });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    }
    const drag = page.getByRole('button', { name: 'Drag on the computer' });
    if (mobile) {
      await expect(drag).toHaveAttribute('aria-pressed', 'false');
      const box = await screen.boundingBox();
      await gesture(
        { x: box.x + box.width / 2, y: box.y + box.height * 0.8 },
        { x: box.x + box.width / 2, y: box.y + box.height * 0.1 },
      );
      await expect.poll(() => scroll.evaluate((e) => e.scrollTop)).toBeGreaterThan(35);
      assert.equal(f.actions.length, 0, 'Page swipe must never click or drag the guest');
      await reset();
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await expect.poll(() => f.actions.filter((a) => a.action === 'click').length).toBe(1);
      await drag.click();
      await reset();
      const b = await screen.boundingBox();
      await gesture(
        { x: b.x + b.width * 0.3, y: b.y + b.height * 0.4 },
        { x: b.x + b.width * 0.7, y: b.y + b.height * 0.6 },
      );
      await expect.poll(() => f.actions.filter((a) => a.action === 'drag').length).toBe(1);
      assert.equal(
        await scroll.evaluate((e) => e.scrollTop),
        0,
        'Explicit drag must stay in guest',
      );
      await drag.click();
    } else {
      await expect(drag).toBeHidden();
      const b = await screen.boundingBox();
      await page.mouse.move(b.x + b.width * 0.3, b.y + b.height * 0.4);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width * 0.7, b.y + b.height * 0.6, { steps: 12 });
      await page.mouse.up();
      await expect.poll(() => f.actions.filter((a) => a.action === 'drag').length).toBe(1);
    }
    await page.getByLabel('Type on the computer', { exact: true }).fill('Hello 你好');
    await page.getByRole('button', { name: 'Type text', exact: true }).click();
    await expect.poll(() => f.actions.find((a) => a.action === 'type')?.text).toBe('Hello 你好');
    await page.getByRole('button', { name: 'Enter', exact: true }).click();
    await expect.poll(() => f.actions.find((a) => a.action === 'key')?.key).toBe('Return');
    if (mobile) {
      await drag.click();
      await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
      await expect(drag).toHaveAttribute('aria-pressed', 'false');
      await expect(drag).toBeDisabled();
      await page.getByRole('button', { name: 'Fit screen', exact: true }).click();
      await expect(drag).toBeEnabled();
      await drag.click();
      await page.getByRole('button', { name: 'Give back to Relay', exact: true }).click();
      await page.getByRole('button', { name: 'Take control', exact: true }).click();
      await expect(drag).toHaveAttribute('aria-pressed', 'false');
      await drag.click();
      await page.getByRole('button', { name: 'Stop computer and keep files', exact: true }).click();
      await page.getByRole('button', { name: 'Start computer', exact: true }).click();
      await expect(drag).toHaveAttribute('aria-pressed', 'false');
    }
    await page.getByRole('button', { name: 'Teach a task', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Close teaching' })).toBeVisible();
    await page.getByRole('button', { name: 'Close teaching' }).click();
    await page.getByText('Commands & activity', { exact: true }).click();
    await expect(page.getByLabel('Private computer command')).toBeVisible();
    await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
    await expect(composer).toHaveValue(draft);
    assert.equal(f.store.read().messages.length, 0);
    assert.deepEqual(errors, []);
    checks.push({
      width,
      height,
      theme,
      metrics,
      gestureAndTyping: true,
      cleanHistoryAndDraft: true,
    });
    console.log('PASS', width, height, theme);
    await context.close();
  }
  await writeFile(
    resolve('../relay-evidence/computer-simplicity-ui.json'),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        checks,
        scope:
          'Production UI and API with controlled computer action sink; real guest execution covered separately.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await f.close();
}
