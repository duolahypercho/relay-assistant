// SPDX-License-Identifier: MIT
// Isolated conversational edits, with a controlled HTTP model or actual local inference.
import assert from 'node:assert/strict';
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { assistantsFixture } from './assistants-fixture.mjs';
import { localModelStartFixture } from './local-model-start-fixture.mjs';
import { routineCommand } from '../shared/routines.mjs';
import { androidReminderClient } from './android-reminder-client.mjs';

const live = process.argv.includes('--live'),
  mac = process.argv.includes('--mac'),
  nativeAndroid = process.argv.includes('--android');
assert(!(mac && nativeAndroid));
assert(
  !(live && nativeAndroid),
  'Run local inference separately from the software-rendered emulator.',
);
const model = process.env.RELAY_REMINDER_TEST_MODEL,
  modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS;
if (live) assert(model && modelsDirectory, 'Choose an installed model and independent cache.');
const evidence = resolve(
  process.env.RELAY_EVIDENCE_DIR ||
    `../relay-evidence/reminder-changes/${live ? 'live' : mac ? 'mac' : nativeAndroid ? 'android' : 'browser'}`,
);
await mkdir(evidence, { recursive: true });
const report = {
  passed: false,
  checkedAt: new Date().toISOString(),
  model: live ? model : 'controlled HTTP fixture',
  surface: mac ? 'packaged Mac' : nativeAndroid ? 'Android APK' : 'browser',
  scope:
    'Actual rendered chat, tools, SQLite and worker. Synthetic reminders; no physical audio or device-notification claim.',
  checks: [],
  requests: [],
};
const browser =
  mac || nativeAndroid ? null : await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const width of nativeAndroid ? [360] : live || mac ? [1365] : [1365, 390]) {
    const directory = await mkdtemp(join(tmpdir(), 'relay-reminder-changes-'));
    let f,
      androidClient,
      app,
      context,
      page,
      phase = 'ambiguous',
      patch;
    const tool = (name, args) => ({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } },
      ],
    });
    function configure(store) {
      store.mutate((s) => {
        s.profile.memoryLearning = false;
        s.profile.timeZone = 'Asia/Shanghai';
        for (const [title, instructions] of [
          ['Morning water', 'Drink water.'],
          ['Morning stretch', 'Stretch your legs.'],
        ]) {
          const r = routineCommand(s, 'routine.create', {
            title,
            instructions,
            execution: 'reminder',
            threadId: 'main',
            schedule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' },
          });
          routineCommand(s, 'routine.resume', { id: r.id });
        }
      });
    }
    try {
      f = live
        ? await localModelStartFixture(directory, {
            modelsDirectory,
            isolatedPort: 41334,
            configure,
          })
        : await assistantsFixture(directory, {
            configure,
            respond({ messages }) {
              const last = messages.at(-1);
              if (last.role !== 'tool') return tool('list_routines', {});
              const previous = messages.findLast((m) => m.tool_calls)?.tool_calls.at(-1)
                .function.name;
              if (previous !== 'list_routines') return { role: 'assistant', content: 'Done.' };
              if (phase === 'ambiguous')
                return tool('ask_question', {
                  prompt: 'Which morning reminder?',
                  options: [{ label: 'Morning water' }, { label: 'Morning stretch' }],
                });
              const target = JSON.parse(last.content).result.find(
                (r) => r.title === 'Morning water',
              );
              return tool('change_reminder', {
                id: target.id,
                changeToken: target.changeToken,
                ...patch,
              });
            },
          });
      if (live) {
        await f.runtime.start({ revision: f.runtime.preference().revision, startWithRelay: false });
        f.provider.save({
          preset: 'ollama',
          baseUrl: 'http://127.0.0.1:11434/v1',
          model,
          protocol: 'chat',
          replyMode: 'default',
          apiKey: '',
          activate: true,
        });
        const fetcher = f.provider.fetcher;
        f.provider.fetcher = async (url, init) => {
          if (url.endsWith('/chat/completions')) report.requests.push(JSON.parse(init.body));
          return fetcher(url, init);
        };
      }
      const original = structuredClone(f.store.read().routines),
        waterId = original.find((r) => r.title === 'Morning water').id,
        stretch = original.find((r) => r.title === 'Morning stretch');
      const water = () => f.store.read().routines.find((r) => r.id === waterId);
      if (mac) {
        const data = join(directory, 'desktop');
        await mkdir(data);
        await writeFile(join(data, 'desktop.json'), JSON.stringify({ server: f.url }));
        app = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${data}`],
        });
        context = app.context();
        page = await app.firstWindow();
      } else if (nativeAndroid) {
        androidClient = await androidReminderClient();
        report.native = {
          avd: androidClient.avd,
          apkSha256: androidClient.apkSha256,
          webView: androidClient.webView,
          fingerprint: androidClient.fingerprint,
        };
        page = await androidClient.connect(f.url);
      } else {
        context = await browser.newContext({
          viewport: { width, height: 950 },
          isMobile: width < 600,
          hasTouch: width < 600,
          reducedMotion: 'reduce',
        });
        page = await context.newPage();
        await page.goto(f.url);
      }
      page.setDefaultTimeout(15000);
      async function capture(name, target) {
        await androidClient?.hideKeyboard(page);
        await target.scrollIntoViewIfNeeded();
        await expect(target).toBeVisible();
        await page.evaluate(
          () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
        );
        await (androidClient || page).screenshot({ path: join(evidence, `${name}-${width}.png`) });
      }
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      async function waitRun(id, name, started) {
        await expect
          .poll(() => f.store.read().runs.find((r) => r.id === id)?.status, {
            timeout: live ? 240000 : 20000,
            intervals: [100, 500, 1000],
          })
          .toMatch(/^(completed|waiting|failed)$/);
        const s = f.store.read(),
          run = s.runs.find((r) => r.id === id);
        const check = {
          name,
          width,
          elapsedMs: Date.now() - started,
          status: run.status,
          answer: s.messages.findLast((m) => m.replyTo === run.messageId)?.text,
          state: structuredClone(s.routines),
          passed: false,
        };
        report.checks.push(check);
        assert.notEqual(run.status, 'failed', JSON.stringify(run));
        return { check, run, source: s.messages.find((m) => m.id === run.messageId) };
      }
      async function send(name, text, value) {
        phase = name;
        patch = value;
        const started = Date.now();
        await page.locator('.composer textarea').fill(text);
        await page
          .getByRole('button', { name: 'Send message', exact: true })
          .click({ noWaitAfter: nativeAndroid });
        await expect
          .poll(() => f.store.read().messages.some((m) => m.role === 'user' && m.text === text))
          .toBe(true);
        const source = f.store
          .read()
          .messages.findLast((m) => m.role === 'user' && m.text === text);
        const run = f.store.read().runs.find((r) => r.messageId === source.id);
        return waitRun(run.id, name, started);
      }
      const ambiguous = await send('ambiguous', 'Move my morning reminder to 10 AM.');
      assert.equal(ambiguous.run.status, 'completed');
      assert.deepEqual(f.store.read().routines, original);
      const q = f.store.read().questions.find((q) => q.status === 'pending');
      assert(q);
      const option = q.options.find((o) => /water/i.test(o.label));
      assert(option, JSON.stringify(q));
      ambiguous.check.passed = true;
      await capture('clarification', page.locator('.question-card'));
      phase = 'choose';
      patch = {
        action: 'update',
        schedule: { kind: 'daily', time: '10:00', timeZone: 'Asia/Shanghai' },
      };
      const before = new Set(f.store.read().runs.map((r) => r.id)),
        started = Date.now();
      await page
        .locator('.question-card')
        .getByRole('button', {
          name: new RegExp(option.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        })
        .click({ noWaitAfter: nativeAndroid });
      await expect.poll(() => f.store.read().runs.some((r) => !before.has(r.id))).toBe(true);
      const choice = await waitRun(
        f.store.read().runs.find((r) => !before.has(r.id)).id,
        'choose-water',
        started,
      );
      assert.equal(water().schedule.time, '10:00');
      assert.equal(water().paused, false);
      choice.check.passed = true;
      const moved = await send(
        'relative',
        'Change the morning water reminder to a one-time reminder ten minutes from now.',
        { action: 'update', delayMinutes: 10 },
      );
      assert.equal(water().schedule.kind, 'once');
      assert.equal(water().schedule.at, Date.parse(moved.source.createdAt) + 600000);
      assert.equal(water().paused, false);
      moved.check.passed = true;
      const paused = await send('pause', 'Pause the morning water reminder.', { action: 'pause' });
      assert.equal(water().paused, true);
      paused.check.passed = true;
      const oldTime = water().schedule.at;
      const edited = await send(
        'text',
        'Change the morning water reminder text. Use the reminder text exactly: Time for water.',
        { action: 'update', text: 'Time for water' },
      );
      assert.equal(water().instructions, 'Time for water.');
      assert.equal(water().schedule.at, oldTime);
      assert.equal(water().paused, true);
      edited.check.passed = true;
      const resumed = await send('resume', 'Resume the morning water reminder.', {
        action: 'resume',
      });
      assert.equal(water().paused, false);
      resumed.check.passed = true;
      await capture('updated', page.getByRole('article', { name: 'Reminder', exact: true }).last());
      const cancelled = await send('cancel', '取消喝水提醒。', { action: 'cancel' });
      assert.equal(water().archived, true);
      assert.equal(water().paused, true);
      cancelled.check.passed = true;
      assert.equal(f.store.read().routines.length, 2);
      assert.deepEqual(
        f.store.read().routines.find((r) => r.id === stretch.id),
        stretch,
      );
      const composer = page.locator('.composer textarea');
      await composer.fill('My unfinished message 原文');
      await expect.poll(() => f.store.read().threads[0].draft).toBe('My unfinished message 原文');
      const messages = f.store.read().messages.length;
      const card = page.getByRole('article', { name: 'Reminder', exact: true }).last();
      await expect(page.getByRole('article', { name: 'Reminder', exact: true })).toHaveCount(1);
      await expect(card.getByRole('status')).toHaveText('Cancelled');
      assert.equal(await page.getByRole('dialog').count(), 0);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      assert.deepEqual(
        (await new AxeBuilder({ page }).setLegacyMode(mac || nativeAndroid).analyze()).violations,
        [],
      );
      await capture('cancelled', card);
      await card
        .getByRole('button', { name: 'Details', exact: true })
        .click({ noWaitAfter: nativeAndroid });
      await expect(page).toHaveURL(/#routines$/);
      await page
        .getByRole('button', { name: 'Back to chat', exact: true })
        .click({ noWaitAfter: nativeAndroid });
      await page.reload();
      await expect(composer).toHaveValue('My unfinished message 原文');
      if (nativeAndroid) {
        report.native.reloads = 1;
        // Exercise teardown repeatedly: an old AOSP WebView crashed in its IO
        // thread on reload. A successful relaunch alone must not hide this.
        for (let index = 0; index < 4; index++) {
          await page.reload();
          await expect(page.locator('.composer textarea')).toHaveValue(
            'My unfinished message 原文',
          );
          await expect(
            page.getByRole('article', { name: 'Reminder', exact: true }).getByRole('status'),
          ).toHaveText('Cancelled');
          report.native.reloads++;
        }
        page = await androidClient.relaunch(f.url);
        await expect(page.locator('.composer textarea')).toHaveValue('My unfinished message 原文');
        await expect(
          page.getByRole('article', { name: 'Reminder', exact: true }).getByRole('status'),
        ).toHaveText('Cancelled');
        report.native.relaunch = true;
      }
      assert.equal(f.store.read().messages.length, messages);
      assert.deepEqual(errors, []);
      console.log(
        `PASS ${width}: clarification, reschedule, pause, text edit, resume and Chinese cancellation`,
      );
    } catch (error) {
      await page?.screenshot({ path: join(evidence, `failure-${width}.png`) }).catch(() => {});
      throw error;
    } finally {
      await app?.close();
      await androidClient?.close();
      if (!app) await context?.close();
      await f?.close();
      await rm(directory, { recursive: true, force: true });
      if (androidClient) {
        const diagnostics = await androidClient.diagnostics();
        await writeFile(join(evidence, 'native-crash.log'), diagnostics.crashLog);
        report.native.crashes = diagnostics.crashes;
        assert.deepEqual(diagnostics.crashes, [], 'Relay crashed in the Android runtime.');
      }
    }
  }
  report.passed = true;
} finally {
  await writeFile(join(evidence, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close();
}
