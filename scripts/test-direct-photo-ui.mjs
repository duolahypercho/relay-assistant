// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { modelCapabilitiesFixture } from './model-capabilities-fixture.mjs';
import { avatarFixture } from '../tests/fixtures/avatar.mjs';
import { command } from '../shared/domain.mjs';
const native = process.argv.includes('--mac'),
  evidence = resolve('../relay-evidence'),
  checks = [];
await mkdir(evidence, { recursive: true });
const photos = [
  avatarFixture({ metadata: false }),
  avatarFixture({ width: 80, height: 120, metadata: false }),
];
const browser = native ? null : await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const mobile of native ? [false] : [false, true]) {
    const surface = native ? 'native-mac' : mobile ? 'phone' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-direct-photos-'));
    const f = await modelCapabilitiesFixture(directory);
    let app, context, page;
    const errors = [];
    try {
      if (native) {
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
          reducedMotion: 'reduce',
        });
        page = await context.newPage();
        await page.goto(f.url);
      }
      page.on('pageerror', (e) => errors.push(e.message));
      const go = (hash) =>
        page.evaluate((hash) => {
          location.hash = hash;
        }, hash);
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
      await composer.fill('Keep my photo draft');
      await go('#settings?section=models');
      await page.getByRole('button', { name: 'Use a local model', exact: true }).click();
      const setup = page.getByRole('region', { name: 'Local model setup', exact: true });
      await setup
        .getByLabel('Local model', { exact: true })
        .selectOption(JSON.stringify(['ollama', 'photo-chat']));
      await expect(setup).toContainText('Chat, photos & documents · Attach a file and ask.');
      assert.equal(f.requests.length, 0);
      await page.screenshot({ path: join(evidence, `direct-photo-setup-${surface}.png`) });
      await setup.getByRole('button', { name: 'Use this model', exact: true }).click();
      await go('#chat/main');
      await expect(composer).toHaveValue('Keep my photo draft');
      await page.locator('.composer input[type=file]').setInputFiles(
        photos.map((buffer, i) => ({
          name: `Photo ${i + 1}.png`,
          mimeType: 'image/png',
          buffer,
        })),
      );
      await expect(
        page.locator('.composer .draft-attachments button[aria-label="Remove attachment"]'),
      ).toHaveCount(2);
      await page.reload();
      await expect(composer).toHaveValue('Keep my photo draft');
      await composer.fill('Compare these two photos.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(
        page.getByText('I received 2 attached photos directly.', { exact: true }),
      ).toBeVisible();
      const pixels = (body) =>
        body.messages
          .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
          .filter((p) => p.type === 'image_url')
          .map((p) => p.image_url.url);
      assert.deepEqual(
        pixels(f.requests[0]),
        photos.map((p) => 'data:image/png;base64,' + p.toString('base64')),
      );
      assert.equal(f.requests[0].tools, undefined);
      assert(!JSON.stringify(f.requests[0]).includes('attachmentIds'));
      await page.reload();
      await composer.fill('What about the second photo?');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect.poll(() => f.requests.length).toBe(2);
      await expect.poll(() => f.store.read().runs.at(-1)?.status).toBe('completed');
      assert.deepEqual(pixels(f.requests[1]), pixels(f.requests[0]));
      await composer.fill('Keep this unfinished photo question');
      await page.screenshot({ path: join(evidence, `direct-photo-chat-${surface}.png`) });
      assert.deepEqual(
        (await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations,
        [],
      );
      const side = f.store.mutate((s) => command(s, 'thread.create', { title: 'Separate photos' }));
      await go(`#chat/${side.id}`);
      await expect(composer).toHaveValue('');
      await composer.fill('Hello');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect.poll(() => f.requests.length).toBe(3);
      assert.equal(pixels(f.requests[2]).length, 0);
      await go('#chat/main');
      await expect(composer).toHaveValue('Keep this unfinished photo question');
      await go('#settings?section=models');
      await page.getByRole('button', { name: 'Use a local model', exact: true }).click();
      await setup
        .getByLabel('Local model', { exact: true })
        .selectOption(JSON.stringify(['ollama', 'text-chat']));
      await setup.getByRole('button', { name: 'Use this model', exact: true }).click();
      await go('#chat/main');
      await composer.fill('Hello without looking at photos');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect.poll(() => f.requests.length).toBe(4);
      assert.equal(pixels(f.requests[3]).length, 0);
      assert(JSON.stringify(f.requests[3]).includes('bytes are not included'));
      await page
        .locator('.composer input[type=file]')
        .setInputFiles({ name: 'New photo.png', mimeType: 'image/png', buffer: photos[0] });
      await composer.fill('Read this new photo');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(page.getByText(/This model cannot read images/)).toBeVisible();
      assert.equal(f.requests.length, 4);
      assert.equal(f.store.read().files.length, 3);
      assert.equal(f.store.read().memories.length, 0);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
      checks.push({
        surface,
        passed: true,
        checks: [
          'Native composer photo upload and persisted draft',
          'Multiple exact images reach model with no tools',
          'Follow-up retains photos after reload',
          'Side chat does not receive main-chat photos',
          'Switch to text model preserves chat and explicitly omits older images',
          'New unsupported photo fails before inference, original file retained',
          'Accessibility, viewport, no page errors',
        ],
      });
      console.log('PASS', surface, 'direct photo conversation');
    } finally {
      await app?.close();
      await context?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
} finally {
  await browser?.close();
}
await writeFile(
  join(evidence, `direct-photo-${native ? 'native-mac' : 'ui'}-acceptance.json`),
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      passed: true,
      checks,
      scope:
        'Production UI, SQLite and worker with independent HTTP vision-only provider. Live inference is a separate check.',
    },
    null,
    2,
  ),
);
