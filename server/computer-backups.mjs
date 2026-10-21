// SPDX-License-Identifier: MIT
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { randomUUID, createHash } from 'node:crypto';
import { ComputerBackupDownloads } from './computer-backup-downloads.mjs';
import { BACKUP_FILENAME } from '../shared/computer-backup.mjs';
import {
  checkBackupPassword,
  encryptComputerBackup,
  decryptComputerBackup,
} from './computer-backup-codec.mjs';
const guest = await readFile(new URL('./computer-backup-guest.py', import.meta.url), 'utf8');
const failure = (message, status = 409) => Object.assign(Error(message), { status });

export async function transferComputerBackup(
  snapshots,
  { kind, pointId, password, input, output, signal },
) {
  snapshots.available();
  checkBackupPassword(password);
  if (!['export', 'import'].includes(kind)) throw failure('Choose a backup action.', 400);
  if (kind === 'import' && snapshots.points().length >= 10)
    throw failure('Remove an older restore point before importing a backup.');
  const p = snapshots.computer;
  const point =
    kind === 'export'
      ? snapshots.db.prepare('SELECT * FROM computer_snapshots WHERE id=?').get(pointId || '')
      : null;
  if (kind === 'export' && (!point || point.volume === p.volume))
    throw failure('Choose a saved restore point.', 404);
  let result;
  snapshots.review = null;
  snapshots.run(kind === 'export' ? 'exporting' : 'importing', () =>
    snapshots.exclusive(async () => {
      signal?.throwIfAborted();
      const pointId = randomUUID().replaceAll('-', '');
      const op = snapshots.operation(
        `backup-${kind}`,
        point?.volume,
        kind === 'import' ? `${p.name}-snapshot-${pointId}` : null,
      );
      snapshots.journal(op);
      try {
        if (kind === 'export') await p.verifyVolume(op.source);
        else {
          if (await snapshots.volumeExists(op.target))
            throw failure('This backup destination already exists.');
          await p.checked(['volume', 'create', '--label', `org.relay.owner=${p.owner}`, op.target]);
          op.created = true;
          snapshots.journal(op);
          await p.verifyVolume(op.target);
        }
        const mount =
          kind === 'export'
            ? `type=volume,source=${op.source},target=/source,readonly`
            : `type=volume,source=${op.target},target=/workspace`;
        await p.checked([
          'create',
          '--name',
          op.helper,
          '--label',
          `org.relay.owner=${p.owner}`,
          '--label',
          'org.relay.role=snapshot-backup',
          '--network',
          'none',
          '--read-only',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--pids-limit',
          '32',
          '--memory',
          '512m',
          '--memory-swap',
          '512m',
          '--cpus',
          '1',
          '--user',
          '1000:1000',
          '--ipc',
          'private',
          '--workdir',
          '/tmp',
          '--mount',
          mount,
          '--entrypoint',
          '/usr/bin/python3',
          '-i',
          op.image,
          '-c',
          guest,
          kind === 'export' ? 'pack' : 'unpack',
        ]);
        const args = ['start', '--attach', '--interactive', op.helper];
        const child = spawn(p.docker, p.dockerHost ? ['--host', p.dockerHost, ...args] : args, {
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            HOME: process.env.HOME,
            PATH: process.env.PATH,
            ...p.dockerEnvironment,
            DOCKER_HOST: p.dockerHost ? '' : process.env.DOCKER_HOST,
            DOCKER_CONTEXT: p.dockerHost ? '' : process.env.DOCKER_CONTEXT,
          },
        });
        let stopped = false,
          ending = false;
        const stop = () => {
          stopped = true;
          child.stdin.destroy();
          child.stdout.destroy();
          child.kill('SIGKILL');
        };
        const cancel = () => {
          stop();
          input?.destroy?.(failure('Computer backup transfer cancelled or timed out.'));
        };
        const timer = setTimeout(cancel, 15 * 60 * 1000);
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
        child.stderr.resume(); // Deliberately exclude paths and container diagnostics from API errors.
        child.stdin.on('error', () => {});
        const closed = new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code) =>
            code === 0 && !stopped
              ? resolve()
              : reject(
                  failure(
                    'Computer backup transfer failed. Check the backup, available disk space and computer runtime.',
                  ),
                ),
          );
        });
        void closed.catch((error) => {
          if (!ending) input?.destroy?.(error);
        });
        try {
          if (kind === 'export') {
            child.stdin.end();
            async function* source() {
              yield* child.stdout;
              await closed;
            }
            await pipeline(encryptComputerBackup(source(), password), output, { signal });
            result = { exported: true };
          } else {
            let stats = '';
            child.stdout.on('data', (chunk) => {
              stats += chunk;
              if (stats.length > 4096) stop();
            });
            await pipeline(decryptComputerBackup(input, password), child.stdin, { signal });
            await closed;
            let value;
            try {
              value = JSON.parse(stats);
            } catch {
              throw failure('The imported backup could not be verified.');
            }
            if (
              !Number.isSafeInteger(value.files) ||
              value.files < 0 ||
              value.files > 200000 ||
              !Number.isSafeInteger(value.bytes) ||
              value.bytes < 0 ||
              value.bytes > 8 * 1024 ** 3
            )
              throw failure('The imported backup could not be verified.');
            snapshots.db
              .prepare('INSERT INTO computer_snapshots VALUES (?,?,?,?,?,?)')
              .run(
                pointId,
                op.target,
                new Date().toISOString(),
                'Imported backup',
                value.bytes,
                value.files,
              );
            result = { point: snapshots.points().find((point) => point.id === pointId) };
          }
        } finally {
          ending = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
          stop();
          await closed.catch(() => {});
        }
      } finally {
        await snapshots.finish(op);
      }
    }),
  );
  await snapshots.pending;
  if (snapshots.phase === 'error') throw failure(snapshots.error);
  return result;
}

