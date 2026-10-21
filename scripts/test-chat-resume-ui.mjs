// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect as baseExpect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setupProcess } from '../server/computer-setup.mjs';
import { chatResumeFixture } from './chat-resume-fixture.mjs';
const expect = baseExpect.configure({ timeout: 20000 });
const profile = process.env.RELAY_ENGINE_TEST_PROFILE,
  mac = process.argv.includes('--mac');
assert(
  profile && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile),
  'Select the explicit stopped acceptance Colima profile.',
);
const host = `unix://${join(homedir(), '.colima', profile, 'docker.sock')}`,
  configFile = join(homedir(), '.colima', profile, 'colima.yaml');
const config = await readFile(configFile),
  initialContext = (await setupProcess('docker', ['context', 'show'])).stdout.trim();
async function status() {
  const r = await setupProcess('colima', ['list', '--json']);
  assert.equal(r.exitCode, 0);
  return r.stdout
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .find((r) => r.name === profile)?.status;
}
assert.equal(await status(), 'Stopped');
const evidence = resolve('../relay-evidence'),
  checks = [];
await mkdir(evidence, { recursive: true });
const browser = mac ? null : await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const mobile of mac ? [false] : [false, true]) {
    const surface = mac ? 'native-mac' : mobile ? 'phone' : 'desktop',
      directory = await mkdtemp(join(tmpdir(), 'relay-chat-resume-'));
    const f = await chatResumeFixture(directory, { host });
    let app, context, page;
    const errors = [];
    try {
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
          viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
          isMobile: mobile,
          hasTouch: mobile,
        });
        page = await context.newPage();
        await page.goto(f.url);
      }
      page.on('pageerror', (e) => errors.push(e.message));
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true }),
        start = page.getByRole('button', { name: 'Start & resume', exact: true });
      await expect(start).toBeVisible();
      assert.equal(f.controls.starts, 0);
      assert.equal(f.requests.length, 0);
      await page.screenshot({ path: join(evidence, `chat-resume-sleeping-${surface}.png`) });
      // Delay the POST, capture a stale poll during it, then deliver that poll
      // after the POST completes. The cancel control must not disappear.
      let allowPost,
        deliverPoll,
        staleCaptured,
        postEntered,
        postStarted = false;
      const entered = new Promise((r) => {
        postEntered = r;
      });
      const captured = new Promise((r) => {
        staleCaptured = r;
      });
      await page.route(
        '**/api/computer/engine/resume',
        async (route) => {
          postStarted = true;
          postEntered();
          await new Promise((r) => {
            allowPost = r;
          });
          await route.fulfill({ response: await route.fetch() });
        },
        { times: 1 },
      );
      let capturedOnce = false;
      await page.route('**/api/computer/engine', async (route) => {
        if (capturedOnce || !postStarted) return route.continue();
        capturedOnce = true;
        const response = await route.fetch();
        staleCaptured();
        await new Promise((r) => {
          deliverPoll = r;
        });
        await route.fulfill({ response });
      });
      f.controls.mode = 'hold';
      await start.click();
      await entered;
      await captured;
      allowPost();
      await expect(page.getByRole('button', { name: 'Cancel resume', exact: true })).toBeVisible();
      deliverPoll();
      await page.unrouteAll({ behavior: 'wait' });
      await expect(page.getByRole('button', { name: 'Cancel resume', exact: true })).toBeVisible();
      await expect(page.getByText('Waking your computer…', { exact: true })).toBeVisible();
      await composer.fill('Hello after I resume');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect.poll(() => f.store.read().messages.length).toBe(1);
      await composer.fill(`Keep my ${surface} resume draft`);
      await page.reload();
      await expect(page.getByRole('button', { name: 'Cancel resume', exact: true })).toBeVisible();
      await page.screenshot({ path: join(evidence, `chat-resume-progress-${surface}.png`) });
      await expect(composer).toHaveValue(`Keep my ${surface} resume draft`);
      assert.equal(f.requests.length, 0);
      assert.equal(f.computer.controller, 'owner');
      await page.getByRole('button', { name: 'Cancel resume', exact: true }).click();
      await expect(
        page.getByText('Resume cancelled. You are still in control.', { exact: true }),
      ).toBeVisible();
      assert.equal(await status(), 'Stopped');
      f.controls.mode = 'fail';
      await start.click();
      await expect(page.getByRole('alert')).toContainText('could not resume');
      assert(
        !(await page
          .locator('body')
          .innerText()
          .then((t) => t.includes('Private runtime diagnostic'))),
      );
      assert.equal(f.requests.length, 0);
      assert.equal(f.computer.controller, 'owner');
      assert.equal(await status(), 'Stopped');
      f.controls.mode = 'real';
      await start.click();
      await expect(page.getByText('Ready. We can continue.', { exact: true })).toBeVisible({
        timeout: 180000,
      });
      await expect(start).toHaveCount(0);
      assert.equal(f.requests.length, 1);
      assert.equal(f.requests[0].controller, 'agent');
      assert.equal((await f.computer.status()).state, 'running');
      assert.equal(f.computer.controller, 'agent');
      assert.equal(f.controls.starts, 3);
      assert.equal(f.store.read().messages.length, 2);
      await expect(composer).toHaveValue(`Keep my ${surface} resume draft`);
      await page.reload();
      await expect(composer).toHaveValue(`Keep my ${surface} resume draft`);
      assert.equal(f.requests.length, 1);
      assert.deepEqual(
        (await new AxeBuilder({ page }).setLegacyMode(mac).analyze()).violations,
        [],
      );
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
      await f.computer.takeControl();
      await f.computer.perform(
        {
          kind: 'exec',
          command: "printf 'Retained after resume' > resume-check.txt",
          operationId: 'resume-check',
        },
        { actor: 'owner' },
      );
      const desktopId = (await f.computer.inspect()).Id;
      await f.computer.stop();
      await page.reload();
      await expect(start).toBeVisible();
      await start.click();
      await expect.poll(() => f.computer.controller, { timeout: 60000 }).toBe('agent');
      assert.equal(f.controls.starts, 3);
      assert.equal(f.requests.length, 1);
      assert.equal((await f.computer.inspect()).Id, desktopId);
      assert.equal(
        Buffer.from((await f.computer.read('resume-check.txt')).base64, 'base64').toString(),
        'Retained after resume',
      );
      await expect(start).toHaveCount(0);
      await page.screenshot({ path: join(evidence, `chat-resume-${surface}.png`) });
      checks.push({
        surface,
        passed: true,
        checks: [
          'No startup or inference while inspecting recovery',
          'Queued message stays paused during wake, reload, cancellation and failure',
          'Late pre-start status cannot overwrite an acknowledged resume',
          'One explicit Start & resume starts real selected Colima and opens a restricted desktop',
          'One handback releases one queued reply without page navigation',
          'Draft and conversation preserved across reload; no setup history',
          'Stopped desktop resumes on running engine with same container/files and no extra VM start',
          'Axe, viewport fit and runtime errors',
        ],
      });
      console.log('PASS', surface, 'chat resume with real Colima');
    } finally {
      await app?.close();
      await context?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
      if ((await status()) === 'Running')
        assert.equal(
          (await setupProcess('colima', ['stop', '--profile', profile], { timeout: 90000 }))
            .exitCode,
          0,
        );
    }
  }
} finally {
  await browser?.close();
  assert.equal(await status(), 'Stopped');
  assert.deepEqual(await readFile(configFile), config);
  assert.equal((await setupProcess('docker', ['context', 'show'])).stdout.trim(), initialContext);
}
await writeFile(
  join(evidence, `chat-resume-${mac ? 'mac' : 'ui'}-acceptance.json`),
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      passed: true,
      profile,
      profileRestored: 'Stopped',
      profileConfigUnchanged: true,
      dockerContextUnchanged: true,
      scope:
        'Actual Colima/Docker workspace and worker, independent controlled HTTP model. No owner computer handback.',
      checks,
    },
    null,
    2,
  ),
);
