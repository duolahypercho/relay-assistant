// SPDX-License-Identifier: MIT
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { maintenanceFixture } from './computer-maintenance-fixture.mjs';
import { ComputerSnapshots } from '../server/computer-snapshots.mjs';
const directory = await mkdtemp(join(tmpdir(), 'relay-snapshot-runtime-')),
  f = await maintenanceFixture(directory),
  checks = [];
const command = (command) =>
  f.computer.perform(
    { kind: 'exec', command, operationId: crypto.randomUUID() },
    { actor: 'owner' },
  );
try {
  await f.computer.start('owner');
  await f.computer.takeControl();
  await command(
    "printf 'current work survives failure' > rollback.txt; mv .home .home.saved; printf 'invalid home directory' > .home",
  );
  f.snapshots.save();
  await f.snapshots.pending;
  assert.equal(f.snapshots.phase, 'done', f.snapshots.error);
  const point = f.snapshots.points()[0];
  await command('rm .home; mv .home.saved .home');
  const original = f.computer.volume;
  f.snapshots.prepare('restore', point.id);
  f.snapshots.apply(f.snapshots.review.id);
  await f.snapshots.pending;
  assert.equal(f.snapshots.phase, 'error');
  assert.match(f.snapshots.error, /previous workspace is back/);
  assert.equal(f.computer.volume, original);
  assert.equal((await f.computer.status()).state, 'running');
  assert.equal(f.computer.controller, 'owner');
  assert.equal((await f.computer.runtime.inspect()).State.Paused, true);
  assert.equal(
    Buffer.from((await f.computer.read('rollback.txt')).base64, 'base64').toString(),
    'current work survives failure',
  );
  assert.equal(f.snapshots.points().length, 1);
  assert.equal(f.snapshots.storedOperation(), null);
  checks.push(
    'An actual saved workspace with a file blocking the HOME directory fails desktop startup; the original volume and running computer return automatically, with exact file bytes and owner freeze intact.',
  );
  // Reconstruct the service from a persisted interrupted capture with a real frozen desktop.
  const target = `${f.computer.name}-snapshot-${crypto.randomUUID().replaceAll('-', '')}`;
  await f.computer.checked([
    'volume',
    'create',
    '--label',
    `org.relay.owner=${f.computer.owner}`,
    target,
  ]);
  const op = {
    kind: 'save',
    source: original,
    target,
    created: true,
    paused: true,
    desktop: (await f.computer.inspect()).Id,
    helper: f.computer.name + '-snapshot-interrupted',
  };
  f.snapshots.journal(op);
  await f.computer.checked(['pause', f.computer.name]);
  const restarted = new ComputerSnapshots(f.computer);
  assert.equal(f.computer.snapshotBlocked, true);
  await restarted.reconcile();
  assert.equal(restarted.storedOperation(), null);
  assert.equal(f.computer.snapshotBlocked, false);
  assert.equal((await f.computer.inspect()).State.Paused, false);
  assert.equal(await restarted.volumeExists(target), false);
  assert.equal(restarted.points().length, 1);
  assert.equal((await f.computer.runtime.inspect()).State.Paused, true);
  checks.push(
    'Reconstructed service reconciles a persisted interrupted capture: actual desktop unfreezes, its unfinished copy is removed, completed saved points remain and commands stay owner-paused.',
  );
  await command('truncate -s 8589934593 too-large');
  restarted.save();
  await restarted.pending;
  assert.equal(restarted.phase, 'error');
  assert.match(restarted.error, /8 GB/);
  assert.equal((await f.computer.inspect()).State.Paused, false);
  assert.equal(restarted.points().length, 1);
  assert.equal(restarted.storedOperation(), null);
  await command('rm too-large');
  checks.push(
    'A sparse file beyond the 8 GB limit rejects capture before copying and restores desktop availability without a partial saved point.',
  );
  await writeFile(
    resolve('../relay-evidence/computer-snapshots-runtime-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        checks,
        limits:
          'Real Docker/Colima with isolated fixture volumes. Interrupted capture is reconstructed from a deliberately persisted journal, not a host power failure. No disk-loss recovery or live website compatibility claim.',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS real failed-restore rollback, interrupted capture reconciliation and size limit',
  );
} finally {
  await f.close();
}
