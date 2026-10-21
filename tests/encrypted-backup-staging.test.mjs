// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm, utimes, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanEncryptedBackupStaging } from '../server/encrypted-backup-staging.mjs';
test('abandoned backup cleanup is confined to expired encrypted files and tolerates simultaneous cleanup', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'relay-cleanup-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prefix = 'relay-encrypted-backup-',
    filename = 'backup.relaybackup';
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  for (const suffix of ['OLD123', 'LIVE12', 'OTHER1', 'LINK12', 'EMPTY1', 'FOREIGN']) {
    const directory = join(root, prefix + suffix);
    await mkdir(directory);
    if (suffix === 'LINK12') await symlink(join(root, 'outside'), join(directory, filename));
    else if (suffix !== 'EMPTY1') await writeFile(join(directory, filename), 'encrypted fixture');
    if (suffix === 'OTHER1') await writeFile(join(directory, 'unrelated'), 'preserve');
    if (suffix !== 'LIVE12') await utimes(directory, old, old);
  }
  await mkdir(join(root, 'outside'));
  await writeFile(join(root, 'outside', filename), 'preserve');
  await symlink(join(root, 'outside'), join(root, prefix + 'DIRLNK'));
  await Promise.all([
    cleanEncryptedBackupStaging(root, prefix, filename),
    cleanEncryptedBackupStaging(root, prefix, filename),
  ]);
  assert.deepEqual(
    (await readdir(root)).sort(),
    [
      'outside',
      ...['LIVE12', 'OTHER1', 'LINK12', 'EMPTY1', 'FOREIGN', 'DIRLNK'].map((name) => prefix + name),
    ].sort(),
  );
  assert.deepEqual(await readdir(join(root, 'outside')), [filename]);
});
