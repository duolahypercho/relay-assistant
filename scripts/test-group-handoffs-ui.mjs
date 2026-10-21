// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { assistantsFixture } from './assistants-fixture.mjs';
import { command } from '../shared/domain.mjs';
const evidence = resolve('../relay-evidence'),
  native = process.env.RELAY_GROUP_HANDOFFS_NATIVE === 'true';
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
    const directory = await mkdtemp(join(tmpdir(), 'relay-group-handoff-ui-'));
    let mochi,
      pip,
      release,
      held = false;
    const f = await assistantsFixture(directory, {
      respond: async ({ messages }) => {
        const system = messages[0].content,
          all = JSON.stringify(messages);
        // Only owner messages are considered for this fixture's cancellation scenario.
        const owner =
          messages.findLast(
            (m) => m.role === 'user' && !m.content.startsWith('[Untrusted output from assistant'),
          )?.content || '';
        if (system.startsWith('You are Pip,')) {
          if (owner.includes('Keep my independent request.'))
            return { role: 'assistant', content: 'Pip: Your independent request is still here.' };
          if (!all.includes('Saved questions and my answers:'))
            return tool('ask_question', {
              prompt: 'Which tone should the plan use?',
              options: [{ label: 'Friendly' }, { label: 'Formal' }],
            });
          if (messages.at(-1).role !== 'tool')
            return tool('write_note', {
              name: 'group-plan.md',
              text: '# Our little plan\n\nStart with one clear first step.',
            });
          return { role: 'assistant', content: 'Pip: The friendly plan is ready.' };
        }
        if (system.startsWith('You are Mochi,')) {
          if (all.includes('Wait for the cancellation check.')) {
            held = true;
            await new Promise((r) => {
              release = r;
            });
            return { role: 'assistant', content: 'Late result that must never appear.' };
          }
          if (all.includes('Continue the original request using this specialist result.'))
            return {
              role: 'assistant',
              content: 'Mochi: I reviewed Pip’s plan. One clear step works well.',
            };
          return tool('ask_assistant', {
            assistantId: pip.id,
            title: 'Write a little plan',
            request: 'Write a friendly plan. Ask which tone I prefer.',
          });
        }
        if (owner.includes('Start the cancellation check.'))
          return tool('ask_assistant', {
            assistantId: mochi.id,
            title: 'Wait for my next step',
            request: 'Wait for the cancellation check.',
          });
        if (all.includes('Continue the original request using this specialist result.'))
          return {
            role: 'assistant',
            content: 'Relay: The plan and review are ready, right here.',
          };
        return tool('ask_assistant', {
          assistantId: mochi.id,
          title: 'Review our plan',
          request: 'Ask Pip to write a little plan, then review it.',
        });
      },
    });
    const act = (a, p) => f.store.mutate((s) => command(s, a, p));
    mochi = act('assistant.create', {
      name: 'Mochi',
      description: 'Review ideas and make them easier.',
      tone: 'Gentle',
      avatarColor: '#a0c5ac',
      appearance: { kind: 'shape', shape: 'puff' },
    });
    pip = act('assistant.create', {
      name: 'Pip',
      description: 'Write warm, clear plans.',
      tone: 'Warm',
      avatarColor: '#c7a5d6',
    });
    const group = act('group.create', {
      title: 'Little team',
      participantIds: ['relay', mochi.id, pip.id],
    });
    const before = f.store.read(),
      threadCount = before.threads.length;
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
      await page.getByRole('button', { name: 'Little team', exact: true }).click();
      const composer = page.getByLabel('Message Little team', { exact: true });
      async function sendTo(name, text) {
        await composer.fill('@' + name);
        await page.getByRole('option', { name, exact: true }).click();
        await composer.fill(text);
        await page.getByRole('button', { name: /^(Send message|Queue follow-up)$/ }).click();
      }
      await sendTo('Relay', 'Please write and review a little plan together.');
      await expect(page.getByRole('button', { name: 'Friendly', exact: true })).toBeVisible({
        timeout: 30000,
      });
      expect(f.store.read().handoffs).toHaveLength(2);
      expect(f.store.read().threads).toHaveLength(threadCount);
      const rootCard = page.getByRole('group', { name: 'Request to Mochi', exact: true }),
        childCard = page.getByRole('group', { name: 'Request to Pip', exact: true });
      await expect(page.getByText('Relay → Mochi', { exact: true })).toBeVisible();
      await expect(page.getByText('Mochi → Pip', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Friendly', exact: true })).toHaveCount(1);
      await expect(rootCard.locator('.question-card')).toHaveCount(0);
      await expect(childCard.locator('.question-card')).toHaveCount(0);
      await composer.fill('Keep my group draft');
      await page.screenshot({ path: join(evidence, `group-handoffs-question-${label}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      await page.reload();
      await expect(composer).toHaveValue('Keep my group draft');
      await page.getByRole('button', { name: 'Friendly', exact: true }).click();
      await expect(
        page
          .locator('.messages')
          .getByText('Relay: The plan and review are ready, right here.', { exact: true }),
      ).toBeVisible({ timeout: 30000 });
      await expect(rootCard.getByRole('status')).toHaveText('Ready');
      await expect(childCard.getByRole('status')).toHaveText('Ready');
      await expect(composer).toHaveValue('Keep my group draft');
      const result = f.store.read(),
        h = result.handoffs[0];
      for (const [name, prefix] of [
        ['Pip', 'Pip: The friendly'],
        ['Mochi', 'Mochi: I reviewed'],
        ['Relay', 'Relay: The plan'],
      ]) {
        const reply = result.messages.find((m) => m.text.startsWith(prefix));
        const label = page.locator(`#message-${reply.id} .message-name`);
        await expect(label).toHaveText(name);
        await expect(label).toBeVisible();
      }
      if (!mobile) {
        const pipReply = result.messages.find((m) => m.text.startsWith('Pip: The friendly'));
        const mochiReply = result.messages.find((m) => m.text.startsWith('Mochi: I reviewed'));
        const pipRow = page.locator(`#message-${pipReply.id}`);
        await pipRow.hover();
        const actions = await pipRow.locator('.message-actions').boundingBox();
        const nextSpeaker = await page
          .locator(`#message-${mochiReply.id} .message-name`)
          .boundingBox();
        expect(actions.y + actions.height).toBeLessThanOrEqual(nextSpeaker.y);
      }
      expect(result.files.find((file) => file.name === 'group-plan.md').text).toContain(
        'one clear first step',
      );
      expect(
        result.messages.filter(
          (m) => m.text === 'Relay: The plan and review are ready, right here.',
        ),
      ).toHaveLength(1);
      await rootCard.getByRole('button', { name: 'View reply', exact: true }).click();
      await expect(page.locator(`#message-${h.result.messageId}`)).toHaveClass(/search-match/);
      await expect(composer).toHaveValue('Keep my group draft');
      await page.screenshot({ path: join(evidence, `group-handoffs-result-${label}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      await page.getByRole('button', { name: 'Back to main chat', exact: true }).click();
      await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
        'Keep my Main draft',
      );
      expect(f.store.read().messages.filter((m) => m.threadId === 'main')).toEqual(
        before.messages.filter((m) => m.threadId === 'main'),
      );
      await page.getByRole('button', { name: 'Show chats', exact: true }).click();
      await page.getByRole('button', { name: 'Little team', exact: true }).click();
      await sendTo('Relay', 'Start the cancellation check.');
      await expect.poll(() => held, { timeout: 30000 }).toBe(true);
      await sendTo('Pip', 'Keep my independent request.');
      await composer.fill('A thought to keep');
      const cancelCard = page.getByRole('group', { name: 'Request to Mochi', exact: true }).last();
      await cancelCard.getByRole('button', { name: 'Stop request', exact: true }).click();
      await expect(cancelCard.getByRole('status')).toHaveText('Stopped');
      release();
      await expect(
        page
          .locator('.messages')
          .getByText('Pip: Your independent request is still here.', { exact: true }),
      ).toBeVisible({ timeout: 30000 });
      expect(
        f.store.read().messages.some((m) => m.text === 'Late result that must never appear.'),
      ).toBe(false);
      await expect(composer).toHaveValue('A thought to keep');
      act('profile.update', { theme: 'dark' });
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page.screenshot({ path: join(evidence, `group-handoffs-dark-${label}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      expect(errors).toEqual([]);
      expect(f.store.read().threads).toHaveLength(threadCount);
      checks.push({
        surface: label,
        passed: true,
        checks: [
          'nested handoff in one shared transcript',
          'one attributed inline question',
          'saved file and exactly one returned conclusion',
          'View reply focuses the result',
          'drafts survive reload and Main navigation',
          'stopping one request preserves unrelated queued work',
          'light/dark accessibility and viewport fit',
        ],
      });
      console.log(
        `PASS ${label}: nested group handoffs, question, results, draft preservation, scoped cancellation and accessibility`,
      );
    } catch (e) {
      if (page)
        await page
          .screenshot({ path: join(evidence, `group-handoffs-failure-${label}.png`) })
          .catch(() => {});
      throw e;
    } finally {
      release?.();
      if (app) await app.close();
      if (context) await context.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(
      evidence,
      native ? 'group-handoffs-native-acceptance.json' : 'group-handoffs-ui-acceptance.json',
    ),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        scope:
          'Isolated Relay server, SQLite worker and controlled HTTP model. This verifies application behavior, not hosted model judgment or native phone interaction.',
        checks,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
}
