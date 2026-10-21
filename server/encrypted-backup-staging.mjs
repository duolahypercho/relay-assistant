// SPDX-License-Identifier: MIT
import { readdir, lstat, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

// Force-quit can leave encrypted staging files. Never traverse a link, another
// user's directory, or an unfamiliar directory. Live transfers are shorter than a day.
export async function cleanEncryptedBackupStaging(root, prefix, filename, now = Date.now()) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (
      !entry.name.startsWith(prefix) ||
      !/^[A-Za-z0-9]{6}$/.test(entry.name.slice(prefix.length)) ||
      !entry.isDirectory() ||
      entry.isSymbolicLink()
    )
      continue;
    try {
      const directory = join(root, entry.name),
        info = await lstat(directory);
      if (
        now - info.mtimeMs < 24 * 60 * 60 * 1000 ||
        (process.getuid && info.uid !== process.getuid())
      )
        continue;
      const names = await readdir(directory);
      if (names.length !== 1 || names[0] !== filename) continue;
      const path = join(directory, filename),
        file = await lstat(path);
      if (!file.isFile() || file.isSymbolicLink()) continue;
      await unlink(path);
      await rmdir(directory);
    } catch (error) {
      // Another Relay process may remove the same expired entry. Leave any
      // changed or inaccessible entry alone instead of blocking new backups.
      if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'ENOTEMPTY'].includes(error.code))
        throw error;
    }
  }
}
