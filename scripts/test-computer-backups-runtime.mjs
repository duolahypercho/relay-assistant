// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, writeFile, readFile, mkdir, stat, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { maintenanceFixture } from './computer-maintenance-fixture.mjs';
import { ComputerSnapshots } from '../server/computer-snapshots.mjs';
const directory = await mkdtemp(join(tmpdir(), 'relay-portable-backup-'));
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence/computer-backups');
await mkdir(evidence, { recursive: true });
const accessKey = 'synthetic-portable-backup-owner-key';
const f = await maintenanceFixture(directory, {
  accessKey,
  environment: { DOCKER_HOST: process.env.RELAY_BACKUP_TEST_DOCKER_HOST },
});
const checks = [],
  report = { checkedAt: new Date().toISOString(), passed: false, checks };
async function cli(args, passwordFile) {
  const child = spawn(
    process.execPath,
    ['scripts/computer-backup.mjs', ...args, '--url', f.url, '--password-file', passwordFile],
    {
      env: { ...process.env, RELAY_ACCESS_KEY: accessKey },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let text = '';
  child.stdout.on('data', (b) => (text += b));
  child.stderr.on('data', (b) => (text += b));
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, text };
}
const command = (command) =>
  f.computer.perform(
    { kind: 'exec', command, operationId: crypto.randomUUID() },
    { actor: 'owner' },
  );
try {
  const passwordFile = join(directory, 'password'),
    wrongFile = join(directory, 'wrong'),
    archive = join(directory, 'saved.relaybackup');
  await writeFile(passwordFile, 'synthetic password for portable backup', { mode: 0o600 });
  await writeFile(wrongFile, 'wrong synthetic password for backup', { mode: 0o600 });
  await f.computer.start('owner');
  await f.computer.takeControl();
  await command(
    "printf 'survives a lost computer' > recovery.txt; mkdir -p .home/chromium; printf 'synthetic profile marker' > .home/chromium/backup-marker; ln -s recovery.txt recovery-link; printf '#!/bin/sh\\nexit 0\\n' > executable.sh; chmod 751 executable.sh",
  );
  const messages = f.store.read().messages,
    original = f.computer.volume;
  assert.equal(
    (
      await fetch(f.url + '/api/computer/backups/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    401,
  );
  const saved = await cli(['export', archive], passwordFile);
  assert.equal(saved.code, 0, saved.text);
  assert.equal((await stat(archive)).mode & 0o777, 0o600);
  const bytes = await readFile(archive);
  assert.ok(!bytes.includes('recovery.txt'));
  assert.ok(!bytes.includes('synthetic profile marker'));
  assert.equal(f.snapshots.points().length, 1);
  assert.equal(f.computer.controller, 'owner');
  const existing = await cli(['export', archive], passwordFile);
  assert.equal(existing.code, 1);
  assert.deepEqual(await readFile(archive), bytes);
  checks.push(
    'Authenticated CLI creates a fresh restore point and a private encrypted backup; filenames/profile bytes are absent from the archive, and an existing output is never overwritten.',
  );
  const before = f.snapshots.points();
  const wrong = await cli(['import', archive], wrongFile);
  assert.equal(wrong.code, 1, wrong.text);
  assert.match(wrong.text, /password is incorrect/);
  assert.deepEqual(f.snapshots.points(), before);
  assert.equal(f.snapshots.storedOperation(), null);
  const corrupt = join(directory, 'corrupt.relaybackup');
  const changed = Buffer.from(bytes);
  changed[Math.floor(changed.length / 2)] ^= 1;
  await writeFile(corrupt, changed);
  assert.equal((await cli(['import', corrupt], passwordFile)).code, 1);
  assert.deepEqual(f.snapshots.points(), before);
  assert.equal(f.computer.volume, original);
  checks.push(
    'Wrong passwords and damaged archives leave current files and saved points unchanged and remove unfinished import volumes.',
  );
  // Delete ONLY this fixture's owned computer containers and all of its workspace/restore volumes.
  await f.computer.stop();
  await f.computer.checked(['rm', f.computer.name]);
  const lost = [
    original,
    f.computer.displayVolume,
    ...f.store.db
      .prepare('SELECT volume FROM computer_snapshots')
      .all()
      .map((point) => point.volume),
  ];
  for (const volume of lost) {
    await f.computer.verifyVolume(volume);
    await f.computer.checked(['volume', 'rm', volume]);
  }
  for (const volume of lost) assert.equal(await f.snapshots.volumeExists(volume), false);
  f.store.db.prepare('DELETE FROM computer_snapshots').run();
  const imported = await cli(['import', archive], passwordFile);
  assert.equal(imported.code, 0, imported.text);
  assert.equal(f.computer.volume, original);
  assert.equal(await f.snapshots.volumeExists(original), false);
  assert.equal(f.snapshots.points().length, 1);
  assert.equal(f.snapshots.points()[0].label, 'Imported backup');
  checks.push(
    'After the fixture desktop, active workspace, display and all restore-point volumes are deleted, the external file imports into a new private restore point without changing the active workspace.',
  );
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await context.request.post(f.url + '/api/login', { data: { key: accessKey } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(f.url + '/#chat');
    await page.getByLabel('Message Relay', { exact: true }).fill('Preserve my recovery draft');
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('button', { name: 'Computer', exact: true }).click();
    await page.getByText('Restore points', { exact: true }).click();
    const panel = page.getByRole('region', { name: 'Restore points', exact: true });
    await panel.getByRole('button', { name: /Review restore point Imported backup/ }).click();
    await page.screenshot({ path: join(evidence, 'imported-backup-review.png') });
    await panel.getByRole('button', { name: 'Restore workspace', exact: true }).click();
    await expect(
      panel.getByText(
        'Your workspace is restored. Check your work, then give control back to Relay.',
        { exact: true },
      ),
    ).toBeVisible({ timeout: 120000 });
    await expect(page.getByRole('button', { name: 'Give back to Relay', exact: true })).toBeVisible(
      { timeout: 30000 },
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.deepEqual(
      (await new AxeBuilder({ page }).include('.computer-page').analyze()).violations,
      [],
    );
    await page.screenshot({ path: join(evidence, 'imported-backup-restored-phone.png') });
    await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
    await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
      'Preserve my recovery draft',
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
  const restarted = new ComputerSnapshots(f.computer);
  assert.notEqual(f.computer.volume, original);
  assert.equal((await f.computer.status()).state, 'running');
  assert.equal(
    Buffer.from((await f.computer.read('recovery.txt')).base64, 'base64').toString(),
    'survives a lost computer',
  );
  assert.equal(
    Buffer.from(
      (await f.computer.read('.home/chromium/backup-marker')).base64,
      'base64',
    ).toString(),
    'synthetic profile marker',
  );
  const result = await command('readlink recovery-link; stat -c %a executable.sh');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), 'recovery.txt\n751');
  assert.equal(f.computer.controller, 'owner');
  assert.equal((await f.computer.runtime.inspect()).State.Paused, true);
  assert.equal(restarted.points().length, 1);
  assert.deepEqual(f.store.read().messages, messages);
  assert.equal(restarted.storedOperation(), null);
  checks.push(
    'The normal reviewed restore recovers exact files, profile marker, symlink and executable permissions after volume loss, boots the real desktop, leaves commands frozen and preserves chat history.',
  );
  const op = restarted.operation(
    'backup-import',
    undefined,
    `${f.computer.name}-snapshot-${crypto.randomUUID().replaceAll('-', '')}`,
  );
  await f.computer.checked([
    'volume',
    'create',
    '--label',
    `org.relay.owner=${f.computer.owner}`,
    op.target,
  ]);
  op.created = true;
  restarted.journal(op);
  await f.computer.checked([
    'run',
    '-d',
    '--name',
    op.helper,
    '--label',
    `org.relay.owner=${f.computer.owner}`,
    '--label',
    'org.relay.role=snapshot-backup',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    '1000:1000',
    '--mount',
    `type=volume,source=${op.target},target=/workspace`,
    '--entrypoint',
    '/usr/bin/python3',
    f.computer.image,
    '-c',
    'import time;open("/workspace/partial", "w").write("unfinished fixture");time.sleep(60)',
  ]);
  const recovered = new ComputerSnapshots(f.computer);
  assert.equal(f.computer.snapshotBlocked, true);
  await recovered.reconcile();
  assert.equal(f.computer.snapshotBlocked, false);
  assert.equal(recovered.storedOperation(), null);
  assert.equal(await recovered.volumeExists(op.target), false);
  assert.equal(recovered.points().length, 1);
  checks.push(
    'A reconstructed service cleans a real interrupted import helper and its unfinished volume, retains the completed imported point, and unblocks computer actions. Browser desktop/phone layouts preserve the chat draft with no overflow, Axe violations or page errors.',
  );
  const leftovers = await f.computer.checked([
    'ps',
    '-a',
    '--filter',
    `label=org.relay.owner=${f.computer.owner}`,
    '--filter',
    'label=org.relay.role=snapshot-backup',
    '--format',
    '{{.Names}}',
  ]);
  assert.equal(leftovers.trim(), '');
  report.passed = true;
  report.limits =
    'Real isolated Docker/Colima containers and volumes, authenticated HTTP, streamed CLI export/import and Chrome desktop/phone restore UI. Volume loss is deliberately simulated, not physical disk failure. Synthetic browser-profile marker only; no live sign-in continuity, process-memory recovery, mobile backup picker, or remote-engine migration claim.';
  console.log(
    'PASS portable backup, corruption rejection, isolated volume-loss recovery, exact saved bytes and owner control.',
  );
} catch (error) {
  report.error = error.message;
  throw error;
} finally {
  await writeFile(join(evidence, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  await f.close();
  await rm(directory, { recursive: true, force: true });
}
