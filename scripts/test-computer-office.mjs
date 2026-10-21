// SPDX-License-Identifier: MIT
// Production browser/Mac UI, actual office processes, file bytes and frozen command runtime.
import assert from 'node:assert/strict';
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { officeComputer } from './computer-office-fixture.mjs';
import { cleanupComputer } from './computer-maintenance-fixture.mjs';

const native = process.argv.includes('--mac'),
  label = native ? 'mac' : 'browser';
const directory = await mkdtemp(join(tmpdir(), 'relay-office-'));
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence/computer-office');
await mkdir(evidence, { recursive: true });
const store = new Store(join(directory, 'db.sqlite'), { sample: false });
const checks = [],
  check = (s) => {
    checks.push(s);
    console.log('PASS', s);
  };
let f, server, browser, nativeApp, inspectedPage;
try {
  f = await officeComputer(store, directory);
  const { computer, owner, write } = f;
  const command = async (command) => {
    const result = await owner({ kind: 'exec', command, seconds: 60 });
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.equal(result.timedOut, false);
    return result.stdout;
  };
  const title = async () => (await computer.screenshot()).title;
  const app = createApp(
    store,
    {
      mode: 'sample',
      computer,
      computerSetup: f.setup,
      provider: { configured: false },
      google: { configured: false },
      browser: { enabled: false },
      terminal: { enabled: false },
    },
    { host: '127.0.0.1', port: 0, accessKey: '' },
  );
  app.use(express.static(resolve('dist')));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  let page;
  if (native) {
    const data = join(directory, 'native');
    await mkdir(data);
    await writeFile(join(data, 'desktop.json'), JSON.stringify({ server: url }));
    nativeApp = await electron.launch({
      executablePath: resolve('release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay'),
      args: [`--relay-test-data=${data}`],
      timeout: 25000,
    });
    page = await nativeApp.firstWindow();
  } else {
    page = await context.newPage();
    await page.goto(url + '/#chat');
  }
  inspectedPage = page;
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const before = structuredClone(store.read().messages);
  await page.getByLabel('Message Relay', { exact: true }).fill('Keep my office draft');
  await page.getByRole('button', { name: 'Open computer', exact: true }).first().click();
  const display = page.getByRole('button', { name: 'Control private desktop', exact: true });
  await expect(display).toBeVisible({ timeout: 20000 });
  await page
    .getByRole('region', { name: 'Private computer', exact: true })
    .getByRole('button', { name: 'Files', exact: true })
    .click();
  const files = page.getByRole('region', { name: 'Computer files' });
  await expect(files.getByRole('button', { name: 'Document', exact: true })).toBeVisible();
  const open = async (name, expected) => {
    await files
      .locator('.computer-file-row')
      .filter({ has: page.getByText(name, { exact: true }) })
      .getByRole('button', { name: `Open ${name}`, exact: true })
      .click();
    await expect.poll(title, { timeout: 25000 }).toMatch(expected);
    await expect(page.getByRole('button', { name: 'Give back to Relay', exact: true })).toBeEnabled(
      { timeout: 15000 },
    );
  };
  await open('Welcome.docx', /Welcome.*Writer/);
  await owner({ kind: 'desktop', action: 'key', key: 'ctrl+End' });
  await owner({ kind: 'desktop', action: 'type', text: '\nEdited on Relay’s computer. 你好' });
  await owner({ kind: 'desktop', action: 'key', key: 'ctrl+s' });
  // LibreOffice can ask to retain the original Office format on the first save.
  await command('sleep 1; xdotool key --clearmodifiers alt+u');
  await expect
    .poll(
      async () =>
        command(
          'python3 -c \'import zipfile; print(zipfile.ZipFile("/workspace/Welcome.docx").read("word/document.xml").decode())\'',
        ),
      { timeout: 15000 },
    )
    .toContain('Edited on Relay');
  await expect(display.locator('img')).toHaveAttribute('alt', /Welcome.*Writer/, {
    timeout: 15000,
  });
  await page.screenshot({ path: join(evidence, `${label}-document.png`) });
  check('Open a DOCX in Writer from Files, edit Unicode text and save actual document bytes');

  for (const [name, expected] of [
    ['Budget.xlsx', /Budget.*Calc/],
    ['Ideas.pptx', /Ideas.*Impress/],
    ['Preview.pdf', /Preview.*Draw/],
    ['notes.txt', /notes.*Mousepad/],
  ]) {
    await open(name, expected);
  }
  check('Existing spreadsheet, slides, PDF and text open in their actual desktop apps');
  for (const [name, expected] of [
    ['Document', /Writer/],
    ['Spreadsheet', /Calc/],
    ['Slides', /Impress/],
  ]) {
    await files.getByRole('button', { name, exact: true }).click();
    await expect.poll(title, { timeout: 25000 }).toMatch(expected);
  }
  await files.getByRole('button', { name: 'Document', exact: true }).click();
  await expect.poll(title, { timeout: 25000 }).toMatch(/Writer/);
  await owner({ kind: 'desktop', action: 'type', text: 'A new document in the right folder.' });
  await owner({ kind: 'desktop', action: 'key', key: 'ctrl+s' });
  await expect.poll(title, { timeout: 15000 }).toMatch(/Save/);
  await owner({ kind: 'desktop', action: 'key', key: 'ctrl+a' });
  await owner({ kind: 'desktop', action: 'type', text: 'Fresh.odt' });
  await owner({ kind: 'desktop', action: 'key', key: 'Return' });
  await expect
    .poll(
      async () => {
        try {
          return (await computer.read('Fresh.odt')).size;
        } catch {
          return 0;
        }
      },
      { timeout: 15000 },
    )
    .toBeGreaterThan(500);
  await expect(files.getByText('Fresh.odt', { exact: true })).toBeVisible({ timeout: 10000 });
  check(
    'Three one-tap creation controls open blank office documents; new files save directly in the visible workspace',
  );

  // Exercise conversion in the separate agent process boundary while owner apps exist.
  await computer.release();
  const conversion = await computer.perform({
    kind: 'exec',
    operationId: randomUUID(),
    seconds: 60,
    command:
      'mkdir -p /workspace/rendered; libreoffice -env:UserInstallation=file:///tmp/relay-office-convert --headless --convert-to pdf --outdir /workspace/rendered /workspace/Welcome.docx /workspace/Budget.xlsx /workspace/Ideas.pptx; pdftotext /workspace/rendered/Welcome.pdf -; pdftotext -layout /workspace/rendered/Budget.pdf -',
  });
  assert.equal(conversion.exitCode, 0, conversion.stderr);
  assert.match(conversion.stdout, /Edited on Relay/);
  assert.match(conversion.stdout, /20/);
  for (const name of ['Welcome', 'Budget', 'Ideas'])
    assert((await computer.read(`rendered/${name}.pdf`)).size > 500);
  await computer.takeControl();
  assert.equal((await computer.runtime.inspect()).State.Paused, true);
  check(
    'Agent commands convert DOCX/XLSX/PPTX to readable PDFs without hijacking owner apps; takeover freezes command processes',
  );

  await write(
    'policy-check.py',
    `import uno, subprocess, time, json\nfrom com.sun.star.beans import PropertyValue\np=subprocess.Popen(['libreoffice','-env:UserInstallation=file:///tmp/relay-office-policy','--headless','--norestore','--accept=pipe,name=relaypolicy;urp;StarOffice.ComponentContext'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\ntry:\n ctx=uno.getComponentContext(); resolver=ctx.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver',ctx)\n for _ in range(100):\n  try:\n   remote=resolver.resolve('uno:pipe,name=relaypolicy;urp;StarOffice.ComponentContext'); break\n  except Exception: time.sleep(.1)\n provider=remote.ServiceManager.createInstanceWithContext('com.sun.star.configuration.ConfigurationProvider',remote)\n arg=PropertyValue(); arg.Name='nodepath'; arg.Value='/org.openoffice.Office.Common/Security/Scripting'\n config=provider.createInstanceWithArguments('com.sun.star.configuration.ConfigurationUpdateAccess',(arg,))\n assert config.getPropertyValue('DisableMacrosExecution') is True\n try:\n  config.setPropertyValue('DisableMacrosExecution',False)\n  raise Exception('Macro policy was not locked')\n except Exception as error:\n  assert 'finalized' in str(error) or 'read-only' in str(error), str(error)\n assert config.getPropertyValue('DisableMacrosExecution') is True\n paths=remote.ServiceManager.createInstanceWithContext('com.sun.star.util.PathSettings',remote)\n assert paths.Work == 'file:///workspace', paths.Work\n print('macros disabled and locked')\nfinally:\n p.terminate(); p.wait(timeout=5)\n`,
  );
  assert.match(await command('python3 /workspace/policy-check.py'), /macros disabled and locked/);
  check(
    'LibreOffice runtime confirms document macros are disabled and the setting cannot be lowered',
  );

  await command(
    'ln -s /etc/passwd /workspace/linked.txt; mkdir /workspace/folder; ln -s /workspace/folder /workspace/linked-folder; printf hello > /workspace/folder/safe.txt; mkfifo /workspace/pipe.txt',
  );
  for (const path of [
    '../etc/passwd',
    '/etc/passwd',
    'linked.txt',
    'linked-folder/safe.txt',
    'pipe.txt',
    'missing.docx',
    'policy-check.py.exe',
  ])
    await assert.rejects(owner({ kind: 'app', action: 'open', path }));
  await assert.rejects(
    owner({ kind: 'app', action: 'new', app: 'xterm;touch /workspace/unwanted' }),
  );
  check(
    'Launch rejects traversal, symlink files/parents, pipes, missing files and unsupported app requests',
  );

  await open('Welcome.docx', /Welcome.*Writer/);
  await expect(files.getByText('folder', { exact: true })).toBeVisible({ timeout: 10000 });
  let releaseOld,
    held = false;
  await page.route('**/api/computer/files?*', async (route) => {
    if (!held && new URL(route.request().url()).searchParams.get('path') === '.') {
      held = true;
      const response = await route.fetch();
      await new Promise((resolve) => {
        releaseOld = resolve;
      });
      await route.fulfill({ response });
    } else await route.continue();
  });
  await expect.poll(() => typeof releaseOld, { timeout: 15000 }).toBe('function');
  await files
    .locator('.computer-file-row')
    .filter({ has: page.getByText('folder', { exact: true }) })
    .getByRole('button', { name: 'Open', exact: true })
    .click();
  await expect(files.getByText('safe.txt', { exact: true })).toBeVisible();
  releaseOld();
  await page.unrouteAll({ behavior: 'wait' });
  await expect(files.getByText('safe.txt', { exact: true })).toBeVisible();
  await expect(files.getByText('Welcome.docx', { exact: true })).toHaveCount(0);
  await files.getByRole('button', { name: 'Parent folder', exact: true }).click();
  await expect(files.getByText('Fresh.odt', { exact: true })).toBeVisible();
  check(
    'Saved files appear automatically, and a delayed folder refresh cannot overwrite newer navigation',
  );

  const saved = Buffer.from((await computer.read('Welcome.docx')).base64, 'base64');
  const op = { kind: 'app', action: 'open', path: 'Welcome.docx', operationId: randomUUID() };
  await computer.perform(op, { actor: 'owner' });
  assert.equal((await computer.perform(op, { actor: 'owner' })).repeated, true);
  await computer.stop();
  await computer.start('owner');
  await computer.takeControl();
  assert(saved.equals(Buffer.from((await computer.read('Welcome.docx')).base64, 'base64')));
  await expect(display).toBeVisible({ timeout: 20000 });
  await open('Welcome.docx', /Welcome.*Writer/);
  check('Opening retries do not relaunch, and saved edits survive a full computer stop/start');

  for (const width of native ? [null] : [390, 320, 768]) {
    if (width) await page.setViewportSize({ width, height: 844 });
    await files.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    const axe = await new AxeBuilder({ page })
      .setLegacyMode(native)
      .include('.computer-files')
      .analyze();
    assert.equal(axe.violations.length, 0, JSON.stringify(axe.violations));
    await page.screenshot({ path: join(evidence, `${label}-files-${width || 'desktop'}.png`) });
  }
  assert.deepEqual(errors, []);
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
    'Keep my office draft',
  );
  assert.deepEqual(store.read().messages, before);
  check(
    native
      ? 'Packaged Mac file controls pass scoped accessibility and preserve chat history/draft'
      : 'File controls fit desktop, phone and tablet sizes, pass scoped accessibility checks and preserve chat history/draft',
  );
  await writeFile(
    join(evidence, `${label}-acceptance.json`),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        image: computer.image,
        checks,
        limits:
          'Actual office apps and files with synthetic documents; not model reasoning, external accounts or complete Office format fidelity.',
      },
      null,
      2,
    ),
  );
} catch (error) {
  await inspectedPage?.screenshot({ path: join(evidence, `${label}-failure.png`) }).catch(() => {});
  throw error;
} finally {
  await nativeApp?.close().catch(() => {});
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  if (f) await cleanupComputer({ computer: f.computer, store });
  else store.close();
  await rm(directory, { recursive: true, force: true });
}
