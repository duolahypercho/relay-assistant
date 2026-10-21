// SPDX-License-Identifier: MIT
// Isolated acceptance only. Real recognizer and model; optional verified cached downloads.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LocalListeningInstallation } from '../server/local-listening-installation.mjs';
import { LocalTranscriptionService } from '../server/local-transcription.mjs';
import { voiceConnectionsFixture } from './voice-connections-fixture.mjs';

export async function localListeningFixture(
  directory,
  { live = false, cache = resolve('../../work/local-listening-research'), ...options } = {},
) {
  const f = await voiceConnectionsFixture(directory, options);
  const controls = { hold: false, fail: false, requests: 0 };
  const fetcher = async (url, init) => {
    controls.requests++;
    while (controls.hold) {
      init.signal.throwIfAborted();
      await new Promise((r) => setTimeout(r, 20));
    }
    if (controls.fail) throw Error('Controlled download interruption');
    if (live) return fetch(url, init);
    const name = url.includes('github.com') ? 'whisper.zip' : 'ggml-base.bin';
    const bytes = await readFile(join(cache, name));
    return new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } });
  };
  const installation = new LocalListeningInstallation(f.store, directory, { fetcher });
  const transcription = new LocalTranscriptionService(installation, { temporaryRoot: directory });
  installation.voice = f.voiceConnections;
  f.voiceConnections.localTranscription = transcription;
  f.services.localListeningInstallation = installation;
  const close = f.close;
  return {
    ...f,
    installation,
    transcription,
    listeningControls: controls,
    async close() {
      await installation.close();
      await transcription.close();
      await close();
    },
  };
}
