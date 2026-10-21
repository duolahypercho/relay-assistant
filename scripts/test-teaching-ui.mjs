// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { teachingFixture } from './teaching-fixture.mjs';
const directory = await mkdtemp(join(tmpdir(), 'relay-teaching-ui-')),
  evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const fixture = await teachingFixture(directory);
const { store, computer, services, url, modelRequests, owner } = fixture;
let label = 'desktop';
const native = process.env.RELAY_TEACHING_NATIVE === 'true';
const nativeData = native ? await mkdtemp(join(tmpdir(), 'relay-teaching-mac-')) : null;
if (nativeData) await writeFile(join(nativeData, 'desktop.json'), JSON.stringify({ server: url }));
const application = native
  ? await electron.launch({
      executablePath: resolve('release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay'),
      args: [`--relay-test-data=${nativeData}`],
      timeout: 40000,
    })
  : null;
const browser = application ? null : await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  await fixture.prepare();
  for (const mobile of native ? [false] : [false, true]) {
    label = native ? 'native-mac' : mobile ? 'mobile' : 'desktop';
    fixture.setLabel(label);
    const nativePage = application ? await application.firstWindow() : null;
    const context = nativePage
      ? nativePage.context()
      : await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 980 },
          isMobile: mobile,
          hasTouch: mobile,
          reducedMotion: 'reduce',
        });
    try {
      const previousModelRequests = modelRequests.length;
      await computer.takeControl();
      await owner({ kind: 'desktop', action: 'key', key: 'ctrl+r' });
      const page = nativePage || (await context.newPage()),
        errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(url + '/#chat');
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
      await composer.fill(`Keep my Main ${label} draft`);
      const previousThreadIds = store.read().threads.map((t) => t.id);
      await page.getByRole('button', { name: 'Show chats', exact: true }).click();
      await page.getByRole('button', { name: 'New side chat', exact: true }).click();
      await composer.fill(`Keep my ${label} draft`);
      const sideId = store.read().threads.find((t) => !previousThreadIds.includes(t.id)).id;
      await expect
        .poll(() => store.read().threads.find((t) => t.id === sideId)?.draft)
        .toBe(`Keep my ${label} draft`);
      const add = page.getByRole('button', { name: 'Add to chat', exact: true });
      const menu = page.getByRole('menu', { name: 'Add to chat', exact: true });
      await add.focus();
      await add.press('ArrowUp');
      await expect(menu.getByRole('menuitem', { name: 'Attach files', exact: true })).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(menu.getByRole('menuitem', { name: 'Teach a task', exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(add).toBeFocused();
      await expect(menu).toHaveCount(0);
      await add.click();
      await composer.click();
      await expect(menu).toHaveCount(0);
      await add.click();
      const chooser = page.waitForEvent('filechooser');
      await menu.getByRole('menuitem', { name: 'Attach files', exact: true }).click();
      await (
        await chooser
      ).setFiles({
        name: `Unsent-${label}.txt`,
        mimeType: 'text/plain',
        buffer: Buffer.from('This attachment belongs to my unfinished message.'),
      });
      await expect(page.locator('.composer .attachment-list')).toContainText(`Unsent-${label}.txt`);
      await add.click();
      await page.screenshot({ path: join(evidence, `teaching-entry-${label}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      const baseline = store.read();
      await menu.getByRole('menuitem', { name: 'Teach a task', exact: true }).click();
      const teaching = page.getByRole('region', { name: 'Teach a task', exact: true });
      await expect(teaching.getByLabel('What are you showing Relay?')).toBeVisible();
      expect(new URL(page.url()).hash).toBe(
        `#computer/teaching/new?chat=${encodeURIComponent(sideId)}`,
      );
      expect(
        services.teaching.all().filter((s) => ['recording', 'paused'].includes(s.status)),
      ).toHaveLength(0);
      expect(store.read().messages).toEqual(baseline.messages);
      expect(store.read().runs).toEqual(baseline.runs);
      expect(modelRequests).toHaveLength(previousModelRequests);
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(composer).toHaveValue(`Keep my ${label} draft`);
      await expect(page.locator('.composer .attachment-list')).toContainText(`Unsent-${label}.txt`);
      await add.click();
      await menu.getByRole('menuitem', { name: 'Teach a task', exact: true }).click();
      await page.reload();
      await expect(teaching.getByLabel('What are you showing Relay?')).toBeVisible();
      await teaching
        .getByLabel('What are you showing Relay?')
        .fill(`Create a local note from a title (${label})`);
      await teaching.getByRole('button', { name: 'Take control & record', exact: true }).click();
      await expect(
        teaching.getByRole('button', { name: 'Stop & review', exact: true }),
      ).toBeVisible({ timeout: 60000 });
      let session = services.teaching.all()[0];
      expect(session.frames.length).toBeGreaterThan(0);
      expect(session.threadId).toBe(sideId);
      await expect(teaching.getByText('For New side chat', { exact: true })).toBeVisible();
      await teaching.getByRole('button', { name: 'Pause recording', exact: true }).click();
      const before = services.teaching.get(session.id).frames.length;
      const input = page.getByRole('textbox', { name: 'Type on the computer', exact: true });
      await input.fill('Private step not included');
      await page.getByRole('button', { name: 'Type text', exact: true }).click();
      await expect(input).toHaveValue('', { timeout: 20000 });
      expect(services.teaching.get(session.id).frames.length).toBe(before);
      await owner({ kind: 'desktop', action: 'key', key: 'ctrl+a' });
      await owner({ kind: 'desktop', action: 'key', key: 'BackSpace' });
      await page.goto(url + '/#computer/teaching/new?chat=main');
      await expect(
        teaching.getByRole('button', { name: 'Resume recording', exact: true }),
      ).toBeVisible();
      await expect(teaching.getByText('For New side chat', { exact: true })).toBeVisible();
      expect(services.teaching.get(session.id).threadId).toBe(sideId);
      // An active recording must not take over an explicitly opened older review.
      const older = services.teaching.all().find((s) => s.id !== session.id);
      if (older) {
        await page.goto(`${url}/#computer/teaching/${older.id}`);
        await expect(
          teaching.getByRole('button', { name: 'Open test conversation', exact: true }),
        ).toBeVisible();
        await teaching.getByLabel('Saved recordings', { exact: true }).selectOption(session.id);
      } else await page.goto(`${url}/#computer/teaching/${session.id}`);
      await page.reload();
      await expect(
        teaching.getByRole('button', { name: 'Resume recording', exact: true }),
      ).toBeVisible();
      await teaching.getByRole('button', { name: 'Resume recording', exact: true }).click();
      await input.fill(`Demo ${label}`);
      await page.getByRole('button', { name: 'Type text', exact: true }).click();
      await expect(input).toHaveValue('', { timeout: 20000 });
      await page.getByRole('button', { name: 'Enter', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Enter', exact: true })).toBeEnabled({
        timeout: 20000,
      });
      await teaching.getByRole('button', { name: 'Capture this step', exact: true }).click();
      await teaching.getByRole('button', { name: 'Stop & review', exact: true }).click();
      await expect(
        teaching.getByRole('button', { name: 'Create skill draft', exact: true }),
      ).toBeVisible();
      await page.reload();
      await expect(
        teaching.getByRole('button', { name: 'Create skill draft', exact: true }),
      ).toBeVisible();
      session = services.teaching.get(session.id);
      expect(session.frames.length).toBeGreaterThan(1);
      expect(modelRequests).toHaveLength(previousModelRequests);
      expect(store.read().messages.filter((m) => m.role === 'user')).toHaveLength(mobile ? 1 : 0);
      expect(JSON.stringify(session)).not.toContain('Private step not included');
      await teaching.getByRole('button', { name: 'Inspect step 1', exact: true }).click();
      const removed = session.frames[0].id;
      await teaching
        .getByRole('button', { name: 'Remove selected screenshot', exact: true })
        .click();
      await expect(
        teaching.getByRole('button', { name: 'Inspect step 1', exact: true }),
      ).toBeVisible();
      expect(services.teaching.get(session.id).frames.some((f) => f.id === removed)).toBe(false);
      await expect(
        teaching.getByRole('button', { name: 'Create skill draft', exact: true }),
      ).toBeEnabled({ timeout: 20000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: join(evidence, `teaching-review-${label}.png`) });
      // Electron has no browser tab factory; scan this same-origin screen in place.
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      fixture.failDraft(true);
      await teaching.getByRole('button', { name: 'Create skill draft', exact: true }).click();
      await expect(teaching.getByRole('alert')).toContainText('could not finish', {
        timeout: 20000,
      });
      fixture.failDraft(false);
      await teaching.getByRole('button', { name: 'Create skill draft', exact: true }).click();
      await expect(
        teaching.getByRole('textbox', { name: 'Review the method', exact: true }),
      ).toBeVisible({ timeout: 20000 });
      const vision = modelRequests.findLast((r) =>
        r.messages[0]?.content.startsWith('Turn an owner-recorded'),
      );
      expect(vision.tools || []).toEqual([]);
      expect(vision.messages.filter((m) => Array.isArray(m.content)).length).toBe(
        services.teaching.get(session.id).frames.length,
      );
      expect(JSON.stringify(vision)).not.toContain(removed);
      await teaching
        .getByRole('textbox', { name: 'Skill name', exact: true })
        .fill(`My note method ${label}`);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: join(evidence, `teaching-draft-${label}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      await teaching.getByRole('button', { name: 'Save reviewed skill', exact: true }).click();
      await expect(
        teaching.getByRole('button', { name: 'Give back & test skill', exact: true }),
      ).toBeVisible();
      await teaching.getByRole('button', { name: 'Open Skills', exact: true }).click();
      await page
        .getByRole('article', { name: `My note method ${label}`, exact: true })
        .getByRole('link', { name: 'View demonstration', exact: true })
        .click();
      await expect(
        teaching.getByRole('button', { name: 'Give back & test skill', exact: true }),
      ).toBeVisible();
      await teaching
        .getByRole('textbox', { name: 'Example for the test', exact: true })
        .fill(`Create a note titled Test ${label}.`);
      await teaching.getByRole('button', { name: 'Give back & test skill', exact: true }).click();
      await expect(page).toHaveURL(/#chat/);
      await expect
        .poll(
          () =>
            store.read().runs.find((r) => r.id === services.teaching.get(session.id).testRunId)
              ?.status,
          { timeout: 90000 },
        )
        .toBe('completed');
      await expect(
        page
          .getByText('The learned method created and checked your test note.', { exact: true })
          .last(),
      ).toBeVisible({ timeout: 90000 });
      await expect(page.getByRole('textbox', { name: 'Message Relay', exact: true })).toHaveValue(
        `Keep my ${label} draft`,
      );
      await expect(page.locator('.composer .attachment-list')).toContainText(`Unsent-${label}.txt`);
      const finalState = store.read(),
        testRun = finalState.runs.find((r) => r.id === services.teaching.get(session.id).testRunId);
      expect(testRun.threadId).toBe(sideId);
      expect(finalState.messages.find((m) => m.id === testRun.messageId).fileIds).toEqual([]);
      expect(finalState.messages.filter((m) => m.threadId === 'main')).toHaveLength(0);
      await page.goto(`${url}/#computer/teaching/${session.id}`);
      await teaching.getByRole('button', { name: 'Open test conversation', exact: true }).click();
      await expect(composer).toHaveValue(`Keep my ${label} draft`);
      expect(decodeURIComponent(new URL(page.url()).hash)).toContain(sideId);
      await page.getByRole('button', { name: 'Back to main chat', exact: true }).click();
      await expect(composer).toHaveValue(`Keep my Main ${label} draft`);
      const file = store.read().files.find((f) => f.name === `test-${label}.txt`);
      expect(file).toBeTruthy();
      expect(Buffer.from(file.base64, 'base64').toString()).toBe(`Note: Test ${label}\n`);
      expect(store.read().skills.find((s) => s.sourceTeachingId === session.id).title).toBe(
        `My note method ${label}`,
      );
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      checks.push({
        surface: label,
        check:
          'composer menu keyboard/outside/real file chooser, side-chat teaching entry without messages or recording, real Docker browser recording, private-step pause/reload, screenshot removal, controlled HTTP vision draft/error retry, review/save and original-chat live worker test with exact downloaded output, both chat drafts and unsent attachments preserved',
        passed: true,
      });
      console.log(
        `PASS ${label}: demonstrated browser workflow → reviewed skill → actual saved test file`,
      );
    } finally {
      if (!application) await context.close();
    }
  }
  if (application) {
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      application.process().kill('SIGTERM');
    }, 15000);
    try {
      await application.close();
      expect(timedOut, 'Remote-connected native app quits without a lingering process').toBe(false);
    } finally {
      clearTimeout(deadline);
    }
    checks.push({ surface: label, check: 'Remote-connected app exits on Quit', passed: true });
  }
  await writeFile(
    join(evidence, native ? 'teaching-native-mac.json' : 'teaching-ui-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        runtime: native
          ? 'Packaged Electron app connected to real Docker test server; controlled HTTP vision/model responses'
          : 'Real isolated Docker desktop and Chrome; controlled HTTP vision/model responses',
        checks,
      },
      null,
      2,
    ),
  );
} finally {
  if (application) await application.close();
  if (browser) await browser.close();
  if (nativeData) await rm(nativeData, { recursive: true, force: true });
  await fixture.close();
  await rm(directory, { recursive: true, force: true });
}
