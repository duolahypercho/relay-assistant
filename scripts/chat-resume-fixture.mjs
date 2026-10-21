// SPDX-License-Identifier: MIT
// Actual selected Colima engine and Docker desktop, controlled independent model.
import express from 'express';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { ComputerSetup, setupProcess } from '../server/computer-setup.mjs';
import { createApp } from '../server/app.mjs';
import { ModelProvider } from '../server/model.mjs';
import { BackgroundWorker } from '../server/worker.mjs';
export async function chatResumeFixture(
  directory,
  { host, tls, accessKey = '', manualHost = false },
) {
  const store = new Store(join(directory, 'relay.sqlite'), { sample: false });
  const computer = new PrivateComputer(store, {
    enabled: true,
    deployment: directory,
    dockerHost: manualHost ? undefined : host,
  });
  if (manualHost)
    computer.dockerEnvironment = { ...process.env, DOCKER_HOST: host, DOCKER_CONTEXT: '' };
  computer.db.prepare("UPDATE computer_meta SET controller='owner' WHERE id=1").run();
  const controls = { mode: 'real', starts: 0 },
    requests = [];
  const setup = new ComputerSetup(computer, {
    root: resolve('.'),
    environment: { DOCKER_HOST: host, ...(manualHost ? { RELAY_DESKTOP_ENABLED: 'true' } : {}) },
    runner: async (binary, args, options) => {
      if (args[0] === 'start' && args.includes('--save-config=false')) {
        controls.starts++;
        if (controls.mode === 'fail')
          return { exitCode: 1, stdout: '', stderr: 'Private runtime diagnostic' };
        if (controls.mode === 'hold') {
          await new Promise((_, reject) => {
            if (options.signal.aborted) return reject(options.signal.reason);
            options.signal.addEventListener('abort', () => reject(options.signal.reason), {
              once: true,
            });
          });
        }
      }
      return setupProcess(binary, args, options);
    },
  });
  const modelApp = express();
  modelApp.use(express.json());
  modelApp.post('/v1/chat/completions', (req, res) => {
    requests.push({ controller: computer.controller, body: req.body });
    res.json({
      choices: [{ message: { content: 'Ready. We can continue.' }, finish_reason: 'stop' }],
    });
  });
  const modelServer = modelApp.listen(0, '127.0.0.1');
  await once(modelServer, 'listening');
  const provider = new ModelProvider({
    baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`,
    model: 'resume-check',
    protocol: 'chat',
  });
  const services = {
    mode: 'live',
    computer,
    computerSetup: setup,
    provider,
    google: { configured: false },
    browser: { enabled: false },
    terminal: { enabled: false },
  };
  const worker = new BackgroundWorker(store, services, { pollMs: 50 });
  services.worker = worker;
  const app = createApp(store, services, { host: '127.0.0.1', port: 0, accessKey });
  app.use(express.static(resolve('dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
  const server = tls ? createServer(tls, app).listen(0, '127.0.0.1') : app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  worker.start();
  return {
    store,
    computer,
    setup,
    controls,
    requests,
    services,
    url: `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`,
    async close() {
      await worker.stop();
      await setup.engineControl.close();
      await setup.cancel();
      services.connectors?.close();
      services.notifications?.close();
      server.closeAllConnections();
      modelServer.closeAllConnections();
      await Promise.all([
        new Promise((r) => server.close(r)),
        new Promise((r) => modelServer.close(r)),
      ]);
      if ((await computer.dockerRun(['info', '--format', '{{.OSType}}'])).exitCode === 0) {
        await computer.stop();
        await computer.checked(['rm', '-f', computer.name, computer.runtime.name]);
        await computer.checked(['volume', 'rm', computer.volume, computer.displayVolume]);
      }
      store.close();
    },
  };
}
