// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { assistantsFixture } from './assistants-fixture.mjs';
import { command } from '../shared/domain.mjs';
const evidence = resolve('../relay-evidence'),
  native = process.env.RELAY_GROUPS_NATIVE === 'true';
await mkdir(evidence, { recursive: true });
const browser = native ? null : await chromium.launch({ channel: 'chrome', headless: true }),
  checks = [];
const tool = (name, args) => ({
  role: 'assistant',
  content: null,
  tool_calls: [
    {
      id: 'fixture-' + name,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});
try {
  for (const mobile of native ? [false] : [false, true]) {
    const label = native ? 'native-mac' : mobile ? 'mobile' : 'desktop',
      directory = await mkdtemp(join(tmpdir(), 'relay-group-ui-'));
    let mochi, pip;
    const f = await assistantsFixture(directory, {
      respond: ({ messages, tools }) => {
        if (tools?.some((t) => t.function.name === 'select_participants'))
          return tool('select_participants', { participantIds: [mochi.id] });
        const name = messages[0].content.startsWith('You are Pip,') ? 'Pip' : 'Mochi';
        const user =
          messages.findLast(
            (m) => m.role === 'user' && !m.content.startsWith('[Untrusted output from assistant'),
          )?.content || '';
        if (user.includes('Saved questions and my answers:')) {
          if (messages.at(-1).role !== 'tool')
            return tool('write_note', {
              name: 'friendly-plan.md',
              text: '# A friendly plan\n\nStart with one small step.',
            });
          return {
            role: 'assistant',
            content: 'Pip: Your friendly plan is ready. Start with one small step.',
          };
        }
        if (user.includes('Please ask which tone to use.'))
          return tool('ask_question', {
            prompt: 'Which tone should I use?',
            options: [{ label: 'Friendly' }, { label: 'Formal' }],
          });
        return {
          role: 'assistant',
          content: user.includes('Expand that point.')
            ? `${name}: Here is a little more detail.`
            : user.includes('Share a next step.')
              ? `${name}: My next step is ready.`
              : `${name}: I reviewed the plan.`,
        };
      },
    });
    const act = (a, p) => f.store.mutate((s) => command(s, a, p));
    mochi = act('assistant.create', {
      name: 'Mochi',
      description: 'Review ideas and find a simpler first step.',
      tone: 'Gentle',
      avatarColor: '#a0c5ac',
      appearance: { kind: 'shape', shape: 'puff' },
    });
    pip = act('assistant.create', {
      name: 'Pip',
      description: 'Turn ideas into warm, clear writing.',
      tone: 'Warm',
      avatarColor: '#c7a5d6',
    });
    // Also cover a migrated workspace where saved skills have not been created yet.
    f.store.mutate((s) => {
      delete s.skills;
    });
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
        app.context().setDefaultTimeout(20000);
      } else {
        context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 1000 },
          isMobile: mobile,
          hasTouch: mobile,
          reducedMotion: 'reduce',
        });
        context.setDefaultTimeout(20000);
        page = await context.newPage();
        await page.goto(f.url);
      }
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.getByLabel('Message Relay', { exact: true }).fill('Keep my Main draft');
      await page.getByRole('button', { name: 'Show chats', exact: true }).click();
      await page.getByRole('button', { name: 'New group chat', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'New group chat' });
      await expect(dialog.getByRole('button', { name: 'Start group chat' })).toBeDisabled();
      await dialog.getByLabel('Group name (optional)', { exact: true }).fill('Little team');
      await dialog.getByRole('checkbox', { name: 'Mochi', exact: true }).check();
      await dialog.getByRole('checkbox', { name: 'Pip', exact: true }).check();
      await page.screenshot({ path: join(evidence, `groups-create-${label}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      await dialog.getByRole('button', { name: 'Start group chat' }).click();
      const composer = page.getByLabel('Message Little team', { exact: true });
      await expect(composer).toBeVisible();
      const group = f.store.read().threads.find((t) => t.participantIds);
      expect(group.participantIds).toEqual([mochi.id, pip.id]);
      await composer.fill('@P');
      await expect(page.getByRole('option', { name: 'Pip', exact: true })).toBeVisible();
      await composer.press('Enter');
      await expect(page.getByRole('button', { name: 'Remove Pip recipient' })).toBeVisible();
      await composer.fill('Please ask which tone to use.');
      await page.reload();
      await expect(composer).toHaveValue('Please ask which tone to use.');
      await expect(page.getByRole('button', { name: 'Remove Pip recipient' })).toBeVisible();
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Friendly', exact: true })).toBeVisible({
        timeout: 30000,
      });
      await composer.fill('Keep my group draft');
      await page.screenshot({ path: join(evidence, `groups-question-${label}.png`) });
      await page.getByRole('button', { name: 'Friendly', exact: true }).click();
      const resultText = 'Pip: Your friendly plan is ready. Start with one small step.';
      await expect(page.locator('.messages').getByText(resultText, { exact: true })).toBeVisible({
        timeout: 30000,
      });
      expect(f.store.read().files.find((x) => x.name === 'friendly-plan.md')?.text).toContain(
        'Start with one small step.',
      );
      const result = f.store.read().messages.find((m) => m.text === resultText);
      await expect(page.locator(`#message-${result.id} .message-name`)).toHaveText('Pip');
      await expect(composer).toHaveValue('Keep my group draft');
      await page
        .locator(`#message-${result.id}`)
        .getByRole('button', { name: 'Message actions', exact: true })
        .click();
      await page
        .locator(`#message-${result.id}`)
        .getByRole('button', { name: 'Reply to message', exact: true })
        .click();
      await composer.fill('Expand that point.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(
        page.locator('.messages').getByText('Pip: Here is a little more detail.', { exact: true }),
      ).toBeVisible();
      const reply = f.store.read().messages.find((m) => m.text === 'Expand that point.');
      expect(reply.quoted.id).toBe(result.id);
      expect(reply.recipientIds).toEqual([pip.id]);
      await composer.fill('Please review this plan.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(
        page.locator('.messages').getByText('Mochi: I reviewed the plan.', { exact: true }),
      ).toBeVisible();
      await composer.fill('@every');
      await page.getByRole('option', { name: 'Everyone', exact: true }).click();
      await composer.fill('Share a next step.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(
        page.locator('.messages').getByText('Mochi: My next step is ready.', { exact: true }),
      ).toBeVisible();
      await expect(
        page.locator('.messages').getByText('Pip: My next step is ready.', { exact: true }),
      ).toBeVisible();
      expect(
        f.store
          .read()
          .messages.filter((m) => m.text.endsWith('My next step is ready.'))
          .map((m) => m.assistantId),
      ).toEqual([mochi.id, pip.id]);
      await page.screenshot({ path: join(evidence, `groups-result-${label}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      await composer.fill('Keep my group draft');
      await page.getByRole('button', { name: 'Back to main chat', exact: true }).click();
      await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
        'Keep my Main draft',
      );
      await page.getByRole('button', { name: 'Show chats', exact: true }).click();
      await page.getByRole('button', { name: 'Little team', exact: true }).click();
      await expect(composer).toHaveValue('Keep my group draft');
      await page.getByRole('button', { name: 'Group participants', exact: true }).click();
      const details = page.getByRole('dialog', { name: 'Group details' });
      await details.getByRole('checkbox', { name: 'Relay', exact: true }).check();
      await details.getByRole('button', { name: 'Save group', exact: true }).click();
      await expect(details).not.toBeVisible();
      expect(f.store.read().threads.find((t) => t.id === group.id).participantIds).toEqual([
        mochi.id,
        pip.id,
        'relay',
      ]);
      await composer.fill('@Mo');
      await expect(page.getByRole('option', { name: 'Mochi', exact: true })).toBeVisible();
      await composer.press('Enter');
      await expect(page.getByRole('button', { name: 'Remove Mochi recipient' })).toBeVisible();
      await composer.fill('Keep this directed draft');
      await expect(composer).toHaveValue('Keep this directed draft');
      await page.reload();
      await expect(composer).toHaveValue('Keep this directed draft');
      await expect(page.getByRole('button', { name: 'Remove Mochi recipient' })).toBeVisible();
      act('profile.update', { theme: 'dark' });
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page.screenshot({ path: join(evidence, `groups-dark-${label}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      expect(errors).toEqual([]);
      checks.push({
        surface: label,
        passed: true,
        checks: [
          'Create two-participant group in one picker',
          'Keyboard and touch mentions; multiple recipients',
          'Model chooses a role for undirected request',
          'Inline question resumes its author and saves file',
          'Quoted reply targets author',
          'Distinct sender labels',
          'Draft and recipient persistence across reload/navigation',
          'Edit membership',
          'Light/dark accessibility and viewport fit',
        ],
        nativeFilePickerVerified: false,
      });
      console.log(
        `PASS ${label}: group creation, mentions, model routing, inline question/file, replies, drafts, membership and accessibility`,
      );
    } catch (e) {
      if (page)
        await page
          .screenshot({ path: join(evidence, `groups-failure-${label}.png`) })
          .catch(() => {});
      throw e;
    } finally {
      if (app) await app.close();
      if (context) await context.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, native ? 'groups-native-acceptance.json' : 'groups-ui-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        scope:
          'Isolated real Relay HTTP server, SQLite worker and controlled model. Fictional roles and files; no claim of hosted-model judgment or physical-device acceptance.',
        checks,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
}
