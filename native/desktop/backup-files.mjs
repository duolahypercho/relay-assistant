import { cleanEncryptedBackupStaging } from '../../server/encrypted-backup-staging.mjs';
// SPDX-License-Identifier: MIT
import { mkdtemp, open, rm, copyFile, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  BACKUP_MAGIC,
  BACKUP_FILENAME,
  BACKUP_CHUNK_BYTES,
  MAX_BACKUP_BYTES,
} from '../../shared/computer-backup.mjs';
export class DesktopBackupFiles {
  constructor(root) {
    this.root = root;
    this.current = null;
    this.busy = false;
  }
  async begin() {
    if (this.current || this.busy || this.abandoned)
      throw Error('Finish the current backup first.');
    this.busy = true;
    try {
      await (this.cleanup ||= cleanEncryptedBackupStaging(
        this.root,
        'relay-backup-save-',
        BACKUP_FILENAME,
      ));
      const directory = await mkdtemp(join(this.root, 'relay-backup-save-'));
      const file = join(directory, BACKUP_FILENAME);
      try {
        this.current = {
          id: randomUUID(),
          directory,
          file,
          handle: await open(file, 'wx', 0o600),
          bytes: 0,
          sealed: false,
        };
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
      return { id: this.current.id };
    } finally {
      this.busy = false;
    }
  }
  entry(id) {
    if (!this.current || this.current.id !== id)
      throw Error('This backup save expired. Start again.');
    return this.current;
  }
  async append({ id, offset, base64 }) {
    const entry = this.entry(id);
    if (
      this.busy ||
      entry.sealed ||
      offset !== entry.bytes ||
      typeof base64 !== 'string' ||
      base64.length > Math.ceil(BACKUP_CHUNK_BYTES / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)
    )
      throw Error('The backup transfer is out of order or too large.');
    const bytes = Buffer.from(base64, 'base64');
    if (
      !bytes.length ||
      bytes.length > BACKUP_CHUNK_BYTES ||
      bytes.toString('base64') !== base64 ||
      entry.bytes + bytes.length > MAX_BACKUP_BYTES ||
      (!entry.bytes && bytes.subarray(0, 16).toString() !== BACKUP_MAGIC)
    )
      throw Error('Choose a complete Relay computer backup.');
    this.busy = true;
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const result = await entry.handle.write(bytes, offset, bytes.length - offset);
        if (!result.bytesWritten) throw Error('The backup could not be written.');
        offset += result.bytesWritten;
      }
      entry.bytes += bytes.length;
      return { bytes: entry.bytes };
    } finally {
      this.busy = false;
    }
  }
  async save({ id, size }, choose) {
    const entry = this.entry(id);
    if (this.busy || entry.sealed || entry.bytes !== size || size < 60)
      throw Error('Wait for the complete backup before saving.');
    this.busy = true;
    entry.sealed = true;
    let temporary;
    try {
      await entry.handle.sync();
      await entry.handle.close();
      entry.handle = null;
      const target = await choose(BACKUP_FILENAME);
      if (!target || this.abandoned) return { status: 'cancelled' };
      temporary = join(dirname(target), '.relay-backup-' + randomUUID() + '.tmp');
      await copyFile(entry.file, temporary, constants.COPYFILE_EXCL);
      const handle = await open(temporary, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
      temporary = null;
      return { status: 'saved' };
    } finally {
      if (temporary) await rm(temporary, { force: true });
      await entry.handle?.close();
      await rm(entry.directory, { recursive: true, force: true });
      this.current = null;
      this.busy = false;
    }
  }
  async cancel({ id }) {
    const entry = this.entry(id);
    if (this.busy) throw Error('Wait for the current backup step to finish.');
    this.current = null;
    await entry.handle?.close();
    await rm(entry.directory, { recursive: true, force: true });
    return { status: 'cancelled' };
  }
  async abandon() {
    this.abandoned = true;
    try {
      while (this.busy) await new Promise((resolve) => setTimeout(resolve, 10));
      if (this.current) await this.cancel({ id: this.current.id });
    } finally {
      this.abandoned = false;
    }
  }
}
