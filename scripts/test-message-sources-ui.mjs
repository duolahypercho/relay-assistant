// SPDX-License-Identifier: MIT
// Controlled model decisions; real connected document reads, worker checkpoints,
// file creation, HTTP delivery and UI. No live-model reasoning claim.
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assistantsFixture } from './assistants-fixture.mjs';
import { appContentFixture } from './app-content-fixture.mjs';
import { inspectVoiceResultOnAndroid } from './voice-result-android.mjs';
import { Connectors } from '../server/connectors.mjs';
import { modelVaultKey } from '../server/model-connections.mjs';
import { command } from '../shared/domain.mjs';

const mac = process.argv.includes('--mac');
const android = process.argv.includes('--android');
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence/message-sources');
await mkdir(evidence, { recursive: true });
const browser = mac ? null : await chromium.launch({ channel: 'chrome', headless: true });
const reports = [];
const briefText = 'Meet at noon in Cedar 358. Bring a sketchbook. Budget: $33.';
try {
  for (const width of mac ? [1280] : android ? [390] : [1365, 390, 320]) {
    const surface = mac ? 'mac' : android ? 'android' : `web-${width}`;
    const report = { surface, passed: false };
    reports.push(report);
    const dir = await mkdtemp(join(tmpdir(), 'relay-message-sources-'));
    const remote = await appContentFixture();
    let connection,
      room,
      phase = 0,
      sequence = 0,
      followup = 0;
    const tool = (name, args) => ({
      id: `source-${++sequence}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    });
    const respond = (...calls) => ({ role: 'assistant', content: '', tool_calls: calls });
    const f = await assistantsFixture(dir, {
      async configure(store, services) {
        store.mutate((s) => command(s, 'profile.update', { memoryLearning: false }));
        room = store.mutate((s) =>
          command(s, 'file.add', {
            name: 'Meeting room.txt',
            mime: 'text/plain',
            text: 'Cedar 358',
          }),
        );
        services.connectors = new Connectors(store, { key: modelVaultKey(dir) });
        const discovered = await services.connectors.discover({
          name: 'Little library',
          endpoint: remote.endpoint,
          token: remote.token,
        });
        connection = services.connectors.save({
          discoveryId: discovered.discoveryId,
          permissions: Object.fromEntries(
            discovered.connection.tools.map((t) => [t.name, t.ownerChoice ? 'ask' : 'auto']),
          ),
        }).connections[0];
      },
      respond({ messages }) {
        if (messages.findLast((m) => m.role === 'user')?.content.includes('Which room again?')) {
          return ++followup === 1
            ? respond(tool('read_file', { id: room.id }))
            : { role: 'assistant', content: 'The room is Cedar 358.' };
        }
        phase++;
        if (phase === 1)
          return respond(
            tool('read_file', { id: room.id }),
            tool('use_app_tool', {
              connectionId: connection.id,
              revision: connection.revision,
              toolName: connection.tools.find((t) => t.contentTarget?.uri?.includes('Budget.csv'))
                .name,
              arguments: {},
            }),
          );
        if (phase === 2)
          return respond(
            tool('read_file', { id: room.id }),
            tool('write_note', { name: 'Meeting brief.txt', text: briefText }),
          );
        if (phase === 3) return respond(tool('read_file', { name: 'Meeting brief.txt' }));
        return {
          role: 'assistant',
          content:
            'Your checked meeting brief is attached. Meet at noon in Cedar 358, bring a sketchbook, and allow $33.',
        };
      },
    });
    let app, context, page;
    try {
      if (mac) {
        const desktop = join(dir, 'desktop');
        await mkdir(desktop);
        await writeFile(join(desktop, 'desktop.json'), JSON.stringify({ server: f.url }));
        app = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${desktop}`],
        });
        context = app.context();
        page = await app.firstWindow();
      } else {
        context = await browser.newContext({
          viewport: { width, height: 900 },
          isMobile: width < 600,
          hasTouch: width < 600,
          reducedMotion: 'reduce',
          locale: 'en-US',
        });
        page = await context.newPage();
        await page.goto(f.url);
      }
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const input = page.locator('.composer textarea');
      await input.fill(
        'Use the budget and meeting room note to write a text brief, then check the file.',
      );
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect.poll(() => f.store.read().runs[0]?.status).toBe('completed');
      assert.equal(phase, 4);
      const brief = f.store.read().files.find((file) => file.name === 'Meeting brief.txt');
      assert(brief);
      const result = f.store.read().messages.findLast((m) => m.role === 'assistant');
      assert.equal(result.cards.filter((c) => c.purpose === 'source').length, 2);
      assert.equal(result.cards.filter((c) => c.kind === 'file' && !c.purpose).length, 1);
      assert.equal(remote.calls.length, 1);
      const before = f.store.read().messages;
      const draft = 'Keep my next thought.';
      await input.fill(draft);
      await input.blur();

      async function inspectChat(target) {
        const message = target.locator('.message.assistant').last();
        await expect(message.locator('.rich-card')).toHaveCount(1);
        await expect(message.locator('.rich-card')).toContainText('Meeting brief.txt');
        const sources = message.getByRole('group', { name: 'Sources', exact: true });
        await expect(sources.getByRole('button')).toHaveCount(2);
        await expect(sources).toContainText('Budget.csv');
        assert(
          await message.evaluate(
            (el) =>
              el
                .querySelector('.rich-card')
                .compareDocumentPosition(el.querySelector('.message-sources')) &
              Node.DOCUMENT_POSITION_FOLLOWING,
          ),
        );
        await sources.getByRole('button', { name: 'Meeting room.txt', exact: true }).click();
        await expect(target.locator('.document-preview')).toContainText('Cedar 358');
        await target.getByRole('button', { name: 'Back to chat', exact: true }).click();
        await expect(target.locator('.composer textarea')).toHaveValue(draft);
        await sources.getByRole('button', { name: 'Budget.csv', exact: true }).click();
        const budget = f.store.read().files.find((file) => file.name === 'Budget.csv');
        const bytes = await target.evaluate(
          async (id) =>
            Array.from(new Uint8Array(await (await fetch('/api/files/' + id)).arrayBuffer())),
          budget.id,
        );
        assert.deepEqual(Buffer.from(bytes), remote.csv);
        await target.getByRole('button', { name: 'Back to chat', exact: true }).click();
        assert.deepEqual(f.store.read().messages, before);
        assert(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      }
      await inspectChat(page);
      await page.reload();
      await expect(input).toHaveValue(draft);
      await expect(page.locator('.message-sources button')).toHaveCount(2);
      assert.deepEqual(
        (await new AxeBuilder({ page }).setLegacyMode(mac).analyze()).violations,
        [],
      );
      await page.screenshot({ path: join(evidence, `${surface}-light.png`) });
      if (android) {
        report.native = await inspectVoiceResultOnAndroid({
          url: f.url,
          file: brief,
          bytes: Buffer.from(briefText),
          evidence,
          draft: 'Continue from my Android phone.',
          inspectChat,
        });
        await expect(input).toHaveValue('Continue from my Android phone.');
      } else {
        await page.locator('.message.assistant .rich-card').click();
        await expect(page.locator('.document-preview')).toContainText(briefText);
        await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
        f.store.mutate((s) => command(s, 'profile.update', { theme: 'dark' }));
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        assert.deepEqual(
          (await new AxeBuilder({ page }).setLegacyMode(mac).analyze()).violations,
          [],
        );
        await page.screenshot({ path: join(evidence, `${surface}-dark.png`) });
        await input.fill('Which room again?');
        await page.getByRole('button', { name: 'Send message', exact: true }).click();
        await expect.poll(() => f.store.read().runs.at(-1)?.status).toBe('completed');
        const readOnly = page.locator('.message.assistant').last();
        await expect(readOnly.locator('.rich-card')).toHaveCount(0);
        await expect(readOnly.locator('.message-sources button')).toHaveCount(1);
        await page.evaluate(() => localStorage.setItem('relay.ui-language', 'zh-CN'));
        await page.reload();
        await expect(page.getByRole('group', { name: '来源', exact: true }).last()).toBeVisible();
        await page.screenshot({ path: join(evidence, `${surface}-source-only.png`) });
      }
      assert.deepEqual(errors, []);
      report.passed = true;
      report.sources = result.cards.filter((c) => c.purpose === 'source').length;
      report.results = 1;
    } catch (error) {
      report.error = error.stack;
      if (error.androidReport) report.native = error.androidReport;
      await page?.screenshot({ path: join(evidence, `${surface}-failure.png`) }).catch(() => {});
      throw error;
    } finally {
      if (app) await app.close();
      else await context?.close();
      await f.close();
      await remote.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
} finally {
  await browser?.close();
  await writeFile(
    join(evidence, `${mac ? 'mac' : android ? 'android' : 'web'}-acceptance.json`),
    JSON.stringify({ scope: 'Controlled model; real execution and UI', reports }, null, 2) + '\n',
  );
}
console.log(JSON.stringify(reports));
