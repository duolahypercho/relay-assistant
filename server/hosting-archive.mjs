// SPDX-License-Identifier: MIT
// Maintenance-only process. Stop the app before backing up; restore only an
// archive made by this deployment into brand-new volumes. Never runs at startup.
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const mode = process.argv[2];
try {
  if (!['backup', 'restore'].includes(mode) || process.argv.length !== 3)
    throw Error('Choose backup or restore.');
  if (mode === 'restore') {
    for (const path of ['/restore/data', '/restore/relay-secrets']) {
      if ((await readdir(path)).length)
        throw Error(
          'Restore requires empty data and secrets volumes. Existing data was not changed.',
        );
    }
  }
  const args =
    mode === 'backup'
      ? ['-czf', '-', '-C', '/restore', 'data', 'relay-secrets']
      : ['-xzf', '-', '-C', '/restore', '--no-same-owner', '--keep-old-files'];
  const child = spawn('tar', args, { stdio: 'inherit' });
  child.on('error', () => {
    console.error('The hosting archive tool could not start.');
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
