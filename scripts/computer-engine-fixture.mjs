// SPDX-License-Identifier: MIT
import express from 'express';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { ComputerSetup } from '../server/computer-setup.mjs';
import { createApp } from '../server/app.mjs';
export async function engineFixture(directory, { host, tls, accessKey }) {
  const store = new Store(join(directory, 'workspace/relay.sqlite'), { sample: false });
  const computer = new PrivateComputer(store, {
    enabled: true,
    deployment: directory,
    dockerHost: host,
  });
  computer.db.prepare("UPDATE computer_meta SET controller='owner' WHERE id=1").run();
  const setup = new ComputerSetup(computer, {
    root: resolve('.'),
    environment: { DOCKER_HOST: host },
  });
  const app = createApp(
    store,
    {
      mode: 'sample',
      computer,
      computerSetup: setup,
      provider: { configured: false },
      google: { configured: false },
      browser: { enabled: false },
      terminal: { enabled: false },
    },
    { host: '127.0.0.1', port: 0, accessKey, publicUrl: 'https://127.0.0.1' },
  );
  app.use(express.static(resolve('dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
  const server = createServer(tls, app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    store,
    computer,
    setup,
    url: `https://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await setup.engineControl.close();
      await setup.cancel();
      // Only this fixture's resources, on its explicitly selected engine.
      if ((await computer.dockerRun(['info', '--format', '{{.OSType}}'])).exitCode === 0) {
        await computer.stop();
        await computer.checked(['rm', '-f', computer.name, computer.runtime.name]);
        await computer.checked(['volume', 'rm', computer.volume, computer.displayVolume]);
      }
      store.close();
    },
  };
}
