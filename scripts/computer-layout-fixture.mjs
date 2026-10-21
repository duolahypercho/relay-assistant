// SPDX-License-Identifier: MIT
// Controlled screen/action boundary for layout and native gesture acceptance.
// Uses an original capture of Relay's own guest; never launches a VM or model.
import express from 'express';
import { createServer as http } from 'node:http';
import { createServer as https } from 'node:https';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { createApp } from '../server/app.mjs';

export async function computerLayoutFixture({ tls, accessKey = '' } = {}) {
  const store = new Store(':memory:', { sample: false });
  const actions = [];
  const computer = new PrivateComputer(store, {
    enabled: true,
    runner: async () => {
      throw Error('Layout fixture cannot launch a runtime');
    },
  });
  const state = {
    enabled: true,
    state: 'running',
    controller: 'owner',
    network: 'offline',
    web: { enabled: false, sites: [] },
    screenshot: (await readFile(resolve('tests/fixtures/computer-desktop.jpg'))).toString('base64'),
    title: 'Relay private desktop',
  };
  const setController = (owner) => {
    state.controller = owner;
    store.db.prepare('UPDATE computer_meta SET controller=? WHERE id=1').run(owner);
    return { ...state };
  };
  setController('owner');
  computer.status = computer.screenshot = async () => ({ ...state });
  computer.takeControl = async () => setController('owner');
  computer.release = async () => setController('agent');
  computer.perform = async (input) => {
    actions.push(input);
    return { ok: true };
  };
  computer.stop = async () => {
    state.state = 'stopped';
    return { ...state };
  };
  computer.start = async () => {
    state.state = 'running';
    return { ...state };
  };
  computer.jobs.list = () => [];
  const server = tls ? https(tls) : http();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`;
  const app = createApp(
    store,
    {
      mode: 'sample',
      computer,
      provider: { configured: false },
      google: { configured: false },
      browser: { enabled: false },
      terminal: { enabled: false },
      privateBrowser: {
        enabled: true,
        ownerView: async () => ({
          controller: 'agent',
          connected: false,
          requests: [],
          controls: [],
        }),
      },
    },
    { host: '127.0.0.1', port: 0, accessKey, ...(tls ? { publicUrl: url } : {}) },
  );
  app.use(express.static(resolve('dist')));
  app.get('/{*path}', (_q, r) => r.sendFile(resolve('dist/index.html')));
  server.on('request', app);
  return {
    url,
    store,
    state,
    actions,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      store.close();
    },
  };
}
