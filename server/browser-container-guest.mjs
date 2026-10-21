// SPDX-License-Identifier: MIT
// Runs only inside the private browser container. CDP uses inherited pipes;
// Chromium has no listening debug port, display mount, or direct network route.
import { spawn } from 'node:child_process';
const child = spawn(
  '/usr/bin/chromium',
  [
    '--headless',
    '--no-sandbox',
    '--remote-debugging-pipe',
    '--user-data-dir=/tmp/relay-browser',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-extensions',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-breakpad',
    '--disable-features=MediaRouter,OptimizationHints,Translate',
    '--disable-dev-shm-usage',
    '--disable-quic',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--proxy-server=http://127.0.0.1:9',
    '--proxy-bypass-list=<-loopback>',
    '--password-store=basic',
    '--use-mock-keychain',
    '--no-startup-window',
  ],
  {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    env: {
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: '/tmp',
      LANG: 'C.UTF-8',
    },
  },
);
const stop = () => process.exit(0); // tini exits and the container namespace drains all descendants.
process.stdin.pipe(child.stdio[3]);
child.stdio[4].pipe(process.stdout);
for (const stream of [process.stdin, process.stdout, child.stdio[3], child.stdio[4]])
  stream.on('error', stop);
process.stdin.on('end', stop);
child.once('error', () => process.exit(1));
child.once('exit', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
