import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PDFDocument } from 'pdf-lib';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const evidence = process.env.RELAY_EVIDENCE_DIR
  ? resolve(process.env.RELAY_EVIDENCE_DIR)
  : resolve('..', 'relay-evidence');
async function navigate(page: Page, name: string) {
  if (name === 'ME Your profile Make yourself at home') {
    const menu = page.getByRole('button', { name: 'Show chats', exact: true });
    await expect(menu).toBeVisible();
    await menu.click();
    await page.getByRole('button', { name: 'Your profile', exact: true }).click();
    return;
  }
  const routes: Record<string, string> = {
    Activity: 'Tasks',
    Routines: 'Routines',
    Skills: 'Skills',
    Ideas: 'Ideas',
    'Goals & tracking': 'Goals',
    Files: 'Files',
    Finance: 'Spending',
    Mail: 'Mail',
    Calendar: 'Calendar',
    Computer: 'Computer',
  };
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByLabel('Search your workspace', { exact: true }).fill(routes[name]);
  await page.getByRole('button', { name: `${routes[name]} Open page`, exact: true }).click();
  await expect(page.locator('.workspace-page')).toBeVisible();
  await expect(page.locator('.inline-loading')).toHaveCount(0);
  await expect(page.getByLabel('Message Relay', { exact: true })).toBeHidden();
}
async function readSample(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('relay-sample', 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const value = await new Promise<any>((resolve, reject) => {
      const r = db.transaction('workspace').objectStore('workspace').get('state');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    db.close();
    return value;
  });
}
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Message Relay', { exact: true })).toBeVisible();
});

test('one main chat opens by default, with optional side chats in a collapsible sidebar', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const input = page.getByLabel('Message Relay', { exact: true });
  const sidebar = page.locator('#chat-sidebar');
  const show = page.getByRole('button', { name: 'Show chats', exact: true });
  await expect(page.getByRole('heading', { name: 'Main chat', exact: true })).toBeVisible();
  await expect(sidebar).toBeHidden();
  await input.fill('Keep my main-chat thought');
  await expect
    .poll(async () => (await readSample(page))?.threads.find((t: any) => t.id === 'main')?.draft)
    .toBe('Keep my main-chat thought');
  expect((await readSample(page)).threads).toHaveLength(1);
  await show.click();
  await expect(sidebar).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'Main chat', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(sidebar.getByRole('heading', { name: 'Side chats', exact: true })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'New side chat', exact: true })).toHaveText(
    'New side chat',
  );
  await expect(sidebar.getByRole('heading', { name: 'Assistants', exact: true })).toHaveCount(0);
  await mkdir(evidence, { recursive: true });
  await page.screenshot({
    path: resolve(evidence, `simpler-chats-${info.project.name}.png`),
    animations: 'disabled',
  });
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(show).toBeFocused();
  await expect(sidebar).toBeHidden();
  await expect(input).toHaveValue('Keep my main-chat thought');
  await show.click();
  await page.getByRole('button', { name: 'New side chat', exact: true }).click();
  await expect(sidebar).toBeHidden();
  await expect(page.getByRole('heading', { name: 'New side chat', exact: true })).toBeVisible();
  await expect(input).toBeFocused();
  await input.fill('A thought just for this side chat');
  await expect
    .poll(async () => (await readSample(page)).threads.find((t: any) => t.id !== 'main').draft)
    .toBe('A thought just for this side chat');
  await page.getByRole('button', { name: 'Back to main chat', exact: true }).click();
  await expect(input).toHaveValue('Keep my main-chat thought');
  await show.click();
  await expect(sidebar.getByRole('button', { name: 'Main chat', exact: true })).toHaveCount(1);
  await sidebar
    .locator('.conversation-list')
    .getByRole('button', { name: 'New side chat', exact: true })
    .click();
  await expect(input).toHaveValue('A thought just for this side chat');
  await page.getByRole('button', { name: 'Conversation options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Archive conversation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Main chat', exact: true })).toBeVisible();
  await show.click();
  await page.getByRole('button', { name: 'Show archived side chats', exact: true }).click();
  await expect(
    sidebar.getByRole('heading', { name: 'Archived side chats', exact: true }),
  ).toBeVisible();
  await sidebar.getByRole('button', { name: 'Restore New side chat', exact: true }).click();
  await expect(input).toHaveValue('A thought just for this side chat');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'New side chat', exact: true })).toBeVisible();
  await expect(input).toHaveValue('A thought just for this side chat');
  await page.getByRole('button', { name: 'Back to main chat', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Main chat', exact: true })).toBeVisible();
  await expect(input).toHaveValue('Keep my main-chat thought');
  await expect(sidebar).toBeHidden();
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: resolve(evidence, `main-chat-${info.project.name}.png`) });
  await show.click();
  await page.screenshot({ path: resolve(evidence, `side-chats-${info.project.name}.png`) });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('anime companion responds to touch, stays out of the composer and remembers quiet mode', async ({
  page,
}, info) => {
  const character = page.getByRole('button', { name: 'Say hello to Relay', exact: true });
  const rail = page.getByRole('group', { name: 'Your companion', exact: true });
  const input = page.getByLabel('Message Relay', { exact: true });
  await expect(character).toBeVisible();
  const header = (await page.locator('.topbar').boundingBox())!;
  const characterAtStart = (await character.boundingBox())!;
  expect(characterAtStart.y).toBeGreaterThanOrEqual(header.y);
  expect(characterAtStart.y + characterAtStart.height).toBeLessThanOrEqual(
    header.y + header.height,
  );
  await character.click();
  await expect(character).toHaveAttribute('data-pose', 'wave');
  await expect(character.locator('.companion-heart')).toBeVisible();
  await input.fill('Keep this thought while I move the companion');
  await page.getByRole('button', { name: 'Pause companion', exact: true }).click();
  await expect(rail).toHaveAttribute('data-motion', 'quiet');
  for (const target of [
    { x: 2, y: 2 },
    { x: page.viewportSize()!.width - 2, y: page.viewportSize()!.height - 2 },
  ]) {
    const start = (await character.boundingBox())!;
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 6 });
    await page.mouse.up();
    const actual = (await character.boundingBox())!;
    const lane = (await page.locator('.companion-lane').boundingBox())!;
    const composer = (await page.locator('.composer').boundingBox())!;
    expect(actual.x).toBeGreaterThanOrEqual(lane.x - 1);
    expect(actual.y).toBeGreaterThanOrEqual(lane.y - 1);
    expect(actual.x + actual.width).toBeLessThanOrEqual(lane.x + lane.width + 1);
    expect(actual.y + actual.height).toBeLessThanOrEqual(composer.y);
  }
  await expect(input).toHaveValue('Keep this thought while I move the companion');
  await expect
    .poll(async () => (await readSample(page))?.threads[0]?.draft)
    .toBe('Keep this thought while I move the companion');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Wake companion', exact: true })).toBeVisible();
  await expect(rail).toHaveAttribute('data-motion', 'quiet');
  const before = (await character.boundingBox())!;
  await character.press('ArrowRight');
  expect((await character.boundingBox())!.x).toBeGreaterThan(before.x);
  await expect(character.locator('.sprout-character')).not.toHaveClass(/has-frames/);
  await character.press('Enter');
  await expect(character).toHaveAttribute('data-pose', 'wave');
  await expect
    .poll(() =>
      character
        .locator('.sprout-character')
        .evaluate((element) => getComputedStyle(element).animationName),
    )
    .not.toBe('none');
  await expect(character).toHaveAttribute('data-pose', 'idle');
  await expect
    .poll(() =>
      character
        .locator('.sprout-character')
        .evaluate((element) => getComputedStyle(element).animationName),
    )
    .toBe('none');
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: resolve(evidence, `anime-companion-${info.project.name}.png`) });
});

