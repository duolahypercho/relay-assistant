// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { artifactsFixture, artifactExamples } from './artifacts-fixture.mjs';
import { saveArtifact } from '../server/artifacts.mjs';
import { command } from '../shared/domain.mjs';
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
const native = process.argv.includes('--mac');
let passed = false;
async function downloadResult(app, page, link, destination) {
  if (app) {
    await app.evaluate(({ app, BrowserWindow }, path) => {
      app.resultDownload = null;
      BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_event, item) => {
        item.setSavePath(path);
        item.once('done', (_event, state) => {
          app.resultDownload = state;
        });
      });
    }, destination);
    await link.click();
    await expect.poll(() => app.evaluate(({ app }) => app.resultDownload)).toBe('completed');
  } else {
    const pending = page.waitForEvent('download');
    await link.click();
    const download = await pending;
    assert.equal(await download.failure(), null);
    await download.saveAs(destination);
  }
  return readFile(destination);
}
try {
  for (const mobile of native ? [false] : [false, true]) {
    const label = native ? 'mac' : mobile ? 'mobile' : 'desktop',
      directory = await mkdtemp(join(tmpdir(), 'relay-results-ui-'));
    const fixture = await artifactsFixture(directory);
    let app;
    let context = native
      ? null
      : await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 950 },
          isMobile: mobile,
          hasTouch: mobile,
          reducedMotion: 'reduce',
        });
    try {
      let page;
      if (native) {
        const data = join(directory, 'desktop');
        await mkdir(data);
        await writeFile(join(data, 'desktop.json'), JSON.stringify({ server: fixture.url }));
        app = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${data}`],
        });
        context = app.context();
        page = await app.firstWindow();
        await expect(page.getByLabel('Message Relay', { exact: true })).toBeVisible();
      } else page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(fixture.url + '/#chat');
      for (const kind of ['document', 'spreadsheet', 'presentation', 'web']) {
        const example = artifactExamples[kind];
        const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
        await composer.fill(`Please create a ${kind} for my Saturday.`);
        await page.getByRole('button', { name: 'Send message', exact: true }).click();
        const card = page.getByRole('button', {
          name: new RegExp(example.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '.*Version 1'),
        });
        await expect(card).toBeVisible({ timeout: 30000 });
        await page.screenshot({ path: join(evidence, `artifacts-chat-${label}-${kind}.png`) });
        await composer.fill('Keep my next thought');
        const messageCount = fixture.store.read().messages.length;
        await card.click();
        const viewer = page.getByRole('article', { name: 'Result viewer' });
        await expect(viewer).toBeVisible();
        await expect(viewer.getByLabel('Result version', { exact: true })).toHaveCount(0);
        await expect(
          page
            .locator('.workspace-page-toolbar')
            .getByRole('button', { name: 'All files', exact: true }),
        ).toBeVisible();
        await expect(viewer.getByRole('button', { name: 'All files', exact: true })).toHaveCount(0);
        if (kind === 'spreadsheet')
          await expect(viewer.getByRole('group', { name: 'Sheets', exact: true })).toHaveCount(0);
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await page.reload();
        await expect(viewer).toBeVisible();
        await expect(
          viewer.getByRole('heading', { name: example.title, exact: true, level: 2 }),
        ).toBeVisible();
        const extension = {
          document: 'DOCX',
          spreadsheet: 'XLSX',
          presentation: 'PPTX',
          web: 'HTML',
        }[kind];
        const output = join(evidence, `artifact-${label}.${extension.toLowerCase()}`);
        const bytes = await downloadResult(
          app,
          page,
          viewer.getByRole('link', { name: `Download ${extension}`, exact: true }),
          output,
        );
        assert.ok(bytes.length > 300);
        if (kind === 'spreadsheet')
          await expect(viewer.getByRole('cell', { name: '53', exact: true })).toBeVisible();
        if (kind === 'presentation') {
          await viewer.getByLabel('Slide', { exact: true }).selectOption('1');
          await viewer.getByText('Speaker notes', { exact: true }).click();
          await expect(
            viewer.getByText('All amounts are planning estimates.', { exact: true }),
          ).toBeVisible();
        }
        if (kind === 'web') {
          const frame = page.frameLocator('iframe[title$="interactive preview"]');
          await frame.getByRole('button', { name: 'Take a breath' }).click();
          await expect(frame.getByText('1 quiet moments', { exact: true })).toBeVisible();
          await viewer.getByRole('button', { name: 'Stop preview', exact: true }).click();
          await expect(page.locator('iframe')).toHaveCount(0);
          await viewer.getByRole('button', { name: 'Start preview', exact: true }).click();
          await expect(frame.getByText('0 quiet moments', { exact: true })).toBeVisible();
        }
        await page.screenshot({ path: join(evidence, `artifacts-preview-${label}-${kind}.png`) });
        if (mobile && kind === 'spreadsheet') {
          await page.setViewportSize({ width: 320, height: 568 });
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
            false,
          );
          const editBox = await viewer
            .getByRole('button', { name: 'Edit result', exact: true })
            .boundingBox();
          assert(editBox.width >= 44 && editBox.height >= 44, 'Edit keeps a full touch target.');
          const downloadBox = await viewer
            .getByRole('link', { name: 'Download XLSX', exact: true })
            .boundingBox();
          const dockBox = await page
            .getByRole('navigation', { name: 'Workspace shortcuts', exact: true })
            .boundingBox();
          assert(
            downloadBox.y + downloadBox.height < dockBox.y,
            'Download stays visible on a small phone.',
          );
          await page.screenshot({ path: join(evidence, 'artifacts-preview-small-phone.png') });
          await page.setViewportSize({ width: 390, height: 844 });
        }
        const audit = await new AxeBuilder({ page })
          .setLegacyMode(native)
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze();
        assert.deepEqual(
          audit.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
          [],
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        await viewer.getByRole('button', { name: 'Edit result', exact: true }).click();
        await expect(
          viewer.getByRole('link', { name: `Download ${extension}`, exact: true }),
        ).toHaveCount(0);
        await viewer.getByLabel('Result title', { exact: true }).fill(example.title + ' · Revised');
        if (kind === 'document')
          await viewer
            .getByLabel('Document text (Markdown)', { exact: true })
            .fill('# A slower Sunday\n\nTake the 10:15 train.');
        if (kind === 'spreadsheet') {
          await viewer.getByLabel('B2', { exact: true }).fill('30');
          await viewer.getByLabel('B2', { exact: true }).press('Tab');
          await viewer.getByLabel('A2', { exact: true }).fill("'=literal");
          await viewer.getByLabel('A2', { exact: true }).press('Tab');
          await viewer.getByRole('button', { name: 'Add sheet', exact: true }).click();
          await expect(viewer.getByRole('group', { name: 'Sheets', exact: true })).toBeVisible();
          await viewer.getByRole('button', { name: 'Budget', exact: true }).click();
        }
        if (kind === 'presentation')
          await viewer.getByLabel('Speaker notes', { exact: true }).fill('Updated speaker notes.');
        if (kind === 'web')
          await viewer
            .getByLabel('Page source (HTML, CSS, JavaScript)', { exact: true })
            .fill(
              '<h1>A calm Sunday</h1><button onclick="this.textContent=\'Well done\'">A new moment</button>',
            );
        await viewer.getByRole('button', { name: 'Preview', exact: true }).click();
        await expect(viewer.locator('.artifact-header p')).toContainText('Draft');
        await expect(
          viewer.getByRole('link', { name: `Download ${extension}`, exact: true }),
        ).toHaveCount(0);
        await expect(
          viewer.getByRole('button', { name: 'Ask about this', exact: true }),
        ).toHaveCount(0);
        await viewer.getByRole('button', { name: 'Edit result', exact: true }).click();
        await page.reload();
        await expect(viewer.getByLabel('Result title', { exact: true })).toHaveValue(
          example.title + ' · Revised',
        );
        await viewer.getByRole('button', { name: 'Save new version', exact: true }).click();
        await expect(viewer.getByLabel('Result version', { exact: true })).toHaveValue('2');
        if (kind === 'spreadsheet') {
          await expect(viewer.getByRole('cell', { name: '58', exact: true })).toBeVisible();
          await expect(viewer.getByRole('cell', { name: '=literal', exact: true })).toBeVisible();
          await viewer.getByRole('button', { name: 'Sheet 2', exact: true }).click();
          await expect(
            viewer.getByRole('region', { name: 'Sheet 2 table', exact: true }),
          ).toBeVisible();
          await viewer.getByRole('button', { name: 'Budget', exact: true }).click();
        }
        await viewer.getByLabel('Result version', { exact: true }).selectOption('1');
        await expect(
          viewer.getByRole('heading', { name: example.title, exact: true, level: 2 }),
        ).toBeVisible();
        await viewer.getByRole('button', { name: 'Open latest version', exact: true }).click();
        await expect(viewer.getByLabel('Result version', { exact: true })).toHaveValue('2');
        await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
        await expect(composer).toHaveValue('Keep my next thought');
        assert.equal(fixture.store.read().messages.length, messageCount);
        checks.push({
          surface: label,
          kind,
          passed: true,
          checks: [
            'actual worker tool → card → separate page',
            'downloaded export',
            'single version and single sheet have no redundant selector',
            'one navigation row; editing remains one tap away',
            'unsaved edits cannot download or ask about stale saved bytes',
            'editable source/cells/slides',
            'saved draft survives reload',
            'immutable version history',
            'no navigation messages',
            'chat draft retained',
            'axe 0',
            'no page overflow',
          ],
        });
      }
      await page.goto(fixture.url + '/#files');
      await page.getByRole('button', { name: 'New result', exact: true }).click();
      await page.getByLabel('Result title', { exact: true }).fill('Owner-created note');
      await page
        .getByLabel('Document text (Markdown)', { exact: true })
        .fill('# From me\n\nMy own result.');
      await page.getByRole('button', { name: 'Save result', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Edit result', exact: true })).toBeVisible();
      await expect(page.getByLabel('Result version', { exact: true })).toHaveCount(0);
      assert.equal(fixture.store.read().artifacts.length, 5);
      const owned = fixture.store
        .read()
        .artifacts.find((a) => a.versions[0].title === 'Owner-created note');
      await page.goto(fixture.url + `/#files/${owned.id}`);
      await page.getByRole('button', { name: 'Edit result', exact: true }).click();
      await page
        .getByLabel('Document text (Markdown)', { exact: true })
        .fill('# My unsaved wording');
      await saveArtifact(fixture.store, {
        kind: 'document',
        title: 'Other device',
        source: '# Saved elsewhere',
        id: owned.id,
        expectedVersion: 1,
        operationId: 'other-device',
      });
      await expect(
        page.getByText('You’re viewing an earlier version.', { exact: false }),
      ).toBeVisible();
      await expect(page.getByLabel('Result version', { exact: true })).toHaveValue('1');
      await expect(
        page.getByRole('button', { name: 'Save new version', exact: true }),
      ).toBeDisabled();
      await expect(page.getByLabel('Document text (Markdown)', { exact: true })).toHaveValue(
        '# My unsaved wording',
      );
      await page.getByRole('button', { name: 'Discard edits', exact: true }).click();
      await page.getByRole('button', { name: 'Open latest version', exact: true }).click();
      fixture.store.mutate((s) => command(s, 'profile.update', { theme: 'dark' }));
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      const darkAudit = await new AxeBuilder({ page })
        .setLegacyMode(native)
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
      assert.deepEqual(
        darkAudit.violations.map((v) => v.id),
        [],
      );
      await page.screenshot({ path: join(evidence, `artifacts-dark-${label}.png`) });
      await page.getByText('Manage result', { exact: true }).click();
      await page.getByRole('button', { name: 'Remove result', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.getByRole('button', { name: 'Keep it', exact: true }).click();
      assert.ok(fixture.store.read().artifacts.find((a) => a.id === owned.id));
      await page.getByRole('button', { name: 'Remove result', exact: true }).click();
      await page.getByRole('button', { name: 'Remove result', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: 'A home for your work', exact: true }),
      ).toBeVisible();
      assert.equal(fixture.store.read().artifacts.length, 4);
      assert.ok(!fixture.store.read().files.some((f) => f.artifactId === owned.id));
      checks.push({
        surface: label,
        check:
          'concurrent device save keeps editor pinned and preserves draft; dark axe 0; inline removal with Keep it; all versions removed',
        passed: true,
      });
      assert.deepEqual(errors, []);
      checks.push({
        surface: label,
        check: 'owner can create a result directly in Files; no page errors',
        passed: true,
      });
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      const complete = fixture.provider.complete;
      fixture.provider.complete = async () => ({ text: ' ', toolCalls: [] });
      await page
        .getByRole('textbox', { name: 'Message Relay', exact: true })
        .fill('Make a document.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect
        .poll(() => fixture.store.read().runs.at(-1)?.status, { timeout: 15000 })
        .toBe('failed');
      await expect(
        page.getByText('The model stopped without returning a reply or result.', { exact: false }),
      ).toBeVisible();
      assert.equal(
        fixture.store.read().artifacts.length,
        4,
        'No phantom result for empty inference.',
      );
      fixture.provider.complete = complete;
      await page
        .getByRole('textbox', { name: 'Message Relay', exact: true })
        .fill('Try making that document again.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect.poll(() => fixture.store.read().artifacts.length, { timeout: 15000 }).toBe(5);
      await expect.poll(() => fixture.store.read().runs.at(-1)?.status).toBe('completed');
      await expect(
        page.getByRole('button', { name: /A slower Saturday.*Version 1/ }).last(),
      ).toBeVisible();
      checks.push({
        surface: label,
        check:
          'Empty model completion shows an actionable failure; a fresh request creates a real result',
        passed: true,
      });
      const document = fixture.store.read().artifacts.find((a) => a.kind === 'document');
      const original = document.versions.at(-1);
      const originalBytes = fixture.store.read().files.find((f) => f.id === original.fileId).base64;
      const historyCount = fixture.store.read().messages.length;
      let round = 0;
      fixture.provider.complete = async (messages) => {
        if (round++ === 0) {
          assert(
            JSON.stringify(messages).includes(original.fileId),
            'Follow-up receives the saved result reference.',
          );
          return {
            text: '',
            toolCalls: [
              {
                id: 'read-result',
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: JSON.stringify({ id: original.fileId }),
                },
              },
            ],
          };
        }
        if (round === 2) {
          const read = JSON.parse(messages.at(-1).content).result;
          assert.equal(read.source, original.source);
          return {
            text: '',
            toolCalls: [
              {
                id: 'edit-result',
                type: 'function',
                function: {
                  name: 'save_artifact',
                  arguments: JSON.stringify({
                    ...read.revisionTarget,
                    edits: [{ find: '9:15', replace: '10:15' }],
                  }),
                },
              },
            ],
          };
        }
        assert.equal(JSON.parse(messages.at(-1).content).result.version, original.number + 1);
        return { text: 'Updated the train time.', toolCalls: [] };
      };
      await page
        .getByRole('textbox', { name: 'Message Relay', exact: true })
        .fill('Change the train to 10:15. Keep the rest the same.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect
        .poll(
          () => fixture.store.read().artifacts.find((a) => a.id === document.id).versions.length,
        )
        .toBe(2);
      await expect.poll(() => fixture.store.read().runs.at(-1)?.status).toBe('completed');
      const revised = fixture.store
        .read()
        .artifacts.find((a) => a.id === document.id)
        .versions.at(-1);
      assert.equal(revised.source, original.source.replace('9:15', '10:15'));
      assert.equal(
        fixture.store.read().files.find((f) => f.id === original.fileId).base64,
        originalBytes,
      );
      assert.equal(fixture.store.read().artifacts.length, 5);
      await page
        .getByRole('button', { name: /A slower Saturday.*Version 2/ })
        .last()
        .click();
      const viewer = page.getByRole('article', { name: 'Result viewer' });
      await expect(viewer).toBeVisible();
      await expect(viewer.getByText('10:15 train', { exact: true })).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const revisedBytes = await downloadResult(
        app,
        page,
        viewer.getByRole('link', { name: 'Download DOCX', exact: true }),
        join(evidence, `artifact-revised-${label}.docx`),
      );
      assert.deepEqual(
        revisedBytes,
        Buffer.from(
          fixture.store.read().files.find((f) => f.id === revised.fileId).base64,
          'base64',
        ),
      );
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      assert.equal(fixture.store.read().messages.length, historyCount + 2);
      checks.push({
        surface: label,
        check:
          'Chat follow-up reads its saved result, applies an exact edit, opens and downloads the new version without a copy or extra navigation messages',
        passed: true,
      });
      const singleSlide = await saveArtifact(fixture.store, {
        kind: 'presentation',
        title: 'One slide',
        source: JSON.stringify({
          slides: [{ title: 'One clear thought', bullets: ['Keep it simple.'], notes: '' }],
        }),
        operationId: 'one-slide',
      });
      await page.goto(fixture.url + `/#files/${singleSlide.id}/1`);
      await expect(page.getByRole('region', { name: 'Slide 1', exact: true })).toBeVisible();
      await expect(page.getByLabel('Slide', { exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Edit result', exact: true }).click();
      await page.getByRole('button', { name: 'Add slide', exact: true }).click();
      await expect(page.getByLabel('Slide', { exact: true })).toHaveValue('1');
      await page.getByRole('button', { name: 'Preview', exact: true }).click();
      await expect(page.getByLabel('Slide', { exact: true })).toBeVisible();
      checks.push({
        surface: label,
        passed: true,
        check: 'single slide has no inert selector; adding another slide restores navigation',
      });
    } finally {
      if (app) await app.close();
      else await context?.close();
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  // Real browser adversarial checks: no host DOM/cookie access, fetch, image, forms,
  // windows or frame navigation to an external origin. Inspect hits on both origins.
  const directory = await mkdtemp(join(tmpdir(), 'relay-results-sandbox-'));
  const fixture = await artifactsFixture(directory);
  const otherDirectory = await mkdtemp(join(tmpdir(), 'relay-results-probe-'));
  const other = await artifactsFixture(otherDirectory);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const target = other.url + '/preview-probe';
    const source = `<h1>Preview boundary test</h1><p id="status"></p><img src="${target}?image"><form action="${target}?form" method="post"><button>Submit</button></form><script>
let parentBlocked=false;try{parent.document.body.dataset.compromised='yes'}catch{parentBlocked=true}
let cookieBlocked=false;try{document.cookie}catch{cookieBlocked=true}
fetch('${target}?fetch').catch(()=>{});fetch('/api/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'profile.update',payload:{name:'Compromised'}})}).catch(()=>{});
document.getElementById('status').textContent='parent='+parentBlocked+' cookie='+cookieBlocked;
</script><button id="popup" onclick="window.open('${target}?popup')">Open window</button><button id="navigate" onclick="location.href='${target}?navigation'">Navigate</button>`;
    const result = await saveArtifact(fixture.store, {
      kind: 'web',
      title: 'Boundary checks',
      source,
      operationId: 'boundary',
    });
    await page.goto(fixture.url + `/#files/${result.id}/1`);
    const frame = page.frameLocator('iframe');
    await expect(frame.getByText('parent=true cookie=true', { exact: true })).toBeVisible();
    await frame.getByRole('button', { name: 'Submit', exact: true }).click();
    await frame.getByRole('button', { name: 'Open window', exact: true }).click();
    assert.equal(context.pages().length, 1);
    await frame.getByRole('button', { name: 'Navigate', exact: true }).click();
    await page.waitForTimeout(500);
    assert.deepEqual(other.probes, []);
    assert.equal(fixture.store.read().profile.name, '');
    assert.equal(await page.evaluate(() => document.body.dataset.compromised), undefined);
    checks.push({
      surface: 'browser',
      check:
        'opaque iframe blocks parent/cookies; CSP/sandbox block fetch, image, form, popup and external frame navigation',
      passed: true,
    });
  } finally {
    await context.close();
    await fixture.close();
    await other.close();
    await rm(otherDirectory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
  for (const platform of ['ios', 'android']) {
    const directory = await mkdtemp(join(tmpdir(), 'relay-native-preview-policy-'));
    const fixture = await artifactsFixture(directory);
    const context = await browser.newContext();
    try {
      await context.addInitScript((name) => {
        window.CapacitorCustomPlatform = { name };
      }, platform);
      const saved = await saveArtifact(fixture.store, {
        ...artifactExamples.web,
        operationId: 'native-static',
      });
      const page = await context.newPage();
      await page.goto(fixture.url + `/#files/${saved.id}/1`);
      await expect(
        page.getByText('Open the preview to use this page.', { exact: false }),
      ).toBeVisible();
      await expect(page.locator('iframe')).toHaveAttribute('sandbox', '');
      const frame = page.frameLocator('iframe');
      await expect(page.locator('iframe')).toHaveAttribute('inert', '');
      await expect(frame.getByText('0 quiet moments', { exact: true })).toBeVisible();
      checks.push({
        surface: `simulated-${platform}`,
        check:
          'native platform branch renders static HTML with scripts disabled; device bridge behavior itself is not certified',
        passed: true,
      });
    } finally {
      await context.close();
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  passed = true;
} finally {
  await browser.close();
  await writeFile(
    join(evidence, 'artifacts-ui-acceptance.json'),
    JSON.stringify(
      { passed, testedAt: new Date().toISOString(), nativeMac: native, checks },
      null,
      2,
    ),
  );
}
console.log(`${checks.length} artifact acceptance checks passed.`);
