// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { assistantsFixture } from './assistants-fixture.mjs';
import { command } from '../shared/domain.mjs';
const evidence = resolve('../relay-evidence'),
  native = process.env.RELAY_HANDOFFS_NATIVE === 'true';
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
      directory = await mkdtemp(join(tmpdir(), 'relay-handoff-ui-'));
    let target,
      release,
      held = false;
    const f = await assistantsFixture(directory, {
      respond: async ({ messages }) => {
        const system = messages[0].content,
          all = JSON.stringify(messages),
          last = messages.at(-1);
        if (system.startsWith('You are Mochi,')) {
          if (all.includes('Wait for the cancellation check.')) {
            held = true;
            await new Promise((r) => {
              release = r;
            });
            return { role: 'assistant', content: 'Late answer that must be discarded.' };
          }
          if (!all.includes('Saved questions and my answers:'))
            return tool('ask_question', {
              prompt: 'What should I focus on?',
              options: [
                { label: 'Make it simpler', description: 'Reduce steps in the first screen.' },
                { label: 'Check the wording', description: 'Keep the instructions friendly.' },
              ],
            });
          if (last.role !== 'tool')
            return tool('write_note', {
              name: 'mochi-review.md',
              text: '# Mochi review\n\nUse one clear first step.',
            });
          return {
            role: 'assistant',
            content: 'My review is ready: use one clear first step. The note is saved.',
          };
        }
        if (all.includes('Continue the original request using this specialist result.'))
          return {
            role: 'assistant',
            content: 'Mochi finished the review. We can start with one clear first step.',
          };
        if (last.role !== 'tool') return tool('list_assistants', {});
        return tool('ask_assistant', {
          assistantId: target.id,
          title: all.includes('wait for me') ? 'Wait for my next step' : 'Review the first screen',
          request: all.includes('wait for me')
            ? 'Wait for the cancellation check.'
            : 'Review this fictional onboarding plan. Ask which aspect needs attention.',
        });
      },
    });
    target = f.store.mutate((s) =>
      command(s, 'assistant.create', {
        name: 'Mochi',
        description: 'Review clarity and ease of use.',
        tone: 'Warm',
        avatarColor: '#a0c5ac',
        appearance: { kind: 'shape', shape: 'puff' },
      }),
    );
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
      const composer = page.getByLabel('Message Relay', { exact: true });
      await expect(composer).toBeVisible({ timeout: 30000 });
      await composer.fill('Ask Mochi to review the first screen.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      const card = page.getByRole('group', { name: 'Request to Mochi', exact: true });
      await expect(card.getByRole('button', { name: 'Make it simpler', exact: false })).toBeVisible(
        { timeout: 30000 },
      );
      expect(() => f.provider.remove(f.provider.publicState().active)).toThrow(
        /answering a request/,
      );
      await expect(card.locator('..').locator('.message-actions')).toHaveCount(0);
      await composer.fill('Keep this Main draft');
      await page.screenshot({ path: join(evidence, `handoff-question-${label}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      await page.reload();
      await expect(composer).toHaveValue('Keep this Main draft');
      await card.getByRole('button', { name: 'Make it simpler', exact: false }).click();
      await expect(
        page.getByText('Mochi finished the review. We can start with one clear first step.', {
          exact: true,
        }),
      ).toBeVisible({ timeout: 30000 });
      await expect(composer).toHaveValue('Keep this Main draft');
      await expect(card.getByRole('status')).toHaveText('Ready');
      await expect(
        card.getByRole('button', { name: 'mochi-review.md', exact: true }),
      ).toBeVisible();
      const h = f.store.read().handoffs[0];
      expect(f.store.read().files.find((x) => x.id === h.result.fileIds[0]).text).toContain(
        'one clear first step',
      );
      await card.getByRole('button', { name: 'Open conversation', exact: true }).click();
      await expect(page.getByText('Request from Relay', { exact: true })).toBeVisible();
      await expect(page.getByLabel('Message Mochi', { exact: true })).toBeVisible();
      await page.getByLabel('Message Mochi', { exact: true }).fill('Keep this specialist draft');
      await page.getByRole('button', { name: 'Back to main chat', exact: true }).click();
      await expect(composer).toHaveValue('Keep this Main draft');
      await page.screenshot({ path: join(evidence, `handoff-result-${label}.png`) });
      const mainBefore = f.store
        .read()
        .messages.filter((m) => m.threadId === 'main' && m.role === 'user');
      expect(mainBefore).toHaveLength(1);
      await composer.fill('Ask Mochi to wait for me.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect.poll(() => held, { timeout: 30000 }).toBe(true);
      await composer.fill('Another thought to keep');
      const second = page.getByRole('group', { name: 'Request to Mochi', exact: true }).last();
      await second.getByRole('button', { name: 'Stop request', exact: true }).click();
      await expect(second.getByRole('status')).toHaveText('Stopped');
      release();
      await expect.poll(() => f.worker.active.size).toBe(0);
      await expect.poll(() => f.store.read().handoffs.at(-1).returnSuppressed).toBe(true);
      await expect(composer).toHaveValue('Another thought to keep');
      expect(
        f.store.read().messages.some((m) => m.text === 'Late answer that must be discarded.'),
      ).toBe(false);
      f.store.mutate((s) => command(s, 'profile.update', { theme: 'dark' }));
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page.screenshot({ path: join(evidence, `handoff-dark-${label}.png`) });
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
          'model discovery and asynchronous handoff',
          'inline specialist question and answer',
          'Main and specialist drafts survive navigation/reload',
          'saved file returned and parent resumes once',
          'visible sender attribution',
          'stop discards late provider result',
          'light/dark accessibility and viewport fit',
        ],
        nativeFilePickerVerified: false,
      });
      console.log(
        `PASS ${label}: handoff, inline question, result, drafts, cancellation and accessibility`,
      );
    } catch (e) {
      if (page)
        await page
          .screenshot({ path: join(evidence, `handoff-failure-${label}.png`) })
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
    join(evidence, native ? 'handoffs-native-acceptance.json' : 'handoffs-ui-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        scope:
          'Isolated real Relay server, SQLite worker and controlled HTTP model. Fictional roles/files; no external messages or live-provider quality claim.',
        checks,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
}
