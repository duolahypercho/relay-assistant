// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect as baseExpect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { localModelSetupFixture } from './local-model-setup-fixture.mjs';
import { modelsFixture } from './models-fixture.mjs';
const expect = baseExpect.configure({ timeout: 20000 });
const native = process.argv.includes('--mac');
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const browser = native ? null : await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const mobile of native ? [false] : [false, true]) {
    const surface = native ? 'native-mac' : mobile ? 'phone' : 'desktop';
    for (const kind of ['local', 'custom']) {
      const directory = await mkdtemp(join(tmpdir(), 'relay-chat-setup-'));
      const f = await (kind === 'local' ? localModelSetupFixture : modelsFixture)(directory);
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
            for (const window of BrowserWindow.getAllWindows()) window.hide();
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
        const connect = page.getByRole('button', { name: 'Connect AI', exact: true });
        const panel = page.getByRole('article', { name: 'AI models', exact: true });
        await expect(connect).toBeVisible();
        await expect(
          page.getByRole('button', { name: 'Take care of a form', exact: true }),
        ).toBeHidden();
        assert.equal(f.requests.length, 0);
        const buttonBox = await connect.boundingBox();
        const composerBox = await composer.boundingBox();
        assert(
          buttonBox &&
            composerBox &&
            buttonBox.y >= 0 &&
            buttonBox.y + buttonBox.height <= composerBox.y,
          'First action must be reachable above the composer.',
        );
        await page.screenshot({ path: join(evidence, `chat-setup-start-${surface}.png`) });
        assert.deepEqual(
          (await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations,
          [],
        );
        await page.getByText('Try a sample first', { exact: true }).click();
        await expect(
          page.getByRole('button', { name: 'Take care of a form', exact: true }),
        ).toBeVisible();
        assert.equal(f.store.read().messages.length, 0);
        await page.getByText('Try a sample first', { exact: true }).click();
        await composer.fill('Keep this first message');
        await page.locator('.chat-pane input[type="file"]').setInputFiles({
          name: 'setup-note.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('Original onboarding note'),
        });
        await expect(
          page.getByRole('button', { name: 'Remove attachment', exact: true }),
        ).toBeVisible();
        await connect.click();
        await expect(page).toHaveURL(/#settings\?section=models&fromChat=main$/);
        await expect(
          page.getByText('Choose how to connect. Your draft stays unsent.', { exact: true }),
        ).toBeVisible();
        assert.equal(f.requests.length, 0, 'Opening setup must not probe providers.');
        await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
        await expect(composer).toHaveValue('Keep this first message');
        await connect.click();
        await page.reload();
        if (kind === 'local') {
          await panel.getByRole('button', { name: 'Use a local model', exact: true }).click();
          await page.getByRole('button', { name: 'Use this model', exact: true }).click();
        } else {
          await panel.getByRole('button', { name: 'Add a model', exact: true }).click();
          await panel.getByLabel('Provider', { exact: true }).selectOption('custom');
          await panel.getByLabel('Connection name', { exact: true }).fill('My first AI');
          await panel.getByLabel('Endpoint', { exact: true }).fill(f.baseUrl);
          await panel.getByLabel('Model', { exact: true }).fill('relay-chat-test');
          await page.route(
            '**/api/models/save',
            (route) =>
              route.fulfill({
                status: 503,
                contentType: 'application/json',
                body: JSON.stringify({ error: 'Controlled save failure. Try again.' }),
              }),
            { times: 1 },
          );
          await panel.getByRole('button', { name: 'Save & use model', exact: true }).click();
          await expect(panel.getByRole('alert')).toContainText('Controlled save failure');
          await expect(page).toHaveURL(/fromChat=main$/);
          assert.equal(f.provider.configured, false);
          await panel.getByRole('button', { name: 'Save & use model', exact: true }).click();
        }
        await expect(page).toHaveURL(/#chat$/);
        await expect(composer).toHaveValue('Keep this first message');
        await expect(
          page.getByRole('button', { name: 'Remove attachment', exact: true }),
        ).toBeVisible();
        await expect(connect).toHaveCount(0);
        assert.equal(f.store.read().messages.length, 0);
        assert.equal(f.store.read().files.length, 1);
        assert(
          f.requests.every((r) => r.method === 'GET' || r.url?.endsWith('/api/show')),
          'Setup must not send a model inference request.',
        );
        await page.getByRole('button', { name: 'Remove attachment', exact: true }).click();
        await composer.fill('Hello from my first chat');
        await page.getByRole('button', { name: 'Send message', exact: true }).click();
        await expect(
          page.getByText(
            kind === 'local'
              ? 'Your local model is connected. We can keep talking here.'
              : 'This reply came through your saved chat connection.',
            { exact: true },
          ),
        ).toBeVisible();
        await expect.poll(() => f.store.read().messages.length).toBe(2);
        await composer.fill('Keep the next draft');
        await page.reload();
        await expect(composer).toHaveValue('Keep the next draft');
        // Ordinary settings never inherit this return intent, including selecting Off.
        await page.getByRole('button', { name: 'Model connected', exact: true }).click();
        await panel.getByLabel('Active connection', { exact: true }).selectOption('');
        await expect(page).toHaveURL(/#settings\?section=models$/);
        await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
        await expect(
          page.getByText('You’re trying sample responses.', { exact: true }),
        ).toBeVisible();
        await expect(composer).toHaveValue('Keep the next draft');
        // Return to the exact originating side chat, including after a reload.
        const created = await page.request.post(f.url + '/api/command', {
          data: { action: 'thread.create', payload: { title: 'A side thought' } },
        });
        const { result: side } = await created.json();
        await page.goto(f.url + '/#chat/' + side.id);
        await composer.fill('Keep my side draft');
        await connect.click();
        await page.reload();
        const connection = f.provider.publicState().connections[0];
        await panel.getByLabel('Active connection', { exact: true }).selectOption(connection.id);
        await expect(page).toHaveURL(new RegExp('#chat/' + side.id + '$'));
        await expect(composer).toHaveValue('Keep my side draft');
        assert.equal(f.store.read().messages.length, 2);
        // A passive configuration refresh must never navigate out of the settings page.
        await page.getByRole('button', { name: 'Model connected', exact: true }).click();
        await panel.getByLabel('Active connection', { exact: true }).selectOption('');
        await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
        await connect.click();
        await page.request.post(f.url + '/api/models/select', { data: { id: connection.id } });
        await page.reload();
        await expect(page).toHaveURL(new RegExp('fromChat=' + side.id + '$'));
        await expect(panel.getByLabel('Active connection', { exact: true })).toHaveValue(
          connection.id,
        );
        await panel.getByLabel('Active connection', { exact: true }).selectOption('');
        await expect(page).toHaveURL(new RegExp('fromChat=' + side.id + '$'));
        // An in-flight activation cannot pull the user back after they leave setup.
        let release, entered;
        const paused = new Promise((r) => (entered = r));
        await page.route(
          '**/api/models/select',
          async (route) => {
            entered();
            await new Promise((r) => (release = r));
            await route.continue();
          },
          { times: 1 },
        );
        await panel.getByLabel('Active connection', { exact: true }).selectOption(connection.id);
        await paused;
        await page.getByRole('button', { name: 'Files', exact: true }).click();
        release();
        await expect.poll(() => f.provider.configured).toBe(true);
        await expect(page).toHaveURL(/#files$/);
        assert.equal(f.store.read().messages.length, 2);
        assert.deepEqual(
          (await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations,
          [],
        );
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.deepEqual(errors, []);
        checks.push({
          surface,
          kind,
          passed: true,
          checks: [
            'Visible first action and explicit sample disclosure',
            'Cancel/reload retains draft and original attachment; no setup inference or history',
            'Explicit activation returns to original main/side chat without sending',
            'Custom failure retry and saved connection reuse',
            'Passive refresh, Off and late completion preserve navigation',
            'Actual worker reply, accessibility and viewport fit',
          ],
        });
        console.log(`PASS ${surface} ${kind} first-chat setup`);
      } finally {
        await app?.close();
        await context?.close();
        await f.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
  await writeFile(
    join(evidence, native ? 'chat-setup-mac-acceptance.json' : 'chat-setup-ui-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        checks,
        scope:
          'Real owner APIs/SQLite/worker with controlled model transport. Mac is a packaged client; physical devices and live provider quality are separate.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
}
