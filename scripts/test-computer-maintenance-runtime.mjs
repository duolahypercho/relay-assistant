// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { maintenanceFixture } from './computer-maintenance-fixture.mjs';
const directory = await mkdtemp(join(tmpdir(), 'relay-update-rollback-'));
const f = await maintenanceFixture(directory);
let badImage;
try {
  await f.computer.start('owner');
  await f.computer.takeControl();
  await f.computer.perform(
    {
      kind: 'files',
      action: 'write',
      path: 'rollback-proof.txt',
      operationId: 'rollback-proof-file',
      base64: Buffer.from('Keep this across a failed update').toString('base64'),
    },
    { actor: 'owner' },
  );
  const previousImage = f.computer.image;
  const broken = join(directory, 'broken-version');
  await mkdir(broken);
  await cp(resolve('docker'), join(broken, 'docker'), { recursive: true });
  // Deliberately broken startup, while all dependencies and source files remain
  // readable. This must pass preparation but fail actual desktop startup.
  await writeFile(join(broken, 'docker/desktop-start.sh'), '#!/bin/sh\nexit 17\n');
  f.setup.root = broken;
  f.maintenance.prepare('update');
  await f.maintenance.pending;
  assert.equal(f.maintenance.status().phase, 'review', f.maintenance.status().error);
  badImage = f.maintenance.review.image;
  f.maintenance.apply(f.maintenance.status().review.id);
  await f.maintenance.pending;
  assert.equal(f.maintenance.status().phase, 'error');
  assert.match(f.maintenance.status().error, /previous computer software is restored/);
  assert.equal(f.computer.image, previousImage);
  assert.equal(
    f.store.db.prepare('SELECT image FROM computer_setup_config').get().image,
    previousImage,
  );
  assert.equal((await f.computer.status()).state, 'running');
  assert.equal(f.computer.controller, 'owner');
  assert.equal((await f.computer.runtime.inspect()).State.Paused, true);
  assert.equal(
    Buffer.from((await f.computer.read('rollback-proof.txt')).base64, 'base64').toString(),
    'Keep this across a failed update',
  );
  await writeFile(
    '../relay-evidence/computer-maintenance-rollback-acceptance.json',
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        checks: [
          'Prepared a real image with a deliberately failing entrypoint',
          'Actual desktop startup failed and automatically restored the previous running image and durable configuration',
          'Original file bytes survived and the restored command runtime remained frozen for owner review',
        ],
        limits:
          'Process and image replacement on a running Docker engine; not power loss, VM disappearance, snapshots or disk corruption.',
      },
      null,
      2,
    ),
  );
  console.log('PASS real failed-update rollback with preserved file and frozen owner runtime');
} finally {
  if (badImage) await f.computer.dockerRun(['image', 'rm', badImage]).catch(() => {});
  await f.close();
}
