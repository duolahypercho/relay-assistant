// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { modelCapabilitiesFixture } from './model-capabilities-fixture.mjs';
import { directDocumentFiles, documentFixtureReply } from './direct-document-fixtures.mjs';
const native = process.argv.includes('--mac'),
  evidence = resolve('../relay-evidence'),
  checks = [];
await mkdir(evidence, { recursive: true });
const files = await directDocumentFiles();
const browser = native ? null : await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const mobile of native ? [false] : [false, true]) {
    const surface = native ? 'native-mac' : mobile ? 'phone' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-direct-documents-'));
    const f = await modelCapabilitiesFixture(directory, {
      singleText: true,
      respond: documentFixtureReply,
    });
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
        });
        page = await context.newPage();
        await page.goto(f.url);
      }
      page.on('pageerror', (e) => errors.push(e.message));
      const go = (hash) =>
        page.evaluate((h) => {
          location.hash = h;
        }, hash);
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
      await composer.fill('Where is my meeting and what should I bring?');
      await go('#settings?section=models');
      await page.getByRole('button', { name: 'Use a local model', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Local model setup' })).toContainText(
        'Chat & documents',
      );
      assert.equal(f.requests.length, 0);
      await page.getByRole('button', { name: 'Use this model', exact: true }).click();
      await go('#chat');
      await page.locator('.composer input[type=file]').setInputFiles(files);
      await expect(
        page.getByRole('group', { name: 'Draft attachments' }).locator('.attachment-item'),
      ).toHaveCount(3);
      await page.reload();
      await expect(composer).toHaveValue('Where is my meeting and what should I bring?');
      await expect(
        page.getByRole('group', { name: 'Draft attachments' }).locator('.attachment-item'),
      ).toHaveCount(3);
      assert.equal(f.requests.length, 0);
      const send = async (text) => {
        const before = f.requests.length;
        if (text) await composer.fill(text);
        await page.getByRole('button', { name: 'Send message', exact: true }).click();
        await expect.poll(() => f.requests.length, { timeout: 15000 }).toBe(before + 1);
        await expect.poll(() => f.store.read().runs.at(-1)?.status).toBe('completed');
      };
      await send();
      await expect(
        page.getByText('Your meeting is at Willow library. Bring a green notebook.', {
          exact: true,
        }),
      ).toBeVisible();
      const checkSources = (body) => {
        const encoded = JSON.stringify(body);
        for (const fact of ['Meeting code: 7462.', 'Willow library.', 'green notebook.'])
          assert(encoded.includes(fact));
        assert.equal(body.tools, undefined);
        assert.equal((encoded.match(/<attached_document>/g) || []).length, 3);
      };
      checkSources(f.requests.at(-1));
      await page.reload();
      await send('Can you remind me what to bring?');
      checkSources(f.requests.at(-1));
      await composer.fill('Keep my next question');
      const messageCount = f.store.read().messages.length;
      await page
        .getByRole('navigation', { name: 'Workspace' })
        .getByRole('button', { name: 'Files', exact: true })
        .click();
      await expect(page.getByRole('textbox', { name: 'Message Relay', exact: true })).toHaveCount(
        0,
      );
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(composer).toHaveValue('Keep my next question');
      assert.equal(f.store.read().messages.length, messageCount);
      await page.getByRole('button', { name: 'Show chats', exact: true }).click();
      await page.getByRole('button', { name: 'New side chat', exact: true }).click();
      await send('Hello');
      assert(!JSON.stringify(f.requests.at(-1)).includes('Willow library'));
      await page.getByRole('button', { name: 'Back to main chat', exact: true }).click();
      await expect(composer).toHaveValue('Keep my next question');
      assert.equal(f.store.read().files.length, 3);
      assert.equal(f.store.read().memories.length, 0);
      for (const file of files)
        assert.equal(
          f.store.read().files.find((x) => x.name === file.name).base64,
          file.buffer.toString('base64'),
        );
      const before = f.requests.length;
      await page.locator('.composer input[type=file]').setInputFiles({
        name: 'Long note.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('x'.repeat(60001)),
      });
      await composer.fill('Read this long file');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(page.getByText(/These documents are too long for one reply/)).toBeVisible();
      assert.equal(f.requests.length, before);
      assert.equal(f.store.read().files.length, 4);
      await send('Tell me the meeting place again');
      checkSources(f.requests.at(-1));
      assert(JSON.stringify(f.requests.at(-1)).includes('Document contents are not included'));
      assert.deepEqual(
        (await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations,
        [],
      );
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
      await page.screenshot({ path: join(evidence, `direct-document-${surface}.png`) });
      checks.push({
        surface,
        passed: true,
        requests: f.requests.length,
        checks: [
          'Text, PDF and Word attached in existing composer',
          'Draft attachments survive reload before send',
          'Exact complete extracted facts without tools',
          'Follow-up after reload and separate side-chat scope',
          'Files is a separate page without history noise',
          'Oversized document fails before inference; originals preserved',
          'Accessibility, viewport fit and runtime errors',
        ],
      });
      console.log('PASS', surface, 'direct documents');
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
  join(evidence, `direct-document-${native ? 'mac' : 'ui'}-acceptance.json`),
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      passed: true,
      scope: 'Real app and worker with controlled HTTP model fixture.',
      checks,
    },
    null,
    2,
  ),
);
