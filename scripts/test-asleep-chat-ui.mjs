// SPDX-License-Identifier: MIT
// A real, explicitly selected stopped VM. Every workspace is disposable;
// no branch of this acceptance starts, stops or edits the VM.
import { chromium, _electron as electron, expect as baseExpect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setupProcess } from '../server/computer-setup.mjs';
import { chatResumeFixture } from './chat-resume-fixture.mjs';
import { localModelStartFixture } from './local-model-start-fixture.mjs';
import { ModelConnections, modelVaultKey } from '../server/model-connections.mjs';
const expect = baseExpect.configure({ timeout: 20000 });
const profile = process.env.RELAY_ENGINE_TEST_PROFILE;
const mac = process.argv.includes('--mac'),
  live = process.argv.includes('--live'),
  direct = process.argv.includes('--direct');
const recovery = !live && !direct;
assert(
  profile && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile),
  'Choose an existing stopped acceptance profile.',
);
const host = `unix://${join(homedir(), '.colima', profile, 'docker.sock')}`;
const configFile = join(homedir(), '.colima', profile, 'colima.yaml');
const config = await readFile(configFile);
const initialContext = (await setupProcess('docker', ['context', 'show'])).stdout.trim();
async function status() {
  const result = await setupProcess('colima', ['list', '--json']);
  assert.equal(result.exitCode, 0);
  return result.stdout
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .find((r) => r.name === profile)?.status;
}
assert.equal(await status(), 'Stopped');
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence');
await mkdir(evidence, { recursive: true });
const checks = [];
const browser = mac ? null : await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const mobile of mac ? [false] : [false, true]) {
    const surface = mac ? 'native-mac' : mobile ? 'phone' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-asleep-chat-'));
    const f = await chatResumeFixture(directory, { host, manualHost: mac || mobile });
    let app, context, page, local;
    let expected = 'Ready. We can continue.';
    try {
      if (live) {
        const model = process.env.RELAY_HISTORY_TEST_MODEL;
        const modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS;
        assert(model && modelsDirectory, 'Choose installed local test weights for live inference.');
        local = await localModelStartFixture(join(directory, 'model'), {
          modelsDirectory,
          isolatedPort: 41334,
        });
        await local.runtime.start({
          revision: local.runtime.preference().revision,
          startWithRelay: false,
        });
        const connected = new ModelConnections(f.store, {
          key: modelVaultKey(directory),
          fetcher: local.provider.fetcher,
        });
        connected.save({
          preset: 'ollama',
          baseUrl: 'http://127.0.0.1:11434/v1',
          model,
          protocol: 'chat',
          apiKey: '',
          activate: true,
          abilities: { tools: 'unsupported', vision: 'unsupported' },
        });
        const transport = connected.fetcher;
        connected.fetcher = (url, init) => {
          if (url.endsWith('/chat/completions'))
            f.requests.push({ controller: f.computer.controller, body: JSON.parse(init.body) });
          return transport(url, init);
        };
        f.services.provider = connected;
        expected = `CLOUD-${mobile ? '5731' : '2684'}`;
      }
      if (mac) {
        await writeFile(join(directory, 'desktop.json'), JSON.stringify({ server: f.url }));
        app = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${directory}`],
        });
        page = await app.firstWindow();
      } else {
        context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 900 },
          isMobile: mobile,
          hasTouch: mobile,
          reducedMotion: 'reduce',
        });
        page = await context.newPage();
        await page.goto(f.url);
      }
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
      const resume = page.getByRole('button', { name: 'Continue chatting', exact: true });
      await expect(resume).toBeVisible();
      assert.equal(f.requests.length, 0);
      assert.equal(f.controls.starts, 0);
      // Navigation stays separate and never releases computer control.
      await composer.fill('Show my files');
      await page.getByRole('button', { name: 'Go to Files', exact: true }).click();
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      assert.equal(f.store.read().messages.length, 0);
      assert.equal(f.computer.controller, 'owner');
      assert.equal(f.requests.length, 0);
      let mode = 'hold';
      if (recovery) {
        const inspect = f.setup.engineControl.inspect.bind(f.setup.engineControl);
        f.setup.engineControl.inspect = async (signal) => {
          const target = await inspect(signal);
          if (f.setup.engineControl.pending && f.setup.engineControl.intent === 'chat') {
            if (mode === 'hold')
              await new Promise((_, reject) => {
                if (signal.aborted) return reject(signal.reason);
                signal.addEventListener('abort', () => reject(signal.reason), { once: true });
              });
            if (mode === 'fail') return {};
          }
          return target;
        };
      }
      await composer.fill(
        live
          ? `Reply with exactly ${expected}. No other text.`
          : 'Hello while the computer is asleep',
      );
      await expect(
        page.getByText('Send to continue chatting. Your computer stays asleep.', { exact: true }),
      ).toBeVisible();
      await expect(resume).toHaveCount(0);
      const send = page.getByRole('button', {
        name: 'Send message and continue chatting',
        exact: true,
      });
      await expect(send).toBeVisible();
      assert.deepEqual(
        (await new AxeBuilder({ page }).setLegacyMode(mac).analyze()).violations,
        [],
      );
      if (mac) await page.bringToFront();
      await page.screenshot({
        path: join(
          evidence,
          `asleep-chat-before-${surface}${live ? '-live' : direct ? '-direct' : ''}.png`,
        ),
      });
      if (recovery) {
        const originalDraft = await composer.inputValue();
        await page.route('**/api/command', async (route) => {
          if (route.request().postDataJSON()?.action !== 'chat.send') return route.continue();
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Message could not be sent. Try again.' }),
          });
        });
        await send.click();
        await expect(
          page.getByText('Message could not be sent. Try again.', { exact: true }),
        ).toBeVisible();
        await expect(composer).toHaveValue(originalDraft);
        assert.equal(f.store.read().messages.length, 0);
        assert.equal(f.computer.controller, 'owner');
        assert.equal(f.setup.engineControl.pending, null);
        assert.equal(f.requests.length, 0);
        await page.unroute('**/api/command');
      }
      let started = performance.now();
      await send.click();
      await expect
        .poll(() => f.store.read().messages.filter((m) => m.role === 'user').length)
        .toBe(1);
      const draft = `Keep my ${surface} draft`;
      await composer.fill(draft);
      if (recovery) {
        assert.equal(f.requests.length, 0);
        await expect(
          page.getByRole('button', { name: 'Cancel resume', exact: true }),
        ).toBeVisible();
        await page.reload();
        await expect(
          page.getByRole('button', { name: 'Cancel resume', exact: true }),
        ).toBeVisible();
        await expect(composer).toHaveValue(draft);
        assert.equal(f.requests.length, 0);
        assert.equal(f.computer.controller, 'owner');
        await page.getByRole('button', { name: 'Cancel resume', exact: true }).click();
        await expect(
          page.getByText('Resume cancelled. You are still in control.', { exact: true }),
        ).toBeVisible();
        mode = 'fail';
        await resume.click();
        await expect(page.locator('.computer-pause-note [role=alert]')).toContainText(
          'could not resume',
        );
        assert.equal(f.requests.length, 0);
        assert.equal(f.computer.controller, 'owner');
        mode = 'real';
      }
      if (recovery) {
        started = performance.now();
        await resume.click();
      }
      await expect(page.getByText(expected, { exact: true })).toBeVisible({ timeout: 90000 });
      const elapsedMs = Math.round(performance.now() - started);
      await expect(page.locator('.computer-pause-note')).toHaveCount(0);
      assert.equal(f.computer.controller, 'agent');
      assert.equal(f.controls.starts, 0);
      assert.equal(await status(), 'Stopped');
      assert.equal(f.requests.length, 1);
      assert.equal(f.requests[0].controller, 'agent');
      if (live) assert.equal(f.requests[0].body.reasoning_effort, 'none');
      assert.equal(f.store.read().messages.length, 2);
      await expect(composer).toHaveValue(draft);
      await page.getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('button', { name: 'Computer', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Start computer', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await page.reload();
      await expect(composer).toHaveValue(draft);
      await expect(page.getByText(expected, { exact: true })).toBeVisible();
      assert.equal(f.requests.length, 1);
      assert.equal(f.store.read().messages.length, 2);
      assert.deepEqual(
        (await new AxeBuilder({ page }).setLegacyMode(mac).analyze()).violations,
        [],
      );
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
      if (mac) await page.bringToFront();
      await page.screenshot({
        path: join(
          evidence,
          `asleep-chat-after-${surface}${live ? '-live' : direct ? '-direct' : ''}.png`,
        ),
      });
      checks.push({
        surface,
        passed: true,
        elapsedMs,
        requests: f.requests.length,
        vmStarts: f.controls.starts,
        selection: mac || mobile ? 'explicit DOCKER_HOST' : 'saved host',
        model: live ? process.env.RELAY_HISTORY_TEST_MODEL : 'controlled',
        checks: [
          'send explicitly continues chat in one action',
          'navigation opens a separate page without history or handback',
          'exactly one queued reply after verified handback',
          'VM stays stopped; no start or thaw',
          'draft, conversation, separate Computer page and reload',
          'accessibility, viewport fit and no runtime errors',
          ...(recovery
            ? [
                'failed send preserves draft and owner control; cancellation, reload, failed proof and retry',
              ]
            : live
              ? ['actual local model inference']
              : ['uninterrupted one-action send']),
        ],
      });
      console.log('PASS asleep chat', surface, live ? 'live' : 'controlled', elapsedMs);
    } finally {
      await app?.close();
      await context?.close();
      await f.close();
      await local?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
} finally {
  await browser?.close();
  assert.equal(await status(), 'Stopped');
  assert.deepEqual(await readFile(configFile), config);
  assert.equal((await setupProcess('docker', ['context', 'show'])).stdout.trim(), initialContext);
}
await writeFile(
  join(
    evidence,
    `asleep-chat-${mac ? 'native-mac' : live ? 'live' : 'ui'}${direct ? '-direct' : ''}-acceptance.json`,
  ),
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      passed: true,
      checks,
      scope:
        'Pinned existing stopped local Colima VM; isolated workspaces. Running/unknown/remote engine rejection is covered separately by unit tests. Not physical-device or general model-quality certification.',
    },
    null,
    2,
  ) + '\n',
);
