import { createReadStream, createWriteStream } from 'node:fs';
// SPDX-License-Identifier: MIT
import { open, lstat, readFile, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { parseArgs } from 'node:util';
import { emitKeypressEvents } from 'node:readline';
import { checkBackupPassword, MAX_BACKUP_BYTES } from '../server/computer-backup-codec.mjs';

async function prompt(label) {
  if (!process.stdin.isTTY)
    throw Error('Use an interactive terminal or --password-file with a private password file.');
  emitKeypressEvents(process.stdin);
  const raw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stderr.write(label);
  try {
    return await new Promise((resolve, reject) => {
      let value = '';
      const onKey = (text, key) => {
        if (key?.ctrl && key.name === 'c') {
          process.stdin.off('keypress', onKey);
          reject(Error('Cancelled.'));
        } else if (key?.name === 'return') {
          process.stdin.off('keypress', onKey);
          resolve(value);
        } else if (key?.name === 'backspace') value = [...value].slice(0, -1).join('');
        else if (!key?.ctrl && !key?.meta && text && Buffer.byteLength(value + text) <= 1024)
          value += text;
      };
      process.stdin.on('keypress', onKey);
    });
  } finally {
    process.stdin.setRawMode(raw);
    process.stdin.pause();
    process.stderr.write('\n');
  }
}
async function privatePassword(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > 1026 || (process.platform !== 'win32' && info.mode & 0o077))
    throw Error('The password file must be a private regular file (permissions 600).');
  return (await readFile(path, 'utf8')).replace(/\r?\n$/, '');
}
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string', default: 'http://127.0.0.1:4173' },
    point: { type: 'string' },
    'password-file': { type: 'string' },
    help: { type: 'boolean' },
  },
});
const [kind, path] = positionals;
if (values.help) {
  console.log(
    'Computer backup: node scripts/computer-backup.mjs export|import FILE [--url URL] [--point SAVED_POINT_ID] [--password-file PRIVATE_FILE]\nExport saves a fresh restore point unless --point is given. Import adds a restore point; review Restore in Computer to use it. The password is prompted without echo. Remote servers require HTTPS and RELAY_ACCESS_KEY or RELAY_ACCESS_KEY_FILE.',
  );
} else {
  let handle,
    created = false,
    success = false;
  const controller = new AbortController();
  const cancel = () => controller.abort(Error('Cancelled.'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    if (
      !['export', 'import'].includes(kind) ||
      !path ||
      positionals.length !== 2 ||
      (kind === 'import' && values.point)
    )
      throw Error('Choose export or import and one file path. Use --help for options.');
    const url = new URL(values.url);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !['http:', 'https:'].includes(url.protocol) ||
      (url.protocol !== 'https:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))
    )
      throw Error('Use HTTPS for a remote Relay server, or HTTP on loopback.');
    if (url.pathname !== '/') throw Error('Use the Relay server origin without a path.');
    let password = values['password-file']
      ? await privatePassword(values['password-file'])
      : await prompt(kind === 'export' ? 'New backup password: ' : 'Backup password: ');
    checkBackupPassword(password);
    if (
      kind === 'export' &&
      !values['password-file'] &&
      password !== (await prompt('Repeat backup password: '))
    )
      throw Error('Passwords do not match.');
    let cookie = '';
    const accessKey =
      process.env.RELAY_ACCESS_KEY ||
      (process.env.RELAY_ACCESS_KEY_FILE
        ? (await readFile(process.env.RELAY_ACCESS_KEY_FILE, 'utf8')).trim()
        : '');
    async function call(route, options = {}) {
      const response = await fetch(new URL('/api' + route, url), {
        ...options,
        redirect: 'error',
        signal: controller.signal,
        headers: { Cookie: cookie, Origin: url.origin, ...options.headers },
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw Error(detail.error || `Relay returned ${response.status}.`);
      }
      return response;
    }
    if (accessKey) {
      const response = await call('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: accessKey }),
      });
      cookie = (response.headers.get('set-cookie') || '').split(';')[0];
    }
    if (kind === 'export') {
      handle = await open(path, 'wx', 0o600);
      created = true;
      let pointId = values.point;
      if (!pointId) {
        const before = new Set(
          (await (await call('/computer/snapshots')).json()).points.map((point) => point.id),
        );
        await call('/computer/snapshots/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        while (true) {
          const state = await (await call('/computer/snapshots')).json();
          if (!state.busy) {
            if (state.phase !== 'done' || !state.points.length)
              throw Error(state.error || 'A restore point could not be saved.');
            const added = state.points.filter((point) => !before.has(point.id));
            if (added.length !== 1)
              throw Error(
                'Restore points changed during backup. Retry with --point and the saved point you want.',
              );
            pointId = added[0].id;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      const response = await call('/computer/backups/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pointId, password }),
      });
      password = '';
      await pipeline(
        Readable.fromWeb(response.body),
        createWriteStream(path, { fd: handle.fd, autoClose: false }),
        { signal: controller.signal },
      );
      await handle.sync();
      console.log(
        'Computer backup saved. Keep this file and its password separately. Copy it away from the computer’s disk.',
      );
    } else {
      handle = await open(path, 'r');
      const info = await handle.stat();
      if (!info.isFile() || info.size < 60 || info.size > MAX_BACKUP_BYTES)
        throw Error('Choose a complete Relay computer backup within the supported size limit.');
      const response = await call('/computer/backups/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(info.size),
          'X-Relay-Backup-Password': Buffer.from(password).toString('base64url'),
        },
        body: createReadStream(path, { fd: handle.fd, autoClose: false }),
        duplex: 'half',
      });
      password = '';
      const result = await response.json();
      if (!result.point?.id)
        throw Error(
          'Relay did not confirm the imported restore point. Check Computer before retrying.',
        );
      console.log(
        'Backup imported. In Computer → Restore points, review “Imported backup” and choose Restore. Current saved files have not been replaced.',
      );
    }
    success = true;
  } catch (error) {
    console.error(error.message || 'Computer backup failed.');
    process.exitCode = 1;
  } finally {
    await handle?.close();
    if (created && !success) await unlink(path).catch(() => {});
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}
