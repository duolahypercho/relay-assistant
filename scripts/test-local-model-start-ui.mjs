// SPDX-License-Identifier: MIT
// Explicit startup, real installed Ollama inference, persistence and owned-process cleanup.
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { localModelStartFixture } from './local-model-start-fixture.mjs';
import { ollamaProbe } from '../server/local-model-runtime.mjs';
const modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS;
const model = process.env.RELAY_LOCAL_MODEL_TEST_ID;
assert(
  modelsDirectory && model,
  'Set RELAY_LOCAL_MODEL_TEST_MODELS and RELAY_LOCAL_MODEL_TEST_ID.',
);
const native = process.argv.includes('--mac');
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const browser = native ? null : await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const mobile of native ? [false] : [false, true]) {
    assert.equal(
      (await ollamaProbe()).occupied,
      false,
      'Never reuse or stop an existing local service.',
    );
    const label = native ? 'native-mac' : mobile ? 'phone' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-local-start-'));
    let f,
      application,
      context,
      page,
      localPort = '0';
    const errors = [];
    const launch = async () => {
      application = await electron.launch({
        executablePath: resolve(
          'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
        ),
        args: [`--relay-test-data=${directory}`, `--relay-local-port=${localPort}`],
        env: {
          ...process.env,
          RELAY_DESKTOP_ENV: '',
          RELAY_MODE: 'live',
          RELAY_ACCESS_KEY: '',
          RELAY_MODEL_BASE_URL: '',
          RELAY_MODEL_ID: '',
          RELAY_MODEL_API_KEY: '',
          OLLAMA_MODELS: modelsDirectory,
          GOOGLE_CLIENT_ID: '',
          GOOGLE_CLIENT_SECRET: '',
          RELAY_DESKTOP_ENABLED: 'false',
          RELAY_BROWSER_ENABLED: 'false',
          RELAY_COMPUTER_ENABLED: 'false',
        },
      });
      const window = await application.firstWindow({ timeout: 30000 });
      window.setDefaultTimeout(20000);
      window.on('pageerror', (e) => errors.push(e.message));
      await expect(
        window.getByRole('textbox', { name: 'Message Relay', exact: true }),
      ).toBeVisible();
      localPort = new URL(window.url()).port;
      return window;
    };
    const api = (path) => page.evaluate(async (path) => (await fetch('/api/' + path)).json(), path);
    const navigate = (hash) =>
      page.evaluate((hash) => {
        location.hash = hash;
      }, hash);
    const setup = () => page.getByRole('region', { name: 'Local model setup', exact: true });
    const composer = () => page.getByRole('textbox', { name: 'Message Relay', exact: true });
    try {
      if (native) page = await launch();
      else {
        f = await localModelStartFixture(directory, { modelsDirectory });
        context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
          isMobile: mobile,
          hasTouch: mobile,
          reducedMotion: 'reduce',
        });
        page = await context.newPage();
        page.setDefaultTimeout(20000);
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(f.url);
      }
      await composer().fill('Keep my local startup draft');
      await navigate('#settings?section=models');
      await page.getByRole('button', { name: 'Use a local model', exact: true }).click();
      await expect(
        setup().getByRole('button', { name: 'Start Ollama', exact: true }),
      ).toBeVisible();
      assert.equal((await ollamaProbe()).occupied, false, 'Discovery must not start a service.');
      assert.equal((await api('models')).connections.length, 0);
      await expect(
        setup().getByRole('checkbox', { name: 'Start Ollama with Relay', exact: true }),
      ).toBeChecked();
      await page.screenshot({ path: join(evidence, `local-model-start-ready-${label}.png`) });
      // Hold only the readiness acknowledgement; cancellation still drains a real Ollama process.
      if (f) {
        f.controls.hold = true;
        await setup().getByRole('button', { name: 'Start Ollama', exact: true }).click();
        await expect.poll(() => f.controls.starts).toBe(1);
        await expect.poll(async () => (await ollamaProbe()).running).toBe(true);
        await setup().getByRole('button', { name: 'Cancel start', exact: true }).click();
        await expect.poll(async () => (await ollamaProbe()).occupied).toBe(false);
        await expect(
          setup().getByRole('button', { name: 'Start Ollama', exact: true }),
        ).toBeVisible();
        assert.equal(f.runtime.preference().startWithRelay, false);
        f.controls.hold = false;
      }
      const started = Date.now();
      await setup().getByRole('button', { name: 'Start Ollama', exact: true }).click();
      await expect(setup().getByLabel('Local model', { exact: true })).toBeVisible({
        timeout: 30000,
      });
      await setup()
        .getByLabel('Local model', { exact: true })
        .selectOption(JSON.stringify(['ollama', model]));
      const startupMs = Date.now() - started;
      const runtime = await api('models/local/runtime');
      assert.equal(runtime.managed, true);
      assert.equal(runtime.startWithRelay, true);
      assert.equal((await api('state')).messages.length, 0);
      assert.equal((await api('models')).connections.length, 0);
      await setup().scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(evidence, `local-model-start-running-${label}.png`) });
      assert.deepEqual(
        (await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations,
        [],
      );
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await setup().getByRole('button', { name: 'Use this model', exact: true }).click();
      await expect(
        page.getByRole('button', { name: `Edit Ollama · ${model}`, exact: true }),
      ).toBeVisible();
      await navigate('#chat');
      await expect(composer()).toHaveValue('Keep my local startup draft');
      await composer().fill('Reply with exactly these words, without tools: Ready for today.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect
        .poll(async () => (await api('state')).runs.find((r) => r.threadId === 'main')?.status, {
          timeout: 180000,
        })
        .toBe('completed');
      const state = await api('state');
      const reply = state.messages.findLast((m) => m.role === 'assistant');
      assert.match(reply.text, /Ready for today/);
      assert(!reply.error);
      await composer().fill('Keep my final startup draft');
      if (native) {
        await application.close();
        application = null;
        await expect
          .poll(async () => (await ollamaProbe()).occupied, { timeout: 10000 })
          .toBe(false);
        page = await launch();
        await expect
          .poll(async () => (await api('models/local/runtime')).managed, { timeout: 30000 })
          .toBe(true);
        assert.equal((await api('models')).active, (await api('models')).connections[0].id);
      } else await page.reload();
      await expect(composer()).toHaveValue('Keep my final startup draft');
      await expect(page.getByText(reply.text, { exact: true })).toBeVisible();
      await page.screenshot({ path: join(evidence, `local-model-start-reply-${label}.png`) });
      await navigate('#settings?section=models');
      await page.getByRole('button', { name: 'Use a local model', exact: true }).click();
      await setup().getByText('Startup options', { exact: true }).click();
      await expect(
        setup().getByRole('checkbox', { name: 'Start Ollama with Relay', exact: true }),
      ).toBeChecked();
      await setup()
        .getByRole('checkbox', { name: 'Start Ollama with Relay', exact: true })
        .uncheck();
      await expect.poll(async () => (await api('models/local/runtime')).startWithRelay).toBe(false);
      assert.equal(
        (await ollamaProbe()).running,
        true,
        'Changing next-start preference must not stop current work.',
      );
      await setup().getByRole('button', { name: 'Cancel', exact: true }).click();
      await navigate('#settings?section=personal');
      await page.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption('dark');
      await navigate('#settings?section=models');
      await page.getByRole('button', { name: 'Use a local model', exact: true }).click();
      await expect(setup().getByLabel('Local model', { exact: true })).toBeVisible();
      assert.deepEqual(
        (await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations,
        [],
      );
      await page.screenshot({ path: join(evidence, `local-model-start-dark-${label}.png`) });
      assert.deepEqual(errors, []);
      checks.push({
        surface: label,
        passed: true,
        model,
        startupMs,
        realInference: reply.text,
        checks: [
          'Discovery starts nothing',
          'Explicit startup selects no model and creates no chat messages',
          'Actual installed Ollama and local inference',
          'Draft and connection persistence',
          'Light/dark accessibility and overflow',
          'Changing auto-start leaves the current engine running',
        ],
        lifecycle: native
          ? 'Packaged local backend, full quit drains Ollama, relaunch auto-starts saved preference'
          : 'Real server-managed Ollama; actual startup cancellation and process cleanup',
      });
      console.log(`PASS ${label}: real Ollama startup and inference (${startupMs} ms startup)`);
    } finally {
      await application?.close();
      await context?.close();
      await f?.close();
      await expect.poll(async () => (await ollamaProbe()).occupied, { timeout: 10000 }).toBe(false);
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(
      evidence,
      native ? 'local-model-start-native-mac.json' : 'local-model-start-ui-acceptance.json',
    ),
    JSON.stringify({ checkedAt: new Date().toISOString(), checks }, null, 2),
  );
} finally {
  await browser?.close();
}
