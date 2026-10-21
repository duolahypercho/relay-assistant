// SPDX-License-Identifier: MIT
// One owner action -> real private install, runtime and local inference. Cached model reuse is explicit.
import { chromium, _electron as electron, expect as baseExpect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir, cp } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { localModelInstallFixture } from './local-model-install-fixture.mjs';
import { ollamaRelease } from '../server/local-model-installation.mjs';
const expect = baseExpect.configure({ timeout: 20000 });
const modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS;
const model = process.env.RELAY_LOCAL_MODEL_TEST_ID;
assert(modelsDirectory && model, 'Use an explicit, already-downloaded test model cache.');
const native = process.argv.includes('--mac'),
  live = process.argv.includes('--live'),
  pull = process.argv.includes('--pull'),
  recovery = process.argv.includes('--recovery');
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const browser = native ? null : await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const mobile of native || live || pull ? [false] : [false, true]) {
    const label = native
      ? 'native-mac'
      : live
        ? 'live'
        : pull
          ? 'pull'
          : mobile
            ? 'phone'
            : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-install-acceptance-'));
    const cache = pull ? join(directory, 'models') : modelsDirectory;
    if (pull)
      await cp(join(modelsDirectory, 'blobs'), join(cache, 'blobs'), {
        recursive: true,
        mode: constants.COPYFILE_FICLONE,
      });
    const f = await localModelInstallFixture(directory, {
      modelsDirectory: cache,
      isolatedPort: 41334,
      enableDownloads: true,
      live,
      setupSuggestion: {
        model,
        name: model,
        size: 'existing test cache',
        url: 'https://ollama.com/library/' + model,
      },
    });
    let context, app, page;
    const errors = [];
    try {
      if (native) {
        const userData = join(directory, 'desktop');
        await mkdir(userData);
        await writeFile(join(userData, 'desktop.json'), JSON.stringify({ server: f.url }));
        app = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${userData}`],
        });
        page = await app.firstWindow();
        await app.evaluate(({ BrowserWindow }) => {
          for (const w of BrowserWindow.getAllWindows()) w.hide();
        });
      } else {
        context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 675 } : { width: 1365, height: 900 },
          isMobile: mobile,
          hasTouch: mobile,
          reducedMotion: 'reduce',
        });
        page = await context.newPage();
        await page.goto(f.url);
      }
      page.on('pageerror', (error) => errors.push(error.message));
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
      const local = page.getByRole('region', { name: 'Local model setup', exact: true });
      await composer.fill('Keep my installation draft');
      await page.getByRole('button', { name: 'Connect AI', exact: true }).click();
      await page.getByRole('button', { name: 'Use a local model', exact: true }).click();
      const start = local.getByRole('button', { name: 'Set up & use', exact: true });
      await expect(start).toBeVisible();
      assert.equal(f.delivery.requests, 0);
      assert.equal(f.controls.starts, 0);
      assert.equal(await f.installation.executable(), null);
      await page.screenshot({ path: join(evidence, `local-quick-first-${label}.png`) });
      assert.deepEqual(
        (await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations,
        [],
      );
      await start.click();
      if (!live) {
        await expect(local.getByRole('progressbar')).toBeVisible();
        await expect.poll(() => f.installation.state.completed).toBeGreaterThan(0);
        await page.screenshot({ path: join(evidence, `local-quick-progress-${label}.png`) });
        await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
        await expect(composer).toHaveValue('Keep my installation draft');
        assert.equal(
          f.installation.state.phase,
          'running',
          'Leaving setup must not cancel an explicit install.',
        );
        await page.getByRole('button', { name: 'Connect AI', exact: true }).click();
        await page.reload();
        await page.getByRole('button', { name: 'Use a local model', exact: true }).click();
        await expect(local.getByRole('progressbar')).toBeVisible();
        await local.getByRole('button', { name: 'Cancel setup', exact: true }).click();
        await expect(local.getByText('Setup cancelled.', { exact: false })).toBeVisible();
        assert.deepEqual(await readdir(f.installation.root), []);
        f.delivery.mode = 'fail';
        await local.getByRole('button', { name: 'Continue setup', exact: true }).click();
        await expect(local.getByRole('alert')).toContainText('installation did not finish');
        assert.equal(f.controls.starts, 0);
        f.delivery.mode = 'ready';
        if (recovery) await page.route('**/api/models', (route) => route.abort('connectionfailed'));
        await local.getByRole('button', { name: 'Continue setup', exact: true }).click();
      }
      await expect
        .poll(() => f.setup.status().job?.connected, { timeout: 180000, intervals: [500] })
        .toBe(true);
      assert.equal(f.installation.state.phase, 'ready');
      assert((await f.installation.executable()).startsWith(directory + '/runtimes/ollama/'));
      assert.equal(f.controls.starts, 1);
      assert.equal(f.provider.model, model);
      if (pull) assert.equal(f.downloads.status().download?.phase, 'ready');
      assert.equal(f.store.read().messages.length, 0);
      if (recovery) {
        const done = local.getByRole('button', { name: 'Done', exact: true });
        await expect(done).toBeVisible();
        await done.click();
        await expect(local.getByRole('alert')).toContainText('Your model is already connected.');
        assert.equal(f.provider.publicState().connections.length, 1);
        await page.unroute('**/api/models');
        await done.click();
      }
      await expect(page).toHaveURL(/#chat$/);
      await expect(composer).toHaveValue('Keep my installation draft');
      assert.equal(f.store.read().messages.length, 0);
      await composer.fill('Say hello in one short sentence.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect
        .poll(() => f.store.read().runs.at(-1)?.status, { timeout: 180000, intervals: [1000] })
        .toBe('completed');
      const reply = f.store.read().messages.find((message) => message.role === 'assistant')?.text;
      assert(reply?.trim().length > 0);
      await expect(page.locator('.message.assistant .message-content')).toContainText(
        reply.split('\n\n')[0],
      );
      await page.screenshot({ path: join(evidence, `local-quick-chat-${label}.png`) });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      assert.deepEqual(errors, []);
      assert.equal(f.store.read().messages.filter((m) => m.role === 'user').length, 1);
      checks.push({
        label,
        passed: true,
        release: ollamaRelease.version,
        sha256: ollamaRelease.sha256,
        model,
        actualRuntime: true,
        actualInference: true,
        artifactDelivery: live
          ? 'Official HTTPS release through production downloader'
          : 'Locally cached official archive through controlled transport',
        historyUnchangedDuringSetup: true,
        cancellationAndRetry: !live,
        returnedToDraft: true,
        singleSetupAction: true,
        activationRefreshRecovery: recovery,
        cachedModelReused: !pull,
        actualRegistryPullWithCachedBlobs: pull,
      });
    } finally {
      await app?.close();
      await context?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(
      evidence,
      `local-quick-${native ? 'mac' : live ? 'live' : pull ? 'pull' : recovery ? 'recovery' : 'ui'}-acceptance.json`,
    ),
    JSON.stringify({ checkedAt: new Date().toISOString(), passed: true, checks }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} finally {
  await browser?.close();
}
