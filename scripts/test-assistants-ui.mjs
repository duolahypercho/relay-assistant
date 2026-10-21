// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assistantsFixture } from './assistants-fixture.mjs';
import { command } from '../shared/domain.mjs';
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const native = process.env.RELAY_ASSISTANTS_NATIVE === 'true';
const browser = native ? null : await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const mobile of native ? [false] : [false, true]) {
    const label = native ? 'native-mac' : mobile ? 'mobile' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-assistants-ui-'));
    const f = await assistantsFixture(directory);
    let app, context, page;
    try {
      if (native) {
        const data = join(directory, 'native');
        await mkdir(data);
        await writeFile(join(data, 'desktop.json'), JSON.stringify({ server: f.url }));
        app = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${data}`],
        });
        page = await app.firstWindow();
      } else {
        context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 1000 },
          isMobile: mobile,
          hasTouch: mobile,
          reducedMotion: 'reduce',
        });
        page = await context.newPage();
        await page.goto(f.url);
      }
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const composer = (name) =>
        page.getByRole('textbox', { name: `Message ${name}`, exact: true });
      const view = () => page.goto(f.url + '/#assistants');
      const editor = page.getByRole('region', { name: 'Assistant profile', exact: true });
      const profile = (name) => page.getByRole('article', { name: `${name} profile`, exact: true });
      const create = async (name, role) => {
        await view();
        await page.getByRole('button', { name: 'New assistant', exact: true }).click();
        await page.getByLabel('Assistant name', { exact: true }).fill(name);
        await page.getByLabel('Role and instructions', { exact: true }).fill(role);
        await page.getByRole('button', { name: 'Create & chat', exact: true }).click();
        await expect(composer(name)).toBeVisible();
      };
      const send = async (name, text, reply) => {
        await composer(name).fill(text);
        await page.getByRole('button', { name: 'Send message', exact: true }).click();
        await expect(page.locator('.messages').getByText(reply, { exact: true })).toBeVisible({
          timeout: 30000,
        });
      };
      await expect(composer('Relay')).toBeVisible({ timeout: 20000 });
      await composer('Relay').fill('Keep my Main draft');
      await create('Aster', 'Plan quiet, thoughtful trips.');
      await expect.poll(() => f.store.read().assistants?.length).toBe(1);
      expect(f.store.read().messages).toHaveLength(0);
      await send(
        'Aster',
        'I prefer quiet hotels. Remember this for our trips.',
        'Aster: I saved your quiet-hotel preference.',
      );
      await expect(page.getByRole('button', { name: 'Memory saved', exact: true })).toBeVisible();
      const a = f.store.read().assistants[0];
      expect(f.store.read().memories[0].assistantId).toBe(a.id);
      await composer('Aster').fill('Aster draft kept across reload');
      await page.reload();
      await expect(composer('Aster')).toHaveValue('Aster draft kept across reload');
      await page.getByRole('button', { name: 'Show chats', exact: true }).click();
      await page.getByRole('button', { name: 'New side chat', exact: true }).click();
      await send(
        'Aster',
        'What do you remember?',
        'Aster: I remember your quiet-hotel preference.',
      );
      expect(
        f.store.read().threads.find((t) => !t.assistantHome && t.assistantId === a.id),
      ).toBeTruthy();
      await create('Mika', 'Help with concise writing.');
      await send('Mika', 'Hello, start fresh.', 'Mika: Ready for our own conversation.');
      const request = f.requests.at(-1);
      expect(JSON.stringify(request.messages)).not.toContain('quiet hotels');
      expect(request.messages[0].content).toContain('Help with concise writing.');
      await view();
      const method = f.store.mutate((s) =>
        command(s, 'skill.create', {
          title: 'Daily method',
          slug: 'daily-method',
          instructions: 'Review the calendar and summarize.',
        }),
      );
      const routine = f.store.mutate((s) =>
        command(s, 'routine.create', {
          title: 'Morning check',
          instructions: 'Review my day',
          threadId: a.threadId,
          skillId: method.id,
          schedule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
        }),
      );
      f.store.mutate((s) => command(s, 'routine.resume', { id: routine.id }));
      const beforeNavigation = f.store.read().messages.length;
      await profile('Aster').getByRole('button', { name: 'Edit Aster', exact: true }).click();
      await page.getByLabel('Working style', { exact: true }).fill('One concise paragraph');
      await page.reload();
      await expect(page.getByLabel('Working style', { exact: true })).toHaveValue(
        'One concise paragraph',
      );
      await editor.getByText('Skills this assistant can use', { exact: true }).click();
      await editor.getByLabel('All shared skills', { exact: true }).uncheck();
      await editor.getByRole('button', { name: 'Save profile', exact: true }).click();
      await expect(profile('Aster')).toBeVisible();
      expect(f.store.read().assistants.find((x) => x.id === a.id).enabledSkillIds).toEqual([]);
      await profile('Aster')
        .getByRole('button', { name: 'Routines for Aster', exact: true })
        .click();
      await page.getByRole('button', { name: 'Edit routine', exact: true }).click();
      const routineDialog = page.getByRole('dialog', { name: 'Edit routine', exact: true });
      await expect(routineDialog.getByLabel('Saved skill', { exact: true })).toHaveValue(method.id);
      await expect(
        routineDialog.getByRole('option', { name: 'Daily method · saved v1', exact: true }),
      ).toBeAttached();
      await routineDialog
        .getByLabel('Routine name', { exact: true })
        .fill('Morning check, revised');
      await routineDialog.getByRole('button', { name: 'Save routine', exact: true }).click();
      await expect(routineDialog).toHaveCount(0);
      expect(f.store.read().routines.find((r) => r.id === routine.id).skill.id).toBe(method.id);
      await view();

      await profile('Aster').getByText('More', { exact: true }).click();
      await profile('Aster').getByRole('button', { name: 'Pin Aster', exact: true }).click();
      await expect(
        profile('Aster').getByRole('button', { name: 'Unpin Aster', exact: true }),
      ).toBeVisible();
      await profile('Aster').getByRole('button', { name: 'Hide Aster', exact: true }).click();
      await expect(profile('Aster')).toHaveCount(0);
      expect(f.store.read().routines[0].paused).toBe(false);
      f.store.mutate((s) => command(s, 'routine.test', { id: routine.id }));
      await expect
        .poll(
          () =>
            f.store
              .read()
              .messages.some(
                (m) =>
                  m.threadId === a.threadId && m.text === 'Aster: Your scheduled check is ready.',
              ),
          { timeout: 30000 },
        )
        .toBe(true);
      await page.getByRole('button', { name: 'Hidden assistants', exact: true }).click();
      await profile('Aster').getByText('More', { exact: true }).click();
      await profile('Aster').getByRole('button', { name: 'Unhide Aster', exact: true }).click();
      await page.getByRole('button', { name: 'Show active assistants', exact: true }).click();
      await profile('Aster').getByText('More', { exact: true }).click();
      await profile('Aster').getByRole('button', { name: 'Duplicate Aster', exact: true }).click();
      await expect(page.getByLabel('Assistant name', { exact: true })).toHaveValue('Aster copy');
      await expect(
        page.getByRole('status').filter({ hasText: 'Copied routines are paused' }),
      ).toBeVisible();
      await editor.getByRole('button', { name: 'All assistants', exact: true }).click();
      const copy = f.store.read().assistants.find((x) => x.name === 'Aster copy');
      expect(f.store.read().memories.filter((m) => m.assistantId === copy.id)).toHaveLength(0);
      expect(f.store.read().messages.filter((m) => m.threadId === copy.threadId)).toHaveLength(0);
      expect(f.store.read().routines.find((r) => r.threadId === copy.threadId).paused).toBe(true);
      expect(f.store.read().messages.length).toBe(beforeNavigation + 1); // Routine result only.
      expect(await page.getByRole('dialog').count()).toBe(0);
      await page.screenshot({ path: join(evidence, `assistants-${label}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await profile('Relay').getByRole('button', { name: 'Chat with Relay', exact: true }).click();
      await expect(composer('Relay')).toHaveValue('Keep my Main draft');
      await page.goto(f.url + '/#settings?section=personal');
      await page.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption('dark');
      await view();
      await page.screenshot({ path: join(evidence, `assistants-dark-${label}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      await profile('Aster').getByRole('button', { name: 'Chat with Aster', exact: true }).click();
      await expect(composer('Aster')).toHaveValue('Aster draft kept across reload');
      await page.screenshot({ path: join(evidence, `assistant-chat-${label}.png`) });
      expect(errors).toEqual([]);
      checks.push({
        surface: label,
        passed: true,
        checks: [
          'HTTP model tool loop and isolated memory',
          'Main and specialist draft persistence',
          'specialist side chats',
          'inline profile and skill editing',
          'pin/hide/unhide',
          'hidden assistant routine through worker',
          'duplicate without memory/history; paused routines',
          'separate pages without navigation history',
          'light/dark accessibility and overflow',
        ],
      });
      console.log(
        `PASS ${label}: assistant profiles, independent chats/memory, drafts, skills, routines, duplication, accessibility`,
      );
    } catch (error) {
      if (page) await page.screenshot({ path: join(evidence, `assistants-failure-${label}.png`) });
      throw error;
    } finally {
      await app?.close();
      await context?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, `assistants-${native ? 'native' : 'ui'}-acceptance.json`),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        provider: 'Controlled local HTTP fixture; no external credentials',
        checks,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
}
