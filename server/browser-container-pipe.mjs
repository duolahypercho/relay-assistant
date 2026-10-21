// SPDX-License-Identifier: MIT
// Trusted local process adapter. Playwright speaks on fds 3/4, Docker on stdin/stdout.
// Only fixed, already validated container IDs and a local or pinned TLS engine.
import { spawn } from 'node:child_process';
import { Socket } from 'node:net';
import { unlink, rmdir } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
const [docker, host, id] = process.argv.slice(2);
const tls =
  process.env.DOCKER_TLS_VERIFY === '1' &&
  /^\/[^\r\n\0]+$/.test(process.env.DOCKER_CERT_PATH || '');
const remote = tls && /^tcp:\/\/(?:[a-z0-9.-]+|\[[a-f0-9:]+\]):[0-9]{1,5}$/i.test(host || '');
if (
  !docker ||
  (!/^unix:\/\/\/[^\r\n\0]+$/.test(host || '') && !remote) ||
  !/^[a-f0-9]{64}$/.test(id || '')
)
  process.exit(1);
const environment = {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  DOCKER_CONFIG: process.env.DOCKER_CONFIG,
  ...(remote ? { DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: process.env.DOCKER_CERT_PATH } : {}),
};
const child = spawn(docker, ['--host', host, 'start', '-a', '-i', id], {
  shell: false,
  stdio: ['pipe', 'pipe', 'ignore'],
  env: environment,
});
// These are pipe sockets, not files. fs.ReadStream would leave a blocking
// threadpool read alive while destroying a pipe whose peer is still open.
const input = new Socket({ fd: 3, readable: true, writable: false }),
  output = new Socket({ fd: 4, readable: false, writable: true });
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  child.stdin.destroy();
  input.destroy();
  const cleanup = spawn(docker, ['--host', host, 'rm', '-f', id], {
    shell: false,
    stdio: 'ignore',
    env: environment,
  });
  const timer = setTimeout(() => {
    cleanup.kill('SIGKILL');
    child.kill('SIGKILL');
    process.exit(1);
  }, 5000);
  cleanup.once('error', () => {
    clearTimeout(timer);
    process.exit(1);
  });
  cleanup.once('exit', async () => {
    // Remove only this generated helper and its now-empty private directory,
    // including when the server died before it could do its own cleanup.
    const path = process.argv[1];
    if (
      basename(path) === 'pipe.mjs' &&
      basename(dirname(path)).startsWith('relay-browser-pipe-')
    ) {
      await unlink(path).catch(() => {});
      await rmdir(dirname(path)).catch(() => {});
    }
    clearTimeout(timer);
    process.exit(0);
  });
};
input.pipe(child.stdin);
child.stdout.pipe(output);
for (const stream of [input, output, child.stdin, child.stdout]) stream.on('error', stop);
input.once('end', stop);
child.once('error', stop);
child.once('exit', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('SIGHUP', stop);
