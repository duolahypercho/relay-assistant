// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { assistantsFixture } from './assistants-fixture.mjs';
import { command } from '../shared/domain.mjs';
import { appendAssistant } from '../shared/assistant.mjs';
import { profileSnapshot } from '../shared/assistant-scope.mjs';
const evidence = resolve('../relay-evidence'),
  native = process.env.RELAY_REPLIES_NATIVE === 'true';
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
    const label = native ? 'native-mac' : mobile ? 'mobile' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-reply-ui-'));
    const f = await assistantsFixture(directory, {
      respond: async ({ messages }) => {
        const system = messages[0].content,
          all = JSON.stringify(messages);
        if (system.startsWith('You are Pip,'))
          return {
            role: 'assistant',
            content: 'Pip: We can keep Saturday free and plan just Sunday.',
          };
        if (system.startsWith('You are Mochi,'))
          return {
            role: 'assistant',
            content: 'Mochi: A little picnic would make a lovely afternoon.',
          };
        if (all.includes('Refine the original plan.')) {
          if (!all.includes('Saved questions and my answers:'))
            return tool('ask_question', {
              prompt: 'Which day should we plan?',
              options: [{ label: 'Saturday' }, { label: 'Sunday' }],
            });
          if (messages.at(-1).role !== 'tool')
            return tool('write_note', {
              name: 'sunday-plan.md',
              text: '# Our Sunday\n\nA slow breakfast, then a walk by the water.',
            });
          return {
            role: 'assistant',
            content:
              'Sunday is yours: a slow breakfast, a walk by the water, and the afternoon free. I saved the plan for you.',
          };
        }
        return { role: 'assistant', content: 'Ready in Main.' };
      },
    });
    const act = (a, p) => f.store.mutate((s) => command(s, a, p));
    const root = (threadId, text, assistantId = 'relay') =>
      f.store.mutate((s) =>
        appendAssistant(
          s,
          threadId,
          { text, cards: [] },
          {},
          { assistant: profileSnapshot(s, assistantId) },
        ),
      );
    const mainRoot = root(
      'main',
      'A little weekend plan: breakfast somewhere new, a walk by the water, and plenty of time to do nothing.',
    );
    const mochi = act('assistant.create', {
      name: 'Mochi',
      description: 'Review ideas gently.',
      tone: 'Gentle',
      avatarColor: '#a0c5ac',
    });
    const pip = act('assistant.create', {
      name: 'Pip',
      description: 'Make little plans.',
      tone: 'Warm',
      avatarColor: '#c7a5d6',
    });
    const group = act('group.create', { title: 'Little team', participantIds: [mochi.id, pip.id] });
    const groupRoot = root(
      group.id,
      'Let’s keep our weekend simple, with one thing to look forward to.',
      pip.id,
    );
    const parentMessages = f.store
      .read()
      .messages.filter((m) => ['main', group.id].includes(m.threadId));
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
      const composer = () => page.locator('.composer textarea');
      const attachment = (name) =>
        page.locator('.composer .attachment-list').getByText(name, { exact: true });
      async function upload(name) {
        await page.locator('.composer input[type=file]').setInputFiles({
          name,
          mimeType: 'text/plain',
          buffer: Buffer.from(name + ' private draft'),
        });
        await expect(attachment(name)).toBeVisible();
      }
      async function openThread(message) {
        const row = page.locator(`#message-${message.id}`);
        if (mobile) await row.getByRole('button', { name: 'Message actions', exact: true }).click();
        else await row.hover();
        await row.getByRole('button', { name: 'Reply in thread', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Thread', exact: true })).toBeVisible();
      }
      async function send(text) {
        await composer().fill(text);
        await page.getByRole('button', { name: /^(Send message|Queue follow-up)$/ }).click();
      }
      async function groupChat() {
        await page.getByRole('button', { name: 'Show chats', exact: true }).click();
        await page.getByRole('button', { name: 'Little team', exact: true }).click();
      }
      await composer().fill('Keep my Main draft');
      await upload('main-draft.txt');
      await openThread(mainRoot);
      const child = f.store.read().threads.find((t) => t.replyTo?.message.id === mainRoot.id);
      await expect(composer()).toHaveValue('');
      await expect(attachment('main-draft.txt')).toHaveCount(0);
      await expect(page.locator('.thread-original')).toContainText(mainRoot.text);
      await composer().fill('Keep my thread draft');
      await upload('thread-draft.txt');
      await page.reload();
      await expect(composer()).toHaveValue('Keep my thread draft');
      await expect(attachment('thread-draft.txt')).toBeVisible();
      await page.getByRole('button', { name: 'Back to conversation', exact: true }).click();
      await expect(composer()).toHaveValue('Keep my Main draft');
      await expect(attachment('main-draft.txt')).toBeVisible();
      await expect(page.locator(`#message-${mainRoot.id}`)).toHaveClass(/search-match/);
      await page
        .locator(`#message-${mainRoot.id}`)
        .getByRole('button', { name: 'Open thread', exact: true })
        .click();
      await expect(composer()).toHaveValue('Keep my thread draft');
      await page.goBack();
      await expect(composer()).toHaveValue('Keep my Main draft');
      await page.goForward();
      await expect(composer()).toHaveValue('Keep my thread draft');
      await page.getByRole('button', { name: 'Files', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Your files', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(composer()).toHaveValue('Keep my thread draft');
      await expect(attachment('thread-draft.txt')).toBeVisible();
      await send('Refine the original plan.');
      await expect(page.getByRole('button', { name: 'Sunday', exact: true })).toBeVisible({
        timeout: 30000,
      });
      await composer().fill('A thought for later');
      await page.reload();
      await expect(composer()).toHaveValue('A thought for later');
      await page.getByRole('button', { name: 'Sunday', exact: true }).click();
      const result =
        'Sunday is yours: a slow breakfast, a walk by the water, and the afternoon free. I saved the plan for you.';
      await expect(page.locator('.messages').getByText(result, { exact: true })).toBeVisible({
        timeout: 30000,
      });
      await expect(composer()).toHaveValue('A thought for later');
      await expect(attachment('thread-draft.txt')).toHaveCount(0);
      const childState = f.store.read();
      expect(childState.messages.filter((m) => ['main', group.id].includes(m.threadId))).toEqual(
        parentMessages,
      );
      expect(
        childState.messages.find((m) => m.threadId === child.id && m.role === 'user').fileIds,
      ).toHaveLength(1);
      expect(childState.files.find((file) => file.name === 'sunday-plan.md').text).toContain(
        'water',
      );
      if (!mobile) {
        const shortReply = page
          .locator('.message.user')
          .filter({ has: page.getByText('Sunday', { exact: true }) });
        await shortReply.hover();
        const time = await shortReply.locator('.message-actions time').boundingBox();
        expect(time.height).toBeLessThan(22);
        await composer().hover();
      }
      await page.screenshot({ path: join(evidence, `reply-thread-result-${label}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      await page.getByRole('button', { name: 'Show chats', exact: true }).click();
      await expect(
        page.locator('.conversation-list').getByRole('button', { name: child.title, exact: true }),
      ).toHaveCount(0);
      await page.getByRole('button', { name: 'Find in your space', exact: true }).click();
      await page.getByLabel('Search your workspace').fill('Sunday is yours');
      await expect(page.locator('.search-result small')).toContainText('Thread ·');
      await page.locator('.search-result').click();
      await expect(page.locator('.search-match')).toContainText('Sunday is yours');
      await expect(composer()).toHaveValue('A thought for later');
      await groupChat();
      await composer().fill('Keep our group draft');
      await openThread(groupRoot);
      await expect(page.getByText('Replies go to Pip', { exact: true })).toBeVisible();
      await send('Keep Saturday free.');
      await expect(
        page
          .locator('.messages')
          .getByText('Pip: We can keep Saturday free and plan just Sunday.', { exact: true }),
      ).toBeVisible({ timeout: 30000 });
      await composer().fill('@Mochi');
      await page.getByRole('option', { name: 'Mochi', exact: true }).click();
      await send('What would make the afternoon nice?');
      await expect(
        page
          .locator('.messages')
          .getByText('Mochi: A little picnic would make a lovely afternoon.', { exact: true }),
      ).toBeVisible({ timeout: 30000 });
      const groupChild = f.store.read().threads.find((t) => t.replyTo?.message.id === groupRoot.id);
      expect(
        f.store
          .read()
          .runs.filter((r) => r.threadId === groupChild.id)
          .map((r) => r.assistant.id),
      ).toEqual([pip.id, mochi.id]);
      await composer().fill('Keep this thought');
      await upload('group-thread.txt');
      await page.getByRole('button', { name: 'Back to conversation', exact: true }).click();
      await expect(composer()).toHaveValue('Keep our group draft');
      await page
        .locator(`#message-${groupRoot.id}`)
        .getByRole('button', { name: '4 replies', exact: true })
        .click();
      await expect(composer()).toHaveValue('Keep this thought');
      await expect(attachment('group-thread.txt')).toBeVisible();
      act('thread.update', { id: group.id, archived: true });
      await expect(
        page.getByText('This conversation is archived.', { exact: false }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Restore conversation', exact: true }).click();
      await expect(page.locator('.thread-archived')).toHaveCount(0);
      act('thread.update', { id: group.id, archived: true });
      await page.getByRole('button', { name: 'Files', exact: true }).click();
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await page.getByLabel('Search your workspace').fill('archived chats');
      await page.getByLabel('Search your workspace').press('Enter');
      await expect(
        page.locator('.settings-row h3').getByText(group.title, { exact: true }),
      ).toBeVisible();
      await expect(
        page.locator('.settings-row h3').getByText(groupChild.title, { exact: true }),
      ).toHaveCount(0);
      await page
        .locator('.settings-row')
        .filter({ has: page.getByRole('heading', { name: group.title, exact: true }) })
        .getByRole('button', { name: 'Restore', exact: true })
        .click();
      await page
        .locator(`#message-${groupRoot.id}`)
        .getByRole('button', { name: '4 replies', exact: true })
        .click();
      await expect(composer()).toHaveValue('Keep this thought');
      await page.locator('.thread-original summary').click();
      await expect(
        page.getByRole('button', { name: 'View original message', exact: true }),
      ).toBeVisible();
      await page.locator('.thread-original summary').click();
      act('profile.update', { theme: 'dark' });
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page.screenshot({ path: join(evidence, `reply-thread-group-dark-${label}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      expect(errors).toEqual([]);
      expect(
        f.store.read().messages.filter((m) => ['main', group.id].includes(m.threadId)),
      ).toEqual(parentMessages);
      checks.push({
        surface: label,
        passed: true,
        checks: [
          'message-level thread opening',
          'independent text and attachment drafts across reload/navigation',
          'original message anchor and browser history',
          'inline question and saved file',
          'main/group transcript unchanged',
          'search finds thread replies; sidebar excludes threads',
          'default original speaker and explicit other participant',
          'archive follows parent and restore works',
          'light/dark accessibility and viewport fit',
        ],
      });
      console.log(
        `PASS ${label}: threads, drafts, attachments, questions, group routing, navigation and accessibility`,
      );
    } catch (e) {
      if (page)
        await page
          .screenshot({ path: join(evidence, `reply-thread-failure-${label}.png`) })
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
    join(
      evidence,
      native ? 'reply-thread-native-acceptance.json' : 'reply-thread-ui-acceptance.json',
    ),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        scope:
          'Isolated Relay server, SQLite worker and controlled HTTP model. Verifies application behavior, not hosted model quality or native phone interaction.',
        checks,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
}
