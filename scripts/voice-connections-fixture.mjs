// SPDX-License-Identifier: MIT
// Controlled HTTP services for voice setup acceptance; never loaded in production.
import express from 'express';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { Store } from '../server/store.mjs';
import { VoiceConnections } from '../server/voice-connections.mjs';
import { ModelConnections, modelVaultKey } from '../server/model-connections.mjs';
import { BackgroundWorker } from '../server/worker.mjs';
import { createApp } from '../server/app.mjs';
import { audioFixture } from './audio-fixture.mjs';
export async function voiceConnectionsFixture(
  directory,
  { accessKey = '', tls, html, configureApp } = {},
) {
  const requests = [];
  const controls = { hold: false, release: null, aborted: 0 };
  const endpoint = express();
  endpoint.use(async (req, res, next) => {
    if (req.get('authorization') === 'Bearer rejected-key')
      return res.status(401).send('Provider detail containing rejected-key');
    if (controls.hold) {
      res.once('close', () => {
        if (!res.writableEnded) controls.aborted++;
      });
      await new Promise((resolve) => {
        controls.release = resolve;
      });
    }
    next();
  });
  endpoint.post(
    '/v1/audio/transcriptions',
    express.raw({ type: '*/*', limit: '10mb' }),
    async (req, res) => {
      const form = await new Request('http://localhost', {
        method: 'POST',
        headers: req.headers,
        body: req.body,
      }).formData();
      requests.push({
        kind: 'transcription',
        key: req.get('authorization'),
        model: form.get('model'),
        bytes: Buffer.from(await form.get('file').arrayBuffer()),
      });
      res.json({ text: 'Plan a quiet afternoon.' });
    },
  );
  endpoint.use(express.json());
  endpoint.post('/v1/audio/speech', (req, res) => {
    requests.push({ kind: 'speech', key: req.get('authorization'), ...req.body });
    res.type('audio/wav').send(audioFixture(0.3));
  });
  endpoint.post('/v1/chat/completions', (req, res) => {
    requests.push({ kind: 'chat', ...req.body });
    res.json({
      choices: [
        {
          message: { role: 'assistant', content: 'Take a short walk and enjoy a quiet afternoon.' },
          finish_reason: 'stop',
        },
      ],
    });
  });
  const providerServer = endpoint.listen(0, '127.0.0.1');
  await once(providerServer, 'listening');
  const baseUrl = `http://127.0.0.1:${providerServer.address().port}/v1`;
  const store = new Store(join(directory, 'state.sqlite'), { sample: false });
  const voiceConnections = new VoiceConnections(store, { key: modelVaultKey(directory) });
  const provider = new ModelConnections(store, { key: modelVaultKey(directory) });
  provider.save({
    preset: 'custom',
    protocol: 'chat',
    baseUrl,
    model: 'controlled-chat',
    name: 'Test chat model',
    apiKey: '',
  });
  const services = {
    mode: 'live',
    voiceConnections,
    speech: voiceConnections.speech,
    transcription: voiceConnections.transcription,
    provider,
    google: { configured: false },
    browser: { enabled: false },
    terminal: { enabled: false },
  };
  const worker = new BackgroundWorker(store, services, { pollMs: 100 });
  services.worker = worker;
  const app = createApp(store, services, { host: '127.0.0.1', port: 0, accessKey });
  configureApp?.(app);
  if (html) app.get('/', (_req, res) => res.type('html').send(html));
  app.use(express.static(resolve('dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
  const server = tls ? createServer(tls, app).listen(0, '127.0.0.1') : app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  worker.start();
  return {
    store,
    services,
    voiceConnections,
    requests,
    controls,
    baseUrl,
    url: `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`,
    async close() {
      controls.release?.();
      await worker.stop();
      services.connectors?.close();
      services.notifications?.close();
      for (const s of [server, providerServer]) {
        s.closeAllConnections();
        await new Promise((r) => s.close(r));
      }
      store.close();
    },
  };
}
