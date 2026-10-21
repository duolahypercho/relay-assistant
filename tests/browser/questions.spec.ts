import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
test.setTimeout(60000);
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence');
const question = (page: Page) =>
  page.getByRole('group', { name: 'What matters most for this plan?', exact: true });
async function reopen(page: Page) {
  await page.reload();
  await page.getByRole('button', { name: 'Show chats', exact: true }).click();
  await page
    .locator('#chat-sidebar .conversation-list')
    .getByRole('button', { name: /Help me plan my week/ })
    .first()
    .click();
}
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Show chats', exact: true }).click();
  await page.getByRole('button', { name: 'New side chat', exact: true }).click();
  await page.getByLabel('Message Relay', { exact: true }).fill('Help me plan my week');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(question(page)).toBeVisible();
});
test('inline decisions survive reload, preserve the main draft and continue once without a dialog', async ({
  page,
}, info) => {
  const input = page.getByLabel('Message Relay', { exact: true });
  await input.fill('Keep this unrelated idea for later');
  await expect(question(page).getByRole('button')).toHaveCount(5);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await reopen(page);
  await expect(input).toHaveValue('Keep this unrelated idea for later');
  await expect(question(page)).toBeVisible();
  const assistantName = await page
    .getByRole('button', { name: 'Open assistant details', exact: true })
    .locator('strong')
    .innerText();
  await page.keyboard.press('ControlOrMeta+k');
  await page
    .getByLabel('Search your workspace', { exact: true })
    .fill('What matters most for this plan?');
  await page
    .getByRole('dialog')
    .getByRole('button')
    .filter({ hasText: 'What matters most for this plan?' })
    .filter({ has: page.locator('small').filter({ hasText: ` · ${assistantName}` }) })
    .last()
    .click();
  await expect(page.locator('.search-match')).toContainText('What matters most for this plan?');
  await expect(input).toHaveValue('Keep this unrelated idea for later');
  await mkdir(evidence, { recursive: true });
  await question(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(evidence, `inline-question-${info.project.name}.png`) });
  await question(page)
    .getByRole('button', { name: /^Make time to rest/ })
    .click();
  await expect(question(page)).toContainText('Answered · Make time to rest');
  await expect(input).toHaveValue('Keep this unrelated idea for later');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(page.locator('.chat-task-card')).toHaveCount(1);
  await expect(page.locator('.chat-task-card')).toContainText('Completed', { timeout: 20000 });
  await page.locator('.chat-task-card .attachment-button').click();
  await expect(page.getByRole('region', { name: 'File preview', exact: true })).toContainText(
    'Make time to rest',
  );
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await reopen(page);
  await expect(question(page)).toContainText('Answered · Make time to rest');
  await expect(page.locator('.chat-task-card')).toHaveCount(1);
  await expect(input).toHaveValue('Keep this unrelated idea for later');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('custom answers and dismissal stay inline; answers are plain text and dismissal starts no work', async ({
  page,
}) => {
  await question(page).getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(question(page)).toContainText('Dismissed · no answer sent');
  await expect(page.locator('.chat-task-card')).toHaveCount(0);
  const input = page.getByLabel('Message Relay', { exact: true });
  await input.fill('Help me plan my week');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(question(page)).toHaveCount(2);
  await question(page).last().getByLabel('Your own answer').fill('/Keep Friday free for a walk');
  await question(page).last().getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(question(page).last()).toContainText('Answered · /Keep Friday free for a walk');
  await expect(page.locator('.chat-task-card')).toHaveCount(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('dialog[open]')).toHaveCount(0);
});
test('failed answer saves stay in the card and can be retried without losing text', async ({
  page,
}, info) => {
  test.skip(
    !info.project.name.startsWith('decisions-'),
    'HTTP failure applies to the self-hosted interface.',
  );
  let failed = false;
  await page.route('**/api/command', async (route) => {
    const body = route.request().postDataJSON();
    if (body.action === 'question.answer' && !failed) {
      failed = true;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Connection interrupted. Try your answer again.' }),
      });
    }
    return route.continue();
  });
  await question(page).getByLabel('Your own answer').fill('Keep Saturday open');
  await question(page).getByRole('button', { name: 'Send answer' }).click();
  await expect(question(page).getByRole('alert')).toContainText('Connection interrupted');
  await expect(question(page).getByLabel('Your own answer')).toHaveValue('Keep Saturday open');
  await reopen(page);
  await expect(question(page).getByLabel('Your own answer')).toHaveValue('Keep Saturday open');
  await question(page).getByRole('button', { name: 'Send answer' }).click();
  await expect(question(page)).toContainText('Answered · Keep Saturday open');
  await expect(page.locator('.chat-task-card')).toHaveCount(1);
});

test('unfinished answers survive navigation and reload independently of the composer', async ({
  page,
}) => {
  const input = page.getByLabel('Message Relay', { exact: true });
  await input.fill('Keep my separate thought');
  await question(page).getByLabel('Your own answer').fill('Let me think about Friday');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await expect(question(page).getByLabel('Your own answer')).toHaveValue(
    'Let me think about Friday',
  );
  await reopen(page);
  await expect(input).toHaveValue('Keep my separate thought');
  await expect(question(page).getByLabel('Your own answer')).toHaveValue(
    'Let me think about Friday',
  );
  const recovered = question(page).getByLabel('Your own answer');
  await recovered.focus();
  await expect
    .poll(() => recovered.evaluate((el: HTMLInputElement) => el.selectionStart))
    .toBe('Let me think about Friday'.length);
  await recovered.pressSequentially(' after lunch');
  await expect(recovered).toHaveValue('Let me think about Friday after lunch');
  await recovered.press(process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home');
  await recovered.pressSequentially('Maybe ');
  await expect(recovered).toHaveValue('Maybe Let me think about Friday after lunch');
  await question(page).getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(question(page)).toContainText('Dismissed · no answer sent');
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((k) => k.startsWith('relay-question-answer:')),
    ),
  ).toEqual([]);
  await input.fill('Help me plan my week');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(question(page)).toHaveCount(2);
  await expect(question(page).last().getByLabel('Your own answer')).toHaveValue('');
});

test('blocked device storage does not prevent answering', async ({ page }) => {
  await page.evaluate(() => {
    Storage.prototype.getItem = () => {
      throw new DOMException('Storage blocked', 'SecurityError');
    };
    Storage.prototype.setItem = () => {
      throw new DOMException('Storage blocked', 'SecurityError');
    };
    Storage.prototype.removeItem = () => {
      throw new DOMException('Storage blocked', 'SecurityError');
    };
  });
  await question(page).getByLabel('Your own answer').fill('Keep Sunday open');
  await question(page).getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(question(page)).toContainText('Answered · Keep Sunday open');
  await expect(page.locator('.chat-task-card')).toHaveCount(1);
});
