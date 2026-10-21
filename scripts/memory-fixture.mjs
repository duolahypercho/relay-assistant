// SPDX-License-Identifier: MIT
// Deterministic model decisions for acceptance tests, never used by production.
import express from 'express';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { resolve, join } from 'node:path';
import { Store } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { BackgroundWorker } from '../server/worker.mjs';
export async function memoryFixture(directory, port = 0, { accessKey = '', tls } = {}) {
  const store = new Store(join(directory, 'state.sqlite'), { sample: false });
  const reviews = [],
    forgetReviews = [];
  const provider = {
    configured: true,
    model: 'Controlled memory acceptance',
    complete: async (messages, tools) => {
      if (tools.some((t) => t.name === 'select_memories_to_forget')) {
        const input = JSON.parse(messages.at(-1).content);
        forgetReviews.push(input);
        return {
          text: JSON.stringify({
            slots: input.existingNotes
              .filter((note) => /hotels/.test(note.text))
              .map((note) => note.slot),
          }),
          toolCalls: [],
        };
      }
      if (tools.some((t) => t.name === 'propose_memories')) {
        const input = JSON.parse(messages.at(-1).content);
        reviews.push(input);
        const evidence = input.currentOwnerMessage.match(
          /I (?:now )?prefer (?:quiet|lively|mountain) hotels/,
        )?.[0];
        const existing = input.existingNotes.find((note) => /hotels/.test(note.text));
        return {
          text: '',
          toolCalls: [
            {
              id: 'memory-proposal',
              function: {
                name: 'propose_memories',
                arguments: JSON.stringify({
                  memories: evidence
                    ? [
                        {
                          slot: existing?.slot || 0,
                          text: evidence.replace(/^I (?:now )?prefer /, 'Prefers ') + '.',
                          evidence,
                        },
                      ]
                    : [],
                }),
              },
            },
          ],
        };
      }
      const state = store.read();
      return {
        text: messages[0].content.includes('Memory operation completed by Relay')
          ? 'I forgot your saved hotel preference.'
          : state.profile.memoryLearning === false &&
              state.memories.some(
                (note) =>
                  note.sourceMessageId ===
                  state.messages.findLast((message) => message.role === 'user')?.id,
              )
            ? 'Saved that preference as requested.'
            : state.profile.memoryLearning === false
              ? 'Learning is off. I’ll use that for this conversation without saving a new memory.'
              : state.memories.some((note) => note.proposal)
                ? 'I kept your saved wording and left a possible update for you to review.'
                : 'I’ll keep your hotel preference in mind as we plan.',
        toolCalls: [],
      };
    },
  };
  const services = {
    mode: 'live',
    provider,
    google: { configured: false },
    browser: { enabled: false },
    terminal: { enabled: false },
  };
  const worker = new BackgroundWorker(store, services, { pollMs: 100 });
  services.worker = worker;
  const server = tls ? createHttpsServer(tls) : createHttpServer();
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const url = `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`;
  const app = createApp(store, services, {
    host: '127.0.0.1',
    port,
    accessKey,
    ...(tls ? { publicUrl: url } : {}),
  });
  app.use(express.static(resolve('dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
  server.on('request', app);
  worker.start();
  return {
    store,
    reviews,
    forgetReviews,
    url,
    async close() {
      await worker.stop();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      store.close();
    },
  };
}
