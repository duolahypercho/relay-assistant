// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { stat, readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { ComputerBackupDownloads } from '../server/computer-backup-downloads.mjs';
const password = 'synthetic download password';
function fixture(t, options = {}) {
  let count = 0;
  const snapshots = {
    available() {},
    points: () => [{ id: 'saved' }],
    async capture() {
      count++;
      return 'fresh';
    },
    run(_phase, fn) {
      this.pending = fn().then(() => {
        this.phase = 'done';
      });
    },
  };
  const transfer = async (_service, { output, signal }) =>
    pipeline(Readable.from([Buffer.from('RELAY-COMPUTER-1' + 'x'.repeat(100))]), output, {
      signal,
    });
  const downloads = new ComputerBackupDownloads(snapshots, transfer, options);
  t.after(() => downloads.close());
  return { snapshots, downloads, count: () => count };
}
test('backup download tickets are private, session-bound, cleaned on completion and absent from snapshots', async (t) => {
  const f = fixture(t),
    ticket = f.downloads.begin('owner', { pointId: 'saved', password });
  await f.downloads.get('owner', ticket.id).pending;
  const ready = f.downloads.ready('owner', ticket.id);
  assert.equal((await stat(ready.file)).mode & 0o777, 0o600);
  assert.equal((await readFile(ready.file)).length, ready.size);
  assert.throws(() => f.downloads.ready('another-session', ticket.id), /expired/);
  assert.throws(
    () => f.downloads.begin('owner', { pointId: 'missing', password }),
    /saved restore point/,
  );
  assert.ok(!JSON.stringify(f.downloads.status('owner', ticket.id)).includes(ready.directory));
  assert.ok(!JSON.stringify(f.downloads.status('owner', ticket.id)).includes(password));
  await f.downloads.remove('owner', ticket.id);
  await assert.rejects(stat(ready.directory), { code: 'ENOENT' });
  assert.throws(() => f.downloads.status('owner', ticket.id), /expired/);
});
test('one fresh capture supplies a backup and expiry removes encrypted staging', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { lifetime: 50 }),
    ticket = f.downloads.begin('owner', { password });
  await f.downloads.get('owner', ticket.id).pending;
  assert.equal(f.count(), 1);
  const directory = f.downloads.ready('owner', ticket.id).directory;
  const remove = t.mock.method(f.downloads, 'remove');
  t.mock.timers.tick(49);
  assert.equal(remove.mock.callCount(), 0);
  assert((await stat(directory)).isDirectory());
  t.mock.timers.tick(1);
  assert.equal(remove.mock.callCount(), 1);
  // Timer expiry starts asynchronous removal; wait for actual filesystem cleanup.
  await remove.mock.calls[0].result;
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  assert.throws(() => f.downloads.status('owner', ticket.id), /expired/);
});
test('cancelled preparation cleans partial output without exposing an unfinished download', async (t) => {
  const f = fixture(t);
  f.downloads.transfer = async (_s, { output, signal }) => {
    output.write(Buffer.from('RELAY-COMPUTER-1'));
    await new Promise((_, reject) => {
      const abort = () => reject(Error('cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  };
  const ticket = f.downloads.begin('owner', { pointId: 'saved', password });
  while (!f.downloads.get('owner', ticket.id).file)
    await new Promise((resolve) => setTimeout(resolve, 1));
  const entry = f.downloads.get('owner', ticket.id);
  assert.throws(() => f.downloads.ready('owner', ticket.id), /Wait/);
  await f.downloads.remove('owner', ticket.id);
  await assert.rejects(stat(entry.directory), { code: 'ENOENT' });
});
test('HTTP download and cancellation reject another owner session and browser completion removes the ticket', async (t) => {
  const { default: express } = await import('express');
  const { computerBackupRoutes } = await import('../server/computer-backups.mjs');
  const f = fixture(t);
  f.snapshots.downloads = f.downloads;
  const app = express();
  app.use(express.json());
  computerBackupRoutes(app, f.snapshots);
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const base = `http://127.0.0.1:${server.address().port}/api/computer/backups/downloads`;
  const request = (suffix, session, options = {}) =>
    fetch(base + suffix, {
      ...options,
      headers: {
        cookie: `other=value; relay_session=${session}`,
        'content-type': 'application/json',
      },
    });
  const response = await request('', 'first', {
    method: 'POST',
    body: JSON.stringify({ pointId: 'saved', password }),
  });
  assert.equal(response.status, 200);
  const { id } = await response.json();
  await [...f.downloads.entries.values()][0].pending;
  for (const suffix of [`/${id}`, `/${id}/file`, `/${id}/cancel`]) {
    const denied = await request(
      suffix,
      'second',
      suffix.endsWith('cancel') ? { method: 'POST', body: '{}' } : {},
    );
    assert.equal(denied.status, 404);
  }
  const file = await request(`/${id}/file?download=1`, 'first');
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition'), /Relay-computer.relaybackup/);
  assert.equal((await file.arrayBuffer()).byteLength, 116);
  for (let tries = 0; f.downloads.entries.size && tries < 100; tries++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.downloads.entries.size, 0);
});