test('companion walks on its own and respects reduced motion', async ({ page }) => {
  const character = page.getByRole('button', { name: 'Say hello to Relay', exact: true });
  const original = (await character.boundingBox())!;
  await expect
    .poll(async () => Math.abs((await character.boundingBox())!.x - original.x), { timeout: 8000 })
    .toBeGreaterThan(10);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.getByRole('group', { name: 'Your companion', exact: true })).toHaveAttribute(
    'data-motion',
    'quiet',
  );
  await expect
    .poll(() =>
      character
        .locator('.sprout-character')
        .evaluate((element) => getComputedStyle(element).animationName),
    )
    .toBe('none');
  const stopped = (await character.boundingBox())!;
  await page.clock.install();
  await page.clock.fastForward(12000);
  expect((await character.boundingBox())!.x).toBeCloseTo(stopped.x, 0);
  await character.press('Enter');
  await expect(character).toHaveAttribute('data-pose', 'wave');
  await expect(character.locator('.companion-heart')).toBeVisible();
});

test('compact chat keeps reading space, shows its jump control only away from the latest reply, and fits a narrow phone', async ({
  page,
}, info) => {
  test.setTimeout(90000);
  const input = page.getByLabel('Message Relay', { exact: true });
  const latest = page.getByRole('button', { name: 'Latest messages', exact: true });
  const transcript = page.locator('.messages');
  await expect(latest).toHaveCount(0);
  for (let i = 0; i < 3; i++) {
    await input.fill(
      `A note about project ${i}. ` +
        'I am comparing a few possibilities before making a decision. '.repeat(12),
    );
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await readSample(page)).runs.filter((r: any) => r.status === 'completed').length,
      )
      .toBe(i + 1);
  }
  await expect(latest).toHaveCount(0);
  await transcript.hover();
  await page.mouse.wheel(0, -10000);
  await expect(latest).toBeVisible();
  await latest.click();
  await expect(latest).toHaveCount(0);
  await expect
    .poll(() => transcript.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThan(2);
  const pane = (await transcript.boundingBox())!;
  expect(pane.height / page.viewportSize()!.height).toBeGreaterThan(0.62);
  const area = (await page.locator('.composer-wrap').boundingBox())!;
  expect(area.height).toBeLessThan(125);
  await input.fill('Preserve this while I open details');
  await page.getByRole('button', { name: 'Open assistant details', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Your assistant', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(input).toHaveValue('Preserve this while I open details');
  if (info.project.name === 'desktop') {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.getByRole('button', { name: 'Show chats', exact: true }).click();
    await page.screenshot({ path: resolve(evidence, 'compact-chat-tablet.png') });
  } else {
    await page.setViewportSize({ width: 320, height: 640 });
    const pause = (await page
      .getByRole('button', { name: 'Pause companion', exact: true })
      .boundingBox())!;
    const mode = (await page
      .getByRole('button', { name: 'Sample mode', exact: true })
      .boundingBox())!;
    expect(pause.x + pause.width).toBeLessThanOrEqual(mode.x);
    await page.screenshot({ path: resolve(evidence, 'compact-chat-small-phone.png') });
  }
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('messenger creates a context memory and keeps the composer at the bottom', async ({
  page,
}, info) => {
  await page
    .getByLabel('Message Relay', { exact: true })
    .fill('Remember Friday afternoons are for reading');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Memory saved', { exact: true })).toBeVisible();
  const input = page.getByLabel('Message Relay', { exact: true });
  const box = await input.boundingBox();
  expect(box!.y).toBeLessThan(info.project.use.viewport!.height);
  expect(box!.y).toBeGreaterThan(300);
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: resolve(evidence, `messenger-${info.project.name}.png`) });
  await navigate(page, 'ME Your profile Make yourself at home');
  await page.getByRole('button', { name: 'Memory', exact: true }).click();
  await expect(page.getByText('Friday afternoons are for reading', { exact: true })).toBeVisible();
});
test('document request fills a real PDF, displays its canvas, and sends only after an inline chat review', async ({
  page,
}, info) => {
  await page
    .getByRole('button', {
      name: 'Take care of a form',
      exact: true,
    })
    .click();
  await expect(page.getByLabel('Participant name', { exact: true })).toBeVisible();
  const firstField = await page.getByLabel('Participant name', { exact: true }).boundingBox();
  const transcript = await page.locator('.messages').boundingBox();
  expect(firstField!.y).toBeGreaterThanOrEqual(transcript!.y);
  await page.getByLabel('Participant name', { exact: true }).fill('Jamie Example');
  await page.getByLabel('Contact number', { exact: true }).fill('555-0100');
  await page.getByLabel('Access needs (optional)', { exact: true }).fill('None');
  await page.getByRole('button', { name: 'Continue with these details', exact: true }).click();
  await page.getByRole('button', { name: 'Open the filled PDF', exact: true }).click();
  const file = page.getByRole('region', { name: 'File preview', exact: true });
  await expect(file.locator('canvas')).toBeVisible();
  await expect(file.getByText('Rendering document…', { exact: true })).toHaveCount(0);
  await expect(file.getByRole('link', { name: 'Download', exact: true })).toHaveAttribute(
    'href',
    /^blob:/,
  );
  const downloadPromise = page.waitForEvent('download');
  await file.getByRole('link', { name: 'Download', exact: true }).click();
  const downloaded = await downloadPromise;
  const path = info.outputPath('filled-permission.pdf');
  await downloaded.saveAs(path);
  const pdf = await PDFDocument.load(await readFile(path));
  expect(pdf.getForm().getTextField('participant').getText()).toBe('Jamie Example');
  expect(pdf.getForm().getTextField('contact').getText()).toBe('555-0100');
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: resolve(evidence, `filled-pdf-${info.project.name}.png`) });
  await file.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.screenshot({ path: resolve(evidence, `messenger-form-${info.project.name}.png`) });
  expect((await readSample(page)).mail.filter((m: any) => m.folder === 'sent')).toHaveLength(0);
  await page.getByRole('button', { name: 'Approve sample reply', exact: true }).click();
  await expect.poll(async () => (await readSample(page)).approvals[0].status).toBe('completed');
  await navigate(page, 'Mail');
  await page.getByRole('button', { name: 'Sent 1', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Your mail', exact: true }).getByRole('heading', {
      name: 'Re: A day at the Riverbank Field Lab',
      exact: true,
    }),
  ).toBeVisible();
});
test('CSV imports quoted merchants, calculates real cents, and keeps the prior data after an invalid import', async ({
  page,
}, info) => {
  await navigate(page, 'Finance');
  await expect(page.getByText('$4,650.00', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Paste CSV', exact: true }).click();
  await page.getByLabel('Import name', { exact: true }).fill('A tiny import');
  await page
    .getByLabel('Transaction CSV', { exact: true })
    .fill('date,description,amount\n2026-10-01,Income,35.00\n2026-10-02,"Coffee, breakfast",-4.21');
  await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
  await expect(page.locator('.metric.highlighted strong')).toHaveText('$30.79');
  await expect(page.getByText('Coffee, breakfast', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Paste CSV', exact: true }).click();
  await page
    .getByLabel('Transaction CSV', { exact: true })
    .fill('date,description,amount\n2026-02-30,Bad,-1');
  await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('valid date');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.reload();
  await expect(page.locator('.metric.highlighted strong')).toHaveText('$30.79');
  await mkdir(evidence, { recursive: true });
  await page.screenshot({
    path: resolve(evidence, `finance-${info.project.name}.png`),
    fullPage: true,
  });
});
test('task lifecycle pauses, cancels, retries and produces a saved Markdown result', async ({
  page,
}, info) => {
  const stoppedAt = new Date('2026-10-08T12:00:00Z');
  await page.clock.install({ time: new Date(stoppedAt.getTime() - 60000) });
  await page.clock.pauseAt(stoppedAt);
  await navigate(page, 'Activity');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: resolve(evidence, `inline-task-start-${info.project.name}.png`) });
  await page.getByLabel('What needs to get done?', { exact: true }).fill('Plan a quiet afternoon');
  await page.getByText('Add context or choose the kind of work', { exact: true }).click();
  await page
    .getByLabel('A little context', { exact: true })
    .fill('Make time for a river walk and reading.');
  await page.getByRole('button', { name: 'Start task', exact: true }).click();
  await page.getByRole('button', { name: 'Pause task', exact: true }).click();
  await expect(page.locator('.task-detail-meta .status')).toHaveText(/Paused/);
  await page.getByRole('button', { name: 'Cancel task', exact: true }).click();
  await expect(page.locator('.task-detail-meta .status')).toHaveText(/Cancelled/);
  await page.getByRole('button', { name: 'Retry task', exact: true }).click();
  await page.clock.resume();
  await expect(page.locator('.task-detail-meta .status')).toHaveText(/Completed/);
  await page.getByRole('button', { name: 'Open file', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: 'File preview', exact: true })
      .getByText('Make time for a river walk and reading.', { exact: true }),
  ).toBeVisible();
});
test('goal progress, milestones and archive state persist', async ({ page }) => {
  await navigate(page, 'Goals & tracking');
  await page.getByRole('button', { name: 'New goal', exact: true }).click();
  await page.getByLabel('Your goal', { exact: true }).fill('Read a little more');
  await page.getByLabel('Target', { exact: true }).fill('6');
  await page.getByLabel('Measured in', { exact: true }).fill('books');
  await page.getByRole('button', { name: 'Create goal', exact: true }).click();
  const card = page.locator('.goal-card').filter({ hasText: 'Read a little more' });
  await card.getByRole('button', { name: 'Update your progress', exact: true }).click();
  await page.getByLabel('Progress so far (books)', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Save progress', exact: true }).click();
  await expect(card.locator('.goal-percent')).toHaveText('33%');
  await card.getByRole('button', { name: 'Choose the next small step', exact: true }).click();
  await expect(
    card.getByRole('button', { name: 'Choose the next small step', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await card.getByRole('button', { name: 'Update your progress', exact: true }).click();
  await page.getByRole('button', { name: 'Archive goal', exact: true }).click();
  await page.getByRole('button', { name: 'Archived goals', exact: true }).click();
  await expect(card).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Archived goals', exact: true }).click();
  await expect(card.locator('.goal-percent')).toHaveText('33%');
});
test('tracking checks a fixture, records one alert per match, and pauses', async ({ page }) => {
  await navigate(page, 'Goals & tracking');
  await page.getByRole('button', { name: 'Track something', exact: true }).click();
  await page.getByLabel('Check every (minutes)', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Start tracking', exact: true }).click();
  await expect(
    page.getByText('The studio workshop is sold out.', { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Make tickets available', exact: true }).click();
  await expect.poll(async () => (await readSample(page)).notifications.length).toBe(1);
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect.poll(async () => (await readSample(page)).watches[0].status).toBe('watching');
  expect((await readSample(page)).notifications).toHaveLength(1);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.locator('.watch-title .status')).toHaveText(/Paused/);
  await expect(page.getByRole('button', { name: 'Check now', exact: true })).toBeDisabled();
});
test('the last draft survives a fresh window before its delayed workspace save', async ({
  page,
  context,
}) => {
  const stoppedAt = new Date('2026-10-12T09:00:00Z');
  await page.clock.install({ time: new Date(stoppedAt.getTime() - 60000) });
  await page.clock.pauseAt(stoppedAt);
  const text = 'Keep even my very last keystroke';
  await page.getByLabel('Message Relay', { exact: true }).fill(text);
  expect((await readSample(page)).threads.find((t: any) => t.id === 'main').draft).not.toBe(text);
  const url = page.url();
  await page.close();
  const fresh = await context.newPage();
  await fresh.goto(url);
  await expect(fresh.getByLabel('Message Relay', { exact: true })).toHaveValue(text);
  // Playwright's installed clock also applies to a new page in this context.
  await fresh.clock.resume();
  await expect
    .poll(async () => (await readSample(fresh)).threads.find((t: any) => t.id === 'main').draft)
    .toBe(text);
  await expect
    .poll(() =>
      fresh.evaluate(() =>
        Object.keys(localStorage).filter((key) => key.startsWith('relay:pending-draft:')),
      ),
    )
    .toEqual([]);
  await fresh.close();
});

test('conversation drafts survive reload, renamed threads can be archived and restored', async ({
  page,
}) => {
  const menu = page.getByRole('button', { name: 'Show chats', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'New side chat', exact: true }).click();
  await page.getByLabel('Message Relay', { exact: true }).fill('Remember a small test preference');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Memory saved', { exact: true })).toBeVisible();
  await page.getByLabel('Message Relay', { exact: true }).fill('Do not lose this draft');
  await expect
    .poll(async () => (await readSample(page)).threads.find((t: any) => t.id !== 'main').draft)
    .toBe('Do not lose this draft');
  await page.getByRole('button', { name: 'Conversation options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rename conversation', exact: true }).click();
  await page.getByLabel('Conversation title', { exact: true }).fill('A thread to keep');
  await page.getByRole('button', { name: 'Save title', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A thread to keep', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  // React must mount before checking whether the responsive drawer needs opening.
  await expect(page.getByLabel('Message Relay', { exact: true })).toBeVisible();
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'A thread to keep', exact: true }).click();
  await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
    'Do not lose this draft',
  );
  await page.getByRole('button', { name: 'Conversation options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Archive conversation', exact: true }).click();
  await menu.click();
  await page.getByRole('button', { name: 'Show archived side chats', exact: true }).click();
  await page.getByRole('button', { name: 'Restore A thread to keep', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { level: 1, name: 'A thread to keep', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
    'Do not lose this draft',
  );
});
test('a stopped reply preserves a typed draft and leaves queued follow-ups for explicit resumption', async ({
  page,
}) => {
  // Hold the sample worker's elapsed clock while the owner types. A slow host
  // must not let the first reply finish before the stop interaction is tested.
  const stoppedAt = new Date('2026-10-08T12:00:00Z');
  await page.clock.install({ time: new Date(stoppedAt.getTime() - 60000) });
  await page.clock.pauseAt(stoppedAt);
  const input = page.getByLabel('Message Relay', { exact: true });
  await input.fill('Hello');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop reply', exact: true })).toBeVisible();
  await input.fill('Remember the queued preference');
  await page.getByRole('button', { name: 'Queue follow-up', exact: true }).click();
  await input.fill('Unsent draft stays here');
  await page.getByRole('button', { name: 'Stop reply', exact: true }).click();
  await expect(page.getByText('1 follow-up paused', { exact: true })).toBeVisible();
  await expect(input).toHaveValue('Unsent draft stays here');
  await page.getByRole('button', { name: 'Send queued messages', exact: true }).click();
  await page.clock.resume();
  await expect(page.getByText('Memory saved', { exact: true })).toBeVisible();
  await expect(input).toHaveValue('Unsent draft stays here');
});
test('workspace files support uploads, safe Markdown previews and saved edits', async ({
  page,
}) => {
  await navigate(page, 'Files');
  await page.locator('.workspace-page input[type=file]').setInputFiles({
    name: 'test-upload.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('An uploaded note'),
  });
  await page.getByRole('button', { name: /test-upload.txt/ }).click();
  await expect(page.getByText('An uploaded note', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit text', exact: true }).click();
  await page.getByLabel('File text', { exact: true }).fill('Updated note');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('Updated note', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'All files', exact: true }).click();
  await page.getByRole('button', { name: 'New note', exact: true }).click();
  await page.getByLabel('File name', { exact: true }).fill('safe-preview.md');
  await page
    .getByLabel('Your note', { exact: true })
    .fill(
      '# My note\n\n<script>document.body.innerHTML="bad"</script>\n\n![External](https://untrusted.invalid/private.png)',
    );
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.getByText('Image reference: External', { exact: true })).toBeVisible();
  expect(await page.locator('img[src^="https://untrusted.invalid"]').count()).toBe(0);
  await page.getByRole('button', { name: 'All files', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: /test-upload.txt/ }).click();
  await expect(page.getByText('Updated note', { exact: true })).toBeVisible();
});
test('calendar changes remain pending until approved and use the displayed time zone', async ({
  page,
}) => {
  await navigate(page, 'Calendar');
  await page.getByRole('button', { name: 'New event', exact: true }).click();
  await page.getByLabel('Event name', { exact: true }).fill('A quiet reading hour');
  await page.getByLabel('Starts', { exact: true }).fill('2026-10-12T09:00');
  await page.getByLabel('Ends', { exact: true }).fill('2026-10-12T10:00');
  await page.getByRole('button', { name: 'Prepare for review', exact: true }).click();
  expect(
    (await readSample(page)).events.find((e: any) => e.title === 'A quiet reading hour'),
  ).toBeUndefined();
  await expect(
    page.locator('.workspace-page .approval-detail').getByText('Oct 12, 9:00 AM', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Approve calendar change', exact: true }).click();
  await expect
    .poll(async () =>
      (await readSample(page)).events.some((e: any) => e.title === 'A quiet reading hour'),
    )
    .toBe(true);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await navigate(page, 'Calendar');
  await expect(
    page.getByRole('heading', { name: 'A quiet reading hour', exact: true }),
  ).toBeVisible();
});
test('terminal demo leaves a reviewed command receipt and clearly identifies the self-hosted boundary', async ({
  page,
}) => {
  await navigate(page, 'Computer');
  await expect(
    page.getByText('Connect to your Relay server to set up its computer.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Public web browser', exact: true }).click();
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.getByLabel('Workspace command', { exact: true }).fill('pwd');
  await page.getByRole('button', { name: 'Prepare command for review', exact: true }).click();
  await page.getByRole('button', { name: 'Approve command', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await readSample(page)).receipts.filter((r: any) => r.kind === 'terminal').length,
    )
    .toBe(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await navigate(page, 'Computer');
  await page.getByRole('button', { name: 'Public web browser', exact: true }).click();
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(page.getByText('/workspace', { exact: true })).toBeVisible();
});
test('personal preferences, theme and assistant identity persist', async ({ page }, info) => {
  await navigate(page, 'ME Your profile Make yourself at home');
  await page.getByRole('button', { name: 'Appearance & personality', exact: true }).click();
  await page.getByLabel('Your name', { exact: true }).fill('Alex');
  await page.getByLabel('Assistant name', { exact: true }).fill('Orbit');
  await page.getByLabel('Response style', { exact: true }).selectOption('Warm and thoughtful');
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await page.getByLabel('Appearance', { exact: true }).selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await navigate(page, 'ME Your profile Make yourself at home');
  await page.getByRole('button', { name: 'Appearance & personality', exact: true }).click();
  await expect(page.getByLabel('Assistant name', { exact: true })).toHaveValue('Orbit');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await mkdir(evidence, { recursive: true });
  await page.screenshot({
    path: resolve(evidence, `settings-dark-${info.project.name}.png`),
    fullPage: true,
  });
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});
test('workspace pages keep chat history clean, fit the viewport, and pass accessibility checks', async ({
  page,
}) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const name of [
    'Activity',
    'Routines',
    'Skills',
    'Ideas',
    'Goals & tracking',
    'Files',
    'Finance',
    'Mail',
    'Calendar',
    'Computer',
  ]) {
    await navigate(page, name);
    await expect(page.locator('main')).toHaveClass('chat-layout');
    await expect(page.getByRole('navigation', { name: 'Workspace', exact: true })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Tools' })).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      name + ' overflow',
    ).toBe(true);
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
      name + ' accessibility',
    ).toEqual([]);
  }
  await navigate(page, 'ME Your profile Make yourself at home');
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  expect(errors).toEqual([]);
});

test('saved memories can be corrected, traced to a message and forgotten from the assistant profile', async ({
  page,
}, info) => {
  const input = page.getByLabel('Message Relay', { exact: true });
  await input.fill('Remember Friday afternoons are for reading');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Memory saved', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByText('Friday afternoons are for reading', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Edit memory Friday afternoons are for reading', exact: true })
    .click();
  await page.getByLabel('Edit memory', { exact: true }).fill('Friday afternoons are for family');
  await page.getByRole('button', { name: 'Save memory', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByText('Friday afternoons are for family', { exact: true }),
  ).toBeVisible();
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: resolve(evidence, `memory-${info.project.name}.png`) });
  await page.getByRole('button', { name: 'From your message', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.search-match')).toContainText(
    'Remember Friday afternoons are for reading',
  );
  await page.reload();
  await page.getByRole('button', { name: 'Memory saved', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByText('Friday afternoons are for family', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Remove memory Friday afternoons are for family', exact: true })
    .click();
  await expect(
    page.getByRole('dialog').getByText('Tell me what you’d like me to remember.', { exact: true }),
  ).toBeVisible();
  expect((await readSample(page)).memories).toHaveLength(0);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Memory forgotten', exact: true })).toBeVisible();
});

test('workspace search finds an older message in a side chat without losing the current draft', async ({
  page,
}) => {
  const menu = page.getByRole('button', { name: 'Show chats', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'New side chat', exact: true }).click();
  await page
    .getByLabel('Message Relay', { exact: true })
    .fill('Remember indigo notebooks are my favorite');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Memory saved', exact: true })).toBeVisible();
  await page.getByLabel('Message Relay', { exact: true }).fill('Keep this unfinished thought');
  await expect
    .poll(async () => (await readSample(page)).threads.find((t: any) => t.id !== 'main').draft)
    .toBe('Keep this unfinished thought');
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByLabel('Search your workspace', { exact: true }).fill('indigo notebooks');
  const result = page.getByRole('button', {
    name: /Remember indigo notebooks are my favorite .* · You/,
  });
  await result.click();
  await expect(page.locator('.search-match')).toContainText(
    'Remember indigo notebooks are my favorite',
  );
  await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
    'Keep this unfinished thought',
  );
});

test('page shortcuts switch screens without messages or runs and retain the chat draft', async ({
  page,
}, info) => {
  const input = page.getByLabel('Message Relay', { exact: true });
  await input.fill('Keep this unfinished thought');
  await expect
    .poll(async () => (await readSample(page))?.threads[0]?.draft)
    .toBe('Keep this unfinished thought');
  const before = await readSample(page);
  for (const [label, hash] of [
    ['Files', 'files'],
    ['Ideas', 'ideas'],
    ['Tasks', 'activity'],
  ]) {
    await page
      .getByRole('navigation', { name: 'Workspace shortcuts', exact: true })
      .getByRole('button', { name: label, exact: true })
      .click();
    await expect(page.locator('.workspace-page')).toBeVisible();
    await expect(page.locator('.inline-loading')).toHaveCount(0);
    await expect(input).toBeHidden();
    await expect(page).toHaveURL(new RegExp('#' + hash + '$'));
    expect((await readSample(page)).messages).toEqual(before.messages);
    expect((await readSample(page)).runs).toEqual(before.runs);
    await expect(page.locator('dialog[open]')).toHaveCount(0);
  }
  await page.screenshot({ path: resolve(evidence, `tasks-page-${info.project.name}.png`) });
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await expect(input).toBeVisible();
  await expect(input).toHaveValue('Keep this unfinished thought');
  await page.goBack();
  await expect(page.locator('.workspace-page')).toBeVisible();
  await page.reload();
  await expect(page.locator('.workspace-page')).toBeVisible();
  expect((await readSample(page)).messages).toEqual(before.messages);
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await expect(input).toHaveValue('Keep this unfinished thought');
});

test('page requests navigate directly, the assistant alternative keeps cards, and IME does not send early', async ({
  page,
}) => {
  const input = page.getByLabel('Message Relay', { exact: true });
  const originalMessages = (await readSample(page)).messages;
  await input.fill('Show my files');
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await expect(input).toHaveValue('Show my files');
  await expect(page).toHaveURL(/#?chat?$|\/$/);
  await input.press('Enter');
  await expect(page).toHaveURL(/#files$/);
  expect((await readSample(page)).messages).toEqual(originalMessages);
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await expect(input).toHaveValue('');
  await input.fill('Show my files');
  await page.getByRole('button', { name: 'Ask Relay instead', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Your files', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New note', exact: true })).toHaveCount(0);
  const messagesBefore = (await readSample(page)).messages;
  await page.getByRole('button', { name: 'Open your files', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New note', exact: true })).toBeVisible();
  await expect(input).toBeHidden();
  expect((await readSample(page)).messages).toEqual(messagesBefore);
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await input.fill('一个还没写完的想法');
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await expect(input).toHaveValue('一个还没写完的想法');
  expect((await readSample(page)).messages.some((m: any) => m.text === '一个还没写完的想法')).toBe(
    false,
  );
});

test('routines have a dedicated page, keep chat drafts, validate schedules and expose test history', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const input = page.getByLabel('Message Relay', { exact: true });
  await input.fill('Keep this unsent thought');
  await navigate(page, 'Routines');
  await page.getByRole('button', { name: 'New routine', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'New routine', exact: true });
  await form.getByLabel('Routine name', { exact: true }).fill('Friday reflection');
  await form.getByLabel('What should I do?', { exact: true }).fill('Remember my Friday reflection');
  await form.getByLabel('Repeat', { exact: true }).selectOption('weekly');
  await form.getByLabel('Time zone', { exact: true }).fill('Invalid/Zone');
  await form.getByRole('button', { name: 'Save routine', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('valid IANA time zone');
  await form.getByLabel('Time zone', { exact: true }).fill('Asia/Shanghai');
  await form.getByLabel('Time', { exact: true }).fill('08:30');
  await expect(form.getByText(/Next:/)).toContainText('Asia/Shanghai');
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await form.getByRole('button', { name: 'Save routine', exact: true }).click();
  await expect(form).toBeHidden();
  const card = page.getByRole('article', { name: 'Friday reflection', exact: true });
  await expect(card).toContainText('Paused');
  await expect(card).toContainText('Mon, Tue, Wed, Thu, Fri at 08:30');
  await card.getByRole('button', { name: 'Test run', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await readSample(page))?.runs.find((r: any) => r.routineTitle === 'Friday reflection')
          ?.status,
    )
    .toBe('completed');
  await expect(input).toHaveValue('Keep this unsent thought');
  await card.locator('summary').click();
  await expect(card.locator('.routine-run')).toContainText('Completed');
  await card.getByRole('button', { name: 'Enable schedule', exact: true }).click();
  await expect(card.getByText(/^Next:/)).toBeVisible();
  await card.getByRole('button', { name: 'Pause schedule', exact: true }).click();
  await card.getByRole('button', { name: 'Edit routine', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Routine name', { exact: true }).fill('Friday notes');
  await page.getByRole('button', { name: 'Save routine', exact: true }).click();
  const updated = page.getByRole('article', { name: 'Friday notes', exact: true });
  await updated.getByRole('button', { name: 'Archive routine', exact: true }).click();
  await expect(updated).toHaveCount(0);
  await page.getByRole('button', { name: 'Archived routines', exact: true }).click();
  await page.getByRole('button', { name: 'Restore routine', exact: true }).click();
  await page.getByRole('button', { name: 'Show current routines', exact: true }).click();
  await expect(updated).toContainText('Paused');
  await page.reload();
  await expect(page.getByRole('region', { name: 'Your routines', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await expect(input).toHaveValue('Keep this unsent thought');
  await expect(page.getByRole('heading', { name: 'Main chat', exact: true })).toBeVisible();
  await navigate(page, 'Routines');
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: resolve(evidence, `routines-${info.project.name}.png`) });
});

test('email triggers can be filtered and tested in chat with a saved source and clear connection state', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const input = page.getByLabel('Message Relay', { exact: true });
  await input.fill('Keep my unsent reply');
  await navigate(page, 'Routines');
  await page.getByRole('button', { name: 'New routine', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'New routine', exact: true });
  await form.getByLabel('Routine name', { exact: true }).fill('School trip helper');
  await form
    .getByLabel('What should I do?', { exact: true })
    .fill('Summarize the email and prepare a reply for my review.');
  await form.getByLabel('Repeat', { exact: true }).selectOption('email');
  await expect(form.getByLabel('Time zone', { exact: true })).toHaveCount(0);
  await form.getByRole('button', { name: 'Save routine', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('Choose a sender');
  await form.getByLabel('From this email address', { exact: true }).fill('mira@example.invalid');
  await form.getByLabel('Subject contains', { exact: true }).fill('Field Lab');
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await form.getByRole('button', { name: 'Save routine', exact: true }).click();
  await expect(form).toBeHidden();
  const card = page.getByRole('article', { name: 'School trip helper', exact: true });
  await expect(card).toContainText('Connect Google to enable this trigger.');
  await card.getByRole('button', { name: 'Test run', exact: true }).click();
  const testForm = page.getByRole('dialog', { name: 'Test an email trigger', exact: true });
  await expect(testForm.getByLabel('Matching inbox email', { exact: true })).toContainText(
    'A day at the Riverbank Field Lab',
  );
  await testForm.getByRole('button', { name: 'Test with this email', exact: true }).click();
  await expect(testForm).toBeHidden();
  await expect
    .poll(
      async () =>
        (await readSample(page)).runs.find((r: any) => r.routineTitle === 'School trip helper')
          ?.status,
    )
    .toBe('completed');
  await expect(input).toHaveValue('Keep my unsent reply');
  await card.locator('.routine-history > summary').click();
  await expect(card.locator('.routine-run')).toContainText('Sample email trigger');
  await card.locator('.routine-email-source > summary').click();
  await expect(card.locator('.routine-email-source')).toContainText('mira@example.invalid');
  const state = await readSample(page);
  expect(state.routines.find((r: any) => r.title === 'School trip helper').paused).toBe(true);
  expect(state.runs.find((r: any) => r.mailSource)?.mailSource.subject).toBe(
    'A day at the Riverbank Field Lab',
  );
  await card.getByRole('button', { name: 'Enable trigger', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Connect Google in Settings' }),
  ).toBeVisible();
  expect(
    (await readSample(page)).routines.find((r: any) => r.title === 'School trip helper').paused,
  ).toBe(true);
  await card.getByRole('button', { name: 'Edit routine', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('Subject contains', { exact: true })
    .fill('Does not match');
  await page.getByRole('button', { name: 'Save routine', exact: true }).click();
  await card.getByRole('button', { name: 'Test run', exact: true }).click();
  await expect(testForm).toContainText('No synced inbox emails match yet');
  await expect(
    testForm.getByRole('button', { name: 'Test with this email', exact: true }),
  ).toBeDisabled();
  await testForm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await card.getByRole('button', { name: 'Edit routine', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Subject contains', { exact: true }).fill('Field Lab');
  await page.getByRole('button', { name: 'Save routine', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await card.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: resolve(evidence, `email-trigger-${info.project.name}.png`) });
});

test('a due routine posts into the chat once and a paused routine stays quiet', async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.clock.install();
  const input = page.getByLabel('Message Relay', { exact: true });
  await input.fill('Show my routines');
  await input.press('Enter');
  await expect(page.getByRole('heading', { name: 'Your routines', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New routine', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'New routine', exact: true });
  await form.getByLabel('Routine name', { exact: true }).fill('Scheduled note');
  await form.getByLabel('Routine type', { exact: true }).selectOption('reminder');
  await form.getByLabel('What should I do?', { exact: true }).fill('Take a moment to stretch');
  await form.getByLabel('Repeat', { exact: true }).selectOption('interval');
  await form.getByLabel('Minutes between runs', { exact: true }).fill('5');
  await form.getByRole('button', { name: 'Save routine', exact: true }).click();
  const card = page.getByRole('article', { name: 'Scheduled note', exact: true });
  await card.getByRole('button', { name: 'Enable schedule', exact: true }).click();
  await page.clock.fastForward(300100);
  await expect
    .poll(
      async () =>
        (await readSample(page))?.runs.filter(
          (r: any) => r.routineTitle === 'Scheduled note' && r.status === 'completed',
        ).length,
    )
    .toBe(1);
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await expect(
    page.locator('.routine-message-label').filter({ hasText: 'Scheduled note' }),
  ).toBeVisible();
  await expect(
    page.locator('.message.assistant .markdown').filter({ hasText: 'Take a moment to stretch' }),
  ).toBeVisible();
  await navigate(page, 'Routines');
  await card.getByRole('button', { name: 'Pause schedule', exact: true }).click();
  await page.clock.fastForward(3600000);
  expect(
    (await readSample(page)).runs.filter((r: any) => r.routineTitle === 'Scheduled note'),
  ).toHaveLength(1);
});

test('skills can be saved, run without losing a draft, found, edited and selected with slash', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const input = page.getByLabel('Message Relay', { exact: true });
  await input.fill('Keep my unsent thought');
  await navigate(page, 'Skills');
  await page.getByRole('button', { name: 'New skill', exact: true }).click();
  const form = page.getByRole('region', { name: 'Save a skill', exact: true });
  await form.getByLabel('Skill name', { exact: true }).fill('Weekly reflection');
  await form.getByLabel('Shortcut', { exact: true }).fill('invalid shortcut');
  await form.getByLabel('When to use it', { exact: true }).fill('Keep a useful weekly preference');
  await form.getByLabel('Instructions', { exact: true }).fill('Remember my weekly reflection');
  await form.getByRole('button', { name: 'Save skill', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('single hyphens');
  await form.getByLabel('Shortcut', { exact: true }).fill('weekly-reflection');
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await form.getByRole('button', { name: 'Save skill', exact: true }).click();
  await expect(form).toBeHidden();
  const card = page.getByRole('article', { name: 'Weekly reflection', exact: true });
  await card.getByRole('button', { name: 'Run skill', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('Anything for this run?', { exact: true })
    .fill('On Friday');
  await page.getByRole('button', { name: 'Run in this chat', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await readSample(page)).runs.find((r: any) => r.skill?.slug === 'weekly-reflection')
          ?.status,
    )
    .toBe('completed');
  await expect(input).toHaveValue('Keep my unsent thought');
  await expect(page.locator('.message-skill')).toContainText('Weekly reflection · version 1');
  await navigate(page, 'Skills');
  await card.getByRole('button', { name: 'Edit skill', exact: true }).click();
  await page
    .getByRole('region', { name: 'Edit skill', exact: true })
    .getByLabel('Instructions', { exact: true })
    .fill('Remember my updated reflection');
  await page.getByRole('button', { name: 'Save skill', exact: true }).click();
  await expect(card).toContainText('v2');
  await card.getByRole('button', { name: 'Archive skill', exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.getByRole('button', { name: 'Archived skills', exact: true }).click();
  await card.getByRole('button', { name: 'Restore skill', exact: true }).click();
  await page.getByRole('button', { name: 'Show current skills', exact: true }).click();
  await expect(card).toBeVisible();
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await input.fill('/week');
  const options = page.getByRole('listbox', { name: 'Saved skills', exact: true });
  await expect(options.getByRole('option')).toHaveCount(1);
  await expect(options).toContainText('/weekly-reflection');
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path: resolve(evidence, `skills-picker-${info.project.name}.png`) });
  await input.press('Escape');
  await expect(options).toBeHidden();
  await expect(input).toHaveValue('/week');
  await input.fill('/weekly');
  await input.press('Enter');
  await expect(input).toHaveValue('/weekly-reflection ');
  await expect(options).toBeHidden();
  await input.pressSequentially('Keep Mondays free');
  await input.press('Enter');
  await expect
    .poll(
      async () =>
        (await readSample(page)).runs.filter(
          (r: any) => r.skill?.version === 2 && r.status === 'completed',
        ).length,
    )
    .toBe(1);
  const saved = await readSample(page);
  expect(saved.runs.find((r: any) => r.skill?.version === 1).skill.instructions).toBe(
    'Remember my weekly reflection',
  );
  expect(saved.runs.find((r: any) => r.skill?.version === 2).skillInput).toBe('Keep Mondays free');
  await page.reload();
  await page.getByRole('button', { name: 'Show chats', exact: true }).click();
  await page.getByRole('button', { name: 'Find in your space', exact: true }).click();
  await page.getByLabel('Search your workspace', { exact: true }).fill('Weekly reflection');
  await page.getByRole('button', { name: /Weekly reflection Skill · \/weekly-reflection/ }).click();
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('v2');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: resolve(evidence, `skills-library-${info.project.name}.png`) });
});

test('a reply can become a skill and routines keep a version until explicitly updated', async ({
  page,
}) => {
  test.setTimeout(120000);
  const input = page.getByLabel('Message Relay', { exact: true });
  await input.fill('Remember short breaks');
  await input.press('Enter');
  const reply = page.locator('.message.assistant').filter({ hasText: 'I’ll keep that in mind.' });
  await reply.getByRole('button', { name: 'Message actions', exact: true }).click();
  await reply.getByRole('button', { name: 'Save as skill', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Save a skill', exact: true });
  await expect(form.getByLabel('Instructions', { exact: true })).toHaveValue(
    /I’ll keep that in mind/,
  );
  await form.getByLabel('Skill name', { exact: true }).fill('Break ritual');
  await form.getByLabel('Shortcut', { exact: true }).fill('break-ritual');
  await form.getByLabel('Instructions', { exact: true }).fill('Remember a scheduled break');
  await form.getByRole('button', { name: 'Save skill', exact: true }).click();
  await navigate(page, 'Routines');
  await page.getByRole('button', { name: 'New routine', exact: true }).click();
  const routineForm = page.getByRole('dialog', { name: 'New routine', exact: true });
  await routineForm.getByLabel('Routine name', { exact: true }).fill('My break');
  await routineForm
    .getByLabel('Saved skill', { exact: true })
    .selectOption({ label: 'Break ritual · v1' });
  await expect(routineForm.getByLabel('Details for this routine', { exact: true })).toHaveValue('');
  await routineForm.getByRole('button', { name: 'Save routine', exact: true }).click();
  const routineCard = page.getByRole('article', { name: 'My break', exact: true });
  await expect(routineCard).toContainText('Skill: Break ritual · version 1');
  await navigate(page, 'Skills');
  const skillCard = page.getByRole('article', { name: 'Break ritual', exact: true });
  await expect(
    skillCard.getByRole('button', { name: 'View source message', exact: true }),
  ).toBeVisible();
  await skillCard.getByRole('button', { name: 'Edit skill', exact: true }).click();
  await page
    .getByRole('region', { name: 'Edit skill', exact: true })
    .getByLabel('Instructions', { exact: true })
    .fill('Remember a changed break');
  await page.getByRole('button', { name: 'Save skill', exact: true }).click();
  await navigate(page, 'Routines');
  await routineCard.getByRole('button', { name: 'Edit routine', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Routine name', { exact: true }).fill('Daily break');
  await page.getByRole('button', { name: 'Save routine', exact: true }).click();
  const updated = page.getByRole('article', { name: 'Daily break', exact: true });
  await expect(updated).toContainText('Skill: Break ritual · version 1');
  await updated.getByRole('button', { name: 'Test run', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await readSample(page)).runs.filter(
          (r: any) => r.routineId && r.skill?.version === 1 && r.status === 'completed',
        ).length,
    )
    .toBe(1);
  await updated.getByRole('button', { name: 'Edit routine', exact: true }).click();
  await page.getByRole('button', { name: 'Use latest skill version 2', exact: true }).click();
  await page.getByRole('button', { name: 'Save routine', exact: true }).click();
  await expect(updated).toContainText('Skill: Break ritual · version 2');
  await updated.getByRole('button', { name: 'Test run', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await readSample(page)).runs.filter(
          (r: any) => r.routineId && r.skill?.version === 2 && r.status === 'completed',
        ).length,
    )
    .toBe(1);
  await updated.locator('summary').click();
  await expect(updated.locator('.routine-run')).toHaveCount(2);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
});

test('message bubbles support saved reactions and quoted replies without replacing a draft', async ({
  page,
}, info) => {
  const input = page.getByLabel('Message Relay', { exact: true });
  await input.fill('Remember my favorite afternoons are quiet');
  await input.press('Enter');
  const reply = page.locator('.message.assistant').last();
  await expect(reply).toContainText('I’ll keep that in mind.');
  await input.fill('Keep this thought while I reply');
  await reply.getByRole('button', { name: 'Message actions', exact: true }).click();
  await reply.getByRole('button', { name: 'React ❤️', exact: true }).click();
  await expect(reply.getByRole('button', { name: 'Remove ❤️ reaction' })).toBeVisible();
  await reply.getByRole('button', { name: 'Message actions', exact: true }).click();
  await reply.getByRole('button', { name: 'Reply to message', exact: true }).click();
  await expect(page.locator('.reply-preview')).toContainText('Replying to Relay');
  await expect(input).toHaveValue('Keep this thought while I reply');
  await input.fill('Thank you, that is exactly it.');
  await input.press('Enter');
  await expect(page.locator('.message.user').last().locator('.quoted-message')).toContainText(
    'I’ll keep that in mind.',
  );
  await expect(page.locator('.reply-preview')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop reply', exact: true })).toBeHidden();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Remove ❤️ reaction' })).toBeVisible();
  await expect(page.locator('.quoted-message')).toContainText('I’ll keep that in mind.');
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: resolve(evidence, `message-bubbles-${info.project.name}.png`) });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('settings stay focused and preserve unfinished forms and chat drafts', async ({
  page,
}, info) => {
  const draft = page.getByLabel('Message Relay', { exact: true });
  await draft.fill('Keep this while I adjust Relay');
  const before = (await readSample(page)).messages.length;
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const categories = page.getByRole('navigation', { name: 'Settings categories' });
  await expect(categories.getByRole('button')).toHaveCount(9);
  await expect(page.getByLabel('Your name', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('article', { name: 'AI models', exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.screenshot({ path: resolve(evidence, `simpler-settings-${info.project.name}.png`) });
  await categories.getByRole('button', { name: 'Appearance & personality', exact: true }).click();
  await page.getByLabel('Your name', { exact: true }).fill('Not saved yet');
  await page.getByRole('button', { name: 'All settings', exact: true }).click();
  await categories.getByRole('button', { name: 'Notifications', exact: true }).click();
  await expect(
    page.getByRole('switch', { name: 'Workspace notifications', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Your name', { exact: true })).toBeHidden();
  await page.goBack();
  await expect(categories).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel('Your name', { exact: true })).toHaveValue('Not saved yet');
  expect((await readSample(page)).profile.name).not.toBe('Not saved yet');
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await expect.poll(async () => (await readSample(page)).profile.name).toBe('Not saved yet');
  await page.reload();
  await expect(page.getByLabel('Your name', { exact: true })).toHaveValue('Not saved yet');
  await expect(
    page.getByRole('heading', { name: 'Appearance & personality', exact: true }),
  ).toBeFocused();
  await page.getByRole('button', { name: 'Main chat', exact: true }).click();
  await expect(draft).toHaveValue('Keep this while I adjust Relay');
  expect((await readSample(page)).messages).toHaveLength(before);
  await page.goto('/#settings?section=unknown');
  await expect(categories).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('one-tap search opens controls, supports the keyboard, and keeps navigation out of history', async ({
  page,
}, info) => {
  const draft = page.getByLabel('Message Relay', { exact: true });
  await draft.fill('A thought to finish later');
  const before = (await readSample(page)).messages.length;
  const search = page.getByRole('button', { name: 'Search', exact: true });
  await search.click();
  const query = page.getByLabel('Search your workspace', { exact: true });
  await expect(query).toBeFocused();
  await expect(page.getByRole('region', { name: 'Quick links' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(search).toBeFocused();
  await search.click();
  await query.fill('dark mode');
  await expect(
    page.getByRole('button', { name: 'Appearance & personality Settings', exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: resolve(evidence, `simpler-search-${info.project.name}.png`) });
  await query.press('Enter');
  await expect(page).toHaveURL(/#settings\?section=personal$/);
  await expect(page.getByLabel('Appearance', { exact: true })).toBeVisible();
  await search.click();
  await query.fill('voice');
  await query.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Voice Settings', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('article', { name: 'Voice settings', exact: true })).toBeVisible();
  await expect(page.getByLabel('Appearance', { exact: true })).toBeHidden();
  await search.click();
  await query.fill('restore old conversations');
  await query.press('Enter');
  await expect(page.getByRole('heading', { name: 'Archived chats', exact: true })).toBeVisible();
  await search.click();
  await query.fill('none-of-these-words-exist');
  await expect(page.getByRole('status')).toContainText('No matches');
  await query.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await query.fill('Files');
  await page.getByRole('button', { name: 'Files Open page', exact: true }).click();
  await expect(page).toHaveURL(/#files$/);
  await expect(page.getByRole('combobox', { name: 'Workspace page' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await expect(draft).toHaveValue('A thought to finish later');
  expect((await readSample(page)).messages).toHaveLength(before);
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 320, height: 640 });
  const searchBox = (await search.boundingBox())!;
  expect(searchBox.width).toBeGreaterThanOrEqual(36);
  expect(
    await search.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }),
  ).toBe(true);
  await page.screenshot({ path: resolve(evidence, `simpler-chat-${info.project.name}.png`) });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
