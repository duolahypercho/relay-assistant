// SPDX-License-Identifier: MIT
// Actual packaged Electron bridge and persistent test data; no owner workspace.
import { _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { assistantsFixture } from './assistants-fixture.mjs';
import { publishAcceptanceTemplate } from './template-links-fixture.mjs';
import { DesktopTemplateLinks } from '../native/desktop/template-links.mjs';
const directory = await mkdtemp(join(tmpdir(), 'relay-template-native-'));
const evidence = resolve('../relay-evidence/template-links');
await mkdir(evidence, { recursive: true });
let app, publisher, recipient;
const checks = [],
  errors = [];
try {
  publisher = await assistantsFixture(join(directory, 'publisher'));
  recipient = await assistantsFixture(join(directory, 'recipient'));
  const published = publishAcceptanceTemplate(publisher);
  const data = join(directory, 'native');
  await mkdir(data);
  await writeFile(join(data, 'desktop.json'), JSON.stringify({ server: recipient.url }));
  const inbox = new DesktopTemplateLinks(data);
  async function launch(link) {
    app = await electron.launch({
      executablePath: resolve('release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay'),
      args: [`--relay-test-data=${data}`, ...(link ? [link] : [])],
    });
    app.context().setDefaultTimeout(25000);
    const page = await app.firstWindow();
    page.on('pageerror', (e) => errors.push(e.message));
    return page;
  }
  const region = (page) =>
    page.getByRole('region', { name: 'Import assistant template', exact: true });
  async function emit(link) {
    await app.evaluate(({ app }, url) => app.emit('open-url', { preventDefault() {} }, url), link);
  }
  let page = await launch();
  await expect(page.getByLabel('Message Relay', { exact: true })).toBeVisible();
  await page.getByLabel('Message Relay', { exact: true }).fill('Keep my Main draft');
  await expect
    .poll(() => recipient.store.read().threads.find((t) => t.id === 'main').draft)
    .toBe('Keep my Main draft');
  await app.close();
  app = null;
  page = await launch(published.link);
  await expect(
    region(page).getByRole('button', { name: 'Add assistant', exact: true }),
  ).toBeVisible();
  expect(recipient.store.read().assistants || []).toHaveLength(0);
  await expect(region(page).getByLabel('Template link', { exact: true })).toHaveCount(0);
  await expect(
    region(page).getByRole('button', { name: 'Load template', exact: true }),
  ).toHaveCount(0);
  expect(new URL(page.url()).origin).toBe(recipient.url);
  const pending = await inbox.peek(recipient.url);
  expect(pending).toBeTruthy();
  await page.screenshot({ path: join(evidence, 'mac-review.png') });
  expect((await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations).toEqual([]);
  checks.push(
    'Cold-start URL opens one review in the selected workspace, without manual server/link/load steps or importing.',
  );
  await emit('relay-assistant://template?url=https://other.example/not-a-template');
  expect((await inbox.peek(recipient.url)).id).toBe(pending.id);
  await app.close();
  app = null;
  page = await launch();
  await expect(
    region(page).getByRole('button', { name: 'Add assistant', exact: true }),
  ).toBeVisible();
  expect((await inbox.peek(recipient.url)).id).toBe(pending.id);
  await region(page).getByRole('button', { name: 'Add assistant', exact: true }).click();
  await expect(page.getByLabel('Message Aster travel kit', { exact: true })).toBeVisible();
  await expect.poll(() => inbox.peek(recipient.url)).toBeNull();
  expect(recipient.store.read().assistants).toHaveLength(1);
  expect(recipient.store.read().templateImports[0].id).toBe(pending.id);
  expect(recipient.store.read().routines[0].paused).toBe(true);
  expect(recipient.store.read().messages).toHaveLength(0);
  expect(recipient.store.read().runs).toHaveLength(0);
  await app.close();
  app = null;
  await writeFile(inbox.path, JSON.stringify({ ...pending, destination: recipient.url }), {
    mode: 0o600,
  });
  page = await launch();
  await expect(page.getByLabel('Message Aster travel kit', { exact: true })).toBeVisible();
  await expect.poll(() => inbox.peek(recipient.url)).toBeNull();
  expect(recipient.store.read().assistants).toHaveLength(1);
  checks.push(
    'Pending review survives relaunch; Add is explicit; committed receipt replay is acknowledged without duplicate assistant, chat or routine execution.',
  );
  const second = publishAcceptanceTemplate(publisher, 'Aster second kit');
  await emit(second.link);
  await expect(
    region(page).getByRole('heading', { name: 'Aster second kit', exact: true }),
  ).toBeVisible();
  await emit(published.link);
  await expect(
    region(page).getByRole('heading', { name: 'Aster travel kit', exact: true }),
  ).toBeVisible();
  await region(page).getByRole('button', { name: 'All assistants', exact: true }).click();
  await expect.poll(() => inbox.peek(recipient.url)).toBeNull();
  checks.push(
    'Warm links replace the review even on the same page; dismiss clears only the matching pending link.',
  );
  second.manager.revoke(second.record.token, second.record.revision);
  await emit(second.link);
  await expect(region(page).getByRole('alert')).toContainText('unavailable');
  await page.screenshot({ path: join(evidence, 'mac-revoked.png') });
  await region(page).getByRole('button', { name: 'All assistants', exact: true }).click();
  expect(recipient.store.read().messages).toHaveLength(0);
  expect(recipient.store.read().assistants).toHaveLength(1);
  const slow = publishAcceptanceTemplate(publisher, 'Slow shared kit');
  let resumeFetch;
  const delayed = new Promise((resolve) => {
    resumeFetch = resolve;
  });
  await page.route(publisher.url + '/api/shared-assistants/' + slow.record.token, async (route) => {
    await delayed;
    await route
      .fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ template: slow.template }),
      })
      .catch(() => {});
  });
  await emit(slow.link);
  await expect(region(page).getByRole('status')).toContainText('Opening shared setup');
  await region(page)
    .getByRole('button', { name: 'All assistants', exact: true })
    .click({ timeout: 1500 });
  resumeFetch();
  await expect.poll(() => inbox.peek(recipient.url)).toBeNull();
  expect(recipient.store.read().assistants).toHaveLength(1);
  checks.push(
    'Slow template loading can be dismissed immediately without waiting for the network timeout or adding an assistant.',
  );
  // Real public page script and app navigation event, hosted on recipient origin.
  const local = publishAcceptanceTemplate(recipient, 'Recipient public kit');
  await page.goto(local.source);
  await expect(page.getByRole('link', { name: 'Open in Relay', exact: true })).toHaveAttribute(
    'href',
    local.link,
  );
  const denied = await page.evaluate(async () => {
    try {
      await window.relayNative.templates.peek();
      return false;
    } catch {
      return true;
    }
  });
  expect(denied).toBe(true);
  await page.getByRole('link', { name: 'Open in Relay', exact: true }).click();
  await expect(
    region(page).getByRole('heading', { name: 'Recipient public kit', exact: true }),
  ).toBeVisible();
  await region(page).getByRole('button', { name: 'All assistants', exact: true }).click();
  await page.goto(recipient.url + '/#chat');
  await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue('Keep my Main draft');
  expect(JSON.parse(await readFile(join(data, 'desktop.json'))).server).toBe(recipient.url);
  expect(errors).toEqual([]);
  checks.push(
    'Revoked links fail inline; public preview cannot read the native inbox; its Open in Relay button returns to review; Main draft and selected server survive.',
  );
  await writeFile(
    join(evidence, 'desktop.json'),
    JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  await app?.close();
  await recipient?.close();
  await publisher?.close();
  await rm(directory, { recursive: true, force: true });
}