// These owner-authenticated routes are never registered as assistant tools. Backup passwords
// and bytes never enter chat, exported app state, SQLite, model context or diagnostic logs.
export function computerBackupRoutes(app, snapshots) {
  const downloads =
    snapshots &&
    (snapshots.downloads ||= new ComputerBackupDownloads(snapshots, transferComputerBackup));
  const owner = (req) =>
    createHash('sha256')
      .update(
        (req.headers.cookie || '')
          .split(';')
          .map((part) => part.trim())
          .find((part) => part.startsWith('relay_session=')) || 'local',
      )
      .digest('hex');
  app.post('/api/computer/backups/downloads', (req, res, next) => {
    try {
      if (!downloads) return res.status(503).json({ error: 'Computer backups are unavailable.' });
      res.json(downloads.begin(owner(req), req.body || {}));
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/computer/backups/downloads/:id', (req, res, next) => {
    try {
      if (!downloads) throw failure('Computer backups are unavailable.', 503);
      res.json(downloads.status(owner(req), req.params.id));
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/computer/backups/downloads/:id/file', (req, res, next) => {
    try {
      if (!downloads) throw failure('Computer backups are unavailable.', 503);
      const entry = downloads.ready(owner(req), req.params.id);
      res.set('Content-Type', 'application/octet-stream');
      res.download(entry.file, BACKUP_FILENAME, { acceptRanges: false }, (error) => {
        if (error && !res.headersSent) next(error);
        if (!error && req.query.download === '1')
          void downloads.remove(owner(req), req.params.id).catch(() => {});
      });
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/computer/backups/downloads/:id/cancel', async (req, res, next) => {
    try {
      if (!downloads) throw failure('Computer backups are unavailable.', 503);
      res.json(await downloads.remove(owner(req), req.params.id));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/computer/backups/export', async (req, res, next) => {
    if (!snapshots) return res.status(503).json({ error: 'Computer backups are unavailable.' });
    const controller = new AbortController();
    const disconnect = () => {
      if (!res.writableFinished) controller.abort();
    };
    res.on('close', disconnect);
    try {
      res.set('Content-Type', 'application/octet-stream');
      res.set('Content-Disposition', 'attachment; filename="Relay-computer.relaybackup"');
      await transferComputerBackup(snapshots, {
        kind: 'export',
        pointId: req.body?.pointId,
        password: req.body?.password,
        output: res,
        signal: controller.signal,
      });
    } catch (error) {
      if (res.headersSent || res.destroyed) res.destroy();
      else {
        res.removeHeader('Content-Disposition');
        next(error);
      }
    } finally {
      res.off('close', disconnect);
    }
  });
  app.post('/api/computer/backups/import', async (req, res, next) => {
    if (!snapshots) return res.status(503).json({ error: 'Computer backups are unavailable.' });
    if (!req.is('application/octet-stream'))
      return res.status(415).json({ error: 'Choose a Relay computer backup.' });
    const controller = new AbortController();
    const disconnect = () => {
      if (!res.writableFinished) controller.abort();
    };
    res.on('close', disconnect);
    try {
      const encoded = req.get('X-Relay-Backup-Password') || '';
      if (!/^[A-Za-z0-9_-]{16,1366}$/.test(encoded))
        throw failure('Enter the backup password.', 400);
      const password = Buffer.from(encoded, 'base64url').toString('utf8');
      res.json(
        await transferComputerBackup(snapshots, {
          kind: 'import',
          password,
          input: req,
          signal: controller.signal,
        }),
      );
    } catch (error) {
      if (!res.destroyed) next(error);
    } finally {
      res.off('close', disconnect);
    }
  });
}
