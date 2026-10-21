// SPDX-License-Identifier: MIT
import express from 'express';
import { createServer as createHttpsServer } from 'node:https';
import { once } from 'node:events';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { ComputerSetup } from '../server/computer-setup.mjs';
import { ComputerMaintenance } from '../server/computer-maintenance.mjs';
import { ComputerSnapshots } from '../server/computer-snapshots.mjs';
import { createApp } from '../server/app.mjs';

async function previousSources(directory) {
  const root = join(directory, 'previous-version');
  await mkdir(join(root, 'docker'), { recursive: true });
  for (const name of [
    'desktop.Dockerfile',
    'guest.py',
    'jobs.py',
    'network-bridge.py',
    'desktop-start.sh',
    'runtime-start.sh',
    'desktop-home.html',
    'office-policy.xcd',
  ]) {
    let bytes = await readFile(resolve('docker', name));
    if (name === 'desktop-home.html')
      bytes = Buffer.concat([
        bytes,
        Buffer.from('\n<!-- Previous Relay workspace acceptance fixture -->\n'),
      ]);
    await writeFile(join(root, 'docker', name), bytes);
  }
  return root;
}
export async function oldComputer(
  directory,
  { environment = { DOCKER_HOST: process.env.RELAY_TEST_DOCKER_HOST } } = {},
) {
  const root = await previousSources(directory);
  const store = new Store(join(directory, 'workspace/relay.sqlite'), { sample: false });
  const computer = new PrivateComputer(store, { deployment: join(directory, 'workspace') });
  const oldSetup = new ComputerSetup(computer, { root, environment });
  oldSetup.start();
  await oldSetup.pending;
  if (oldSetup.status().phase !== 'ready') throw new Error(oldSetup.status().error);
  return { store, computer, oldImage: computer.image };
}
export async function maintenanceFixture(
  directory,
  {
    fresh = false,
    tls,
    accessKey = '',
    environment = { DOCKER_HOST: process.env.RELAY_TEST_DOCKER_HOST },
  } = {},
) {
  let f;
  if (fresh) {
    const store = new Store(join(directory, 'workspace/relay.sqlite'), { sample: false });
    f = {
      store,
      computer: new PrivateComputer(store, { deployment: join(directory, 'workspace') }),
    };
  } else f = await oldComputer(directory, { environment });
  const setup = new ComputerSetup(f.computer, {
    root: fresh ? await previousSources(directory) : resolve('.'),
    environment,
  });
  const maintenance = new ComputerMaintenance(f.computer, setup);
  const snapshots = new ComputerSnapshots(f.computer);
  const app = createApp(
    f.store,
    {
      mode: 'sample',
      computer: f.computer,
      computerSetup: setup,
      computerMaintenance: maintenance,
      computerSnapshots: snapshots,
      provider: { configured: false },
      google: { configured: false },
      browser: { enabled: false },
      terminal: { enabled: false },
    },
    { host: '127.0.0.1', port: 0, accessKey, ...(tls ? { publicUrl: 'https://127.0.0.1' } : {}) },
  );
  app.use(express.static(resolve('dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
  const server = tls
    ? createHttpsServer(tls, app).listen(0, '127.0.0.1')
    : app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    ...f,
    setup,
    maintenance,
    snapshots,
    url: `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`,
    async close() {
      await setup.cancel();
      await maintenance.close();
      await snapshots.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await cleanupComputer(f);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
export async function cleanupComputer({ computer, store }) {
  await computer.stop().catch(() => {});
  await computer.dockerRun(['rm', '-f', computer.name, computer.runtime.name]).catch(() => {});
  await computer
    .dockerRun(['volume', 'rm', computer.volume, computer.displayVolume])
    .catch(() => {});
  if (store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='computer_snapshots'").get())
    for (const { volume } of store.db.prepare('SELECT volume FROM computer_snapshots').all()) {
      await computer.verifyVolume(volume);
      await computer.checked(['volume', 'rm', volume]);
    }
  store.close();
}
