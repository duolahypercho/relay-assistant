// SPDX-License-Identifier: MIT
// Real private-engine acceptance. Only release delivery can be held/failed by the harness.
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import express from 'express';
import { createServer } from 'node:https';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { ComputerSetup, setupProcess } from '../server/computer-setup.mjs';
import { ComputerInstallation } from '../server/computer-installation.mjs';
import { createApp } from '../server/app.mjs';
export async function computerInstallFixture({ live = true, artifacts, accessKey = '', tls } = {}) {
  const directory = await mkdtemp('/tmp/relay-ci-');
  const store = new Store(join(directory, 'state.sqlite'), { sample: false });
  const computer = new PrivateComputer(store, {
    deployment: directory,
    docker: join(directory, 'not-installed-docker'),
    web: true,
  });
  const calls = [];
  let delivery = 'hold';
  const runner = async (binary, args, options) => {
    const call = { binary, args, env: options?.env };
    calls.push(call);
    const result = await setupProcess(binary, args, options);
    call.result = result;
    return result;
  };
  const setup = new ComputerSetup(computer, {
    root: resolve('.'),
    environment: {},
    home: join(directory, 'fresh-home'),
    runner,
  });
  const manager = (setup.installation = new ComputerInstallation(setup, {
    root: join(directory, 'vm'),
    releaseOptions: {
      fetcher: async (url, init) => {
        if (delivery === 'hold')
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3]));
                init.signal.addEventListener('abort', () => controller.error(init.signal.reason), {
                  once: true,
                });
              },
            }),
          );
        if (delivery === 'fail') throw Error('Deliberate acceptance offline delivery');
        if (live) return fetch(url, init);
        const artifact = manager.release.release.artifacts.find((a) => a.url === url);
        return new Response(await readFile(join(artifacts, artifact.name)));
      },
    },
  }));
  const services = {
    mode: 'sample',
    computer,
    computerSetup: setup,
    provider: { configured: false },
    google: { configured: false },
    browser: { enabled: false },
    terminal: { enabled: false },
  };
  const app = createApp(store, services, { host: '127.0.0.1', port: 0, accessKey });
  app.use(express.static(resolve('dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
  const server = tls ? createServer(tls, app).listen(0, '127.0.0.1') : app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    directory,
    store,
    computer,
    setup,
    manager,
    calls,
    url: `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`,
    delivery(value) {
      delivery = value;
    },
    async close() {
      await manager.close();
      await setup.engineControl.close();
      await setup.cancel();
      if (computer.enabled) await computer.shutdown().catch(() => {});
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      // This new test root is never an owner profile; retain on cleanup failure for diagnosis.
      if ((await manager.owned()) && (await manager.release.installed())) {
        const stop = await runner(manager.colima, ['stop', '--profile', 'relay'], {
          env: manager.env,
          timeout: 90000,
        });
        const gone = await runner(
          manager.colima,
          ['delete', '--force', '--data', '--profile', 'relay'],
          { env: manager.env, timeout: 90000 },
        );
        if (gone.exitCode) throw Error('Test VM cleanup failed; kept ' + directory);
      }
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
