// SPDX-License-Identifier: MIT
// Soft-keyboard semantics against the production UI and a controlled guest boundary.
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { computerLayoutFixture } from './computer-layout-fixture.mjs';

const evidence = resolve('../relay-evidence/computer-keyboard');
await mkdir(evidence, { recursive: true });
const f = await computerLayoutFixture();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const width of [390, 320, 768]) {
    f.actions.length = 0;
    f.state.controller = 'owner';
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      isMobile: true,
      hasTouch: true,
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(f.url);
    const draft = page.getByLabel('Message Relay', { exact: true });
    await draft.fill('Keep my keyboard test draft.');
    await page.getByRole('button', { name: 'Open computer', exact: true }).first().click();
    await page.getByRole('button', { name: 'Desktop', exact: true }).click();
    const buffered = page.getByLabel('Type on the computer', { exact: true });
    await buffered.fill('Keep this unsent computer text.');
    const show = page.getByRole('button', { name: 'Show computer keyboard', exact: true });
    await show.click();
    const input = page.getByLabel('Type directly on the computer', { exact: true });
    await expect(input).toBeFocused();
    await expect(buffered).toHaveCount(0);
    await expect(page.locator('.topbar')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Back to chat', exact: true })).toBeVisible();
    await page.keyboard.insertText('Hello 🌱');
    await expect
      .poll(() =>
        f.actions
          .filter((a) => a.action === 'type')
          .map((a) => a.text)
          .join(''),
      )
      .toBe('Hello 🌱');
    await input.evaluate((el) =>
      el.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'deleteContentBackward',
        }),
      ),
    );
    await input.evaluate((el) =>
      el.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertLineBreak',
        }),
      ),
    );
    await page.keyboard.press('Backspace');
    await expect
      .poll(() => f.actions.filter((a) => a.action === 'key').map((a) => a.key))
      .toEqual(['BackSpace', 'Return', 'BackSpace']);
    const beforeIME = f.actions.length;
    await input.dispatchEvent('compositionstart', { data: '' });
    await input.fill('\u200bかな');
    await expect(
      page.getByRole('button', { name: 'Give back to Relay', exact: true }),
    ).toBeEnabled();
    assert.equal(f.actions.length, beforeIME, 'Unfinished IME composition must stay local');
    await input.dispatchEvent('compositionend', { data: 'かな' });
    await expect.poll(() => f.actions.at(-1)?.text).toBe('かな');
    assert(
      f.actions.every((a) => !a.text?.includes('\u200b')),
      'Local keyboard sentinel must never reach the guest',
    );
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(input).not.toBeFocused();
    await expect(page.locator('.topbar')).toBeVisible();
    await expect(buffered).toHaveValue('Keep this unsent computer text.');
    await show.click();
    await input.dispatchEvent('compositionstart', { data: '' });
    await input.fill('\u200bAbandoned composition');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await show.click();
    await page.keyboard.insertText('Resumed typing');
    await expect.poll(() => f.actions.at(-1)?.text).toBe('Resumed typing');
    assert(
      !f.actions.some((action) => action.text?.includes('Abandoned')),
      'Closing the keyboard discards unfinished composition',
    );
    await expect(input).toBeFocused();
    await input.dispatchEvent('compositionstart', { data: '' });
    await input.fill('\u200bUnfinished text must stay local.');
    // Owner control changes are observed from the server, not inferred from focus.
    f.state.controller = 'agent';
    await expect(page.getByRole('button', { name: 'Take control', exact: true })).toBeVisible();
    await expect(input).toBeDisabled();
    await expect(input).not.toBeFocused();
    await page.getByRole('button', { name: 'Take control', exact: true }).click();
    await expect(show).toHaveAttribute('aria-pressed', 'false');
    await expect(buffered).toHaveValue('Keep this unsent computer text.');
    assert(
      !f.actions.some((action) => action.text?.includes('Unfinished text')),
      'Lost control discards unfinished composition',
    );
    assert(
      !f.actions.some((action) => action.text === 'Keep this unsent computer text.'),
      'Done and control changes must never submit buffered text',
    );
    await page.screenshot({ path: join(evidence, `keyboard-${width}.png`) });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.deepEqual(
      (await new AxeBuilder({ page }).include('.computer-page').analyze()).violations,
      [],
    );
    await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
    await expect(draft).toHaveValue('Keep my keyboard test draft.');
    assert.equal(f.store.read().messages.length, 0);
    assert.deepEqual(errors, []);
    checks.push({
      width,
      passed: true,
      checks: [
        'direct soft-keyboard entry, Unicode, deletion and Return exactly once',
        'IME stays local until commit; sentinel never leaves device',
        'Done and lost control close the keyboard',
        'unsent text, chat draft and empty history preserved',
        'layout and accessibility',
      ],
    });
    await context.close();
  }
  await writeFile(
    join(evidence, 'keyboard-ui.json'),
    JSON.stringify(
      {
        passed: true,
        checks,
        scope:
          'Production UI with controlled guest calls. Real guest/native acceptance is separate.',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`PASS ${checks.length} keyboard layouts and input journeys`);
} finally {
  await browser.close();
  await f.close();
}
