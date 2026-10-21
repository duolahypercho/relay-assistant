// SPDX-License-Identifier: MIT
// Real pinned archive, extractor, runtime and inference; only artifact delivery is controlled.
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import assert from 'node:assert/strict';
import { ollamaRelease } from '../server/local-model-installation.mjs';
import { localModelStartFixture } from './local-model-start-fixture.mjs';
export async function localModelInstallFixture(directory, options = {}) {
  const archive = process.env.RELAY_OLLAMA_TEST_ARCHIVE;
  assert(
    archive || options.live,
    'Provide the actual pinned release archive, or opt into the live download.',
  );
  const delivery = { mode: 'hold', requests: 0 };
  const installationOptions = options.live
    ? {}
    : {
        fetcher: async (url, init) => {
          assert.equal(url, ollamaRelease.url);
          assert.equal(init.redirect, 'manual');
          delivery.requests++;
          if (delivery.mode === 'fail')
            return new Response('Controlled unavailable release', { status: 503 });
          if (delivery.mode === 'hold')
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new Uint8Array(256 * 1024));
                  init.signal.addEventListener(
                    'abort',
                    () => {
                      try {
                        controller.error(init.signal.reason);
                      } catch {}
                    },
                    { once: true },
                  );
                },
              }),
            );
          return new Response(Readable.toWeb(createReadStream(archive)), {
            headers: { 'content-length': String(ollamaRelease.bytes) },
          });
        },
      };
  const fixture = await localModelStartFixture(directory, { ...options, installationOptions });
  return { ...fixture, delivery };
}
