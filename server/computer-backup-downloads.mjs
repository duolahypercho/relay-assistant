import { cleanEncryptedBackupStaging } from './encrypted-backup-staging.mjs';
// SPDX-License-Identifier: MIT
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { checkBackupPassword } from './computer-backup-codec.mjs';
import { MAX_BACKUP_BYTES } from '../shared/computer-backup.mjs';
const fail = (message, status = 409) => Object.assign(Error(message), { status });

// Only encrypted files are staged. Tickets are session-bound, short-lived and never
// included in workspace state or model context. Active transfers share the snapshot mutex.
export class ComputerBackupDownloads {
  constructor(snapshots, transfer, { lifetime = 15 * 60 * 1000 } = {}) {
    this.snapshots = snapshots;
    this.transfer = transfer;
    this.lifetime = lifetime;
    this.entries = new Map();
  }
  begin(owner, { pointId, password }) {
    this.snapshots.available();
    checkBackupPassword(password);
    if (pointId && !this.snapshots.points().some((point) => point.id === pointId))
      throw fail('Choose a saved restore point.', 404);
    if (!pointId && this.snapshots.points().length >= 10)
      throw fail('Remove an older restore point or back up an existing one.');
    if (this.entries.size >= 2) throw fail('Finish or cancel the other backup download first.');
    const id = randomBytes(32).toString('hex');
    const entry = {
      id,
      owner,
      phase: 'preparing',
      controller: new AbortController(),
      size: 0,
      directory: null,
      file: null,
      error: '',
      pending: null,
    };
    this.entries.set(id, entry);
    entry.pending = (async () => {
      try {
        if (!pointId) {
          this.snapshots.run('saving', async () => {
            pointId = await this.snapshots.capture();
          });
          await this.snapshots.pending;
          if (this.snapshots.phase === 'error') throw fail(this.snapshots.error);
        }
        await (this.cleanup ||= cleanEncryptedBackupStaging(
          tmpdir(),
          'relay-encrypted-backup-',
          'backup.relaybackup',
        ));
        entry.directory = await mkdtemp(join(tmpdir(), 'relay-encrypted-backup-'));
        entry.file = join(entry.directory, 'backup.relaybackup');
        if (entry.controller.signal.aborted) return;
        const output = createWriteStream(entry.file, { flags: 'wx', mode: 0o600 });
        output.on('error', () => {});
        try {
          await this.transfer(this.snapshots, {
            kind: 'export',
            pointId,
            password,
            output,
            signal: entry.controller.signal,
          });
        } finally {
          output.destroy();
        }
        const info = await stat(entry.file);
        if (!info.isFile() || info.size < 60 || info.size > MAX_BACKUP_BYTES)
          throw fail('The prepared backup could not be verified.');
        entry.size = info.size;
        entry.phase = 'ready';
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => void this.remove(owner, id).catch(() => {}), this.lifetime);
        entry.timer.unref?.();
      } catch (error) {
        entry.phase = 'error';
        entry.error = entry.controller.signal.aborted ? 'Backup cancelled.' : error.message;
      } finally {
        password = '';
        if (entry.phase !== 'ready' && entry.directory)
          await rm(entry.directory, { recursive: true, force: true });
      }
    })();
    entry.timer = setTimeout(
      () => void this.remove(owner, id).catch(() => {}),
      Math.max(this.lifetime, 25 * 60 * 1000),
    );
    entry.timer.unref?.();
    return this.status(owner, id);
  }
  get(owner, id) {
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner)
      throw fail('This backup download expired. Prepare it again.', 404);
    return entry;
  }
  status(owner, id) {
    const e = this.get(owner, id);
    return { id: e.id, phase: e.phase, size: e.size, error: e.error };
  }
  ready(owner, id) {
    const entry = this.get(owner, id);
    if (entry.phase !== 'ready')
      throw fail(entry.error || 'Wait for the backup to finish preparing.');
    return entry;
  }
  async remove(owner, id) {
    const entry = this.get(owner, id);
    clearTimeout(entry.timer);
    entry.controller.abort();
    await entry.pending;
    if (entry.directory) await rm(entry.directory, { recursive: true, force: true });
    this.entries.delete(id);
    return { cancelled: true };
  }
  async close() {
    await Promise.all([...this.entries.values()].map((e) => this.remove(e.owner, e.id)));
  }
}
