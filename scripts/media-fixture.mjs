// SPDX-License-Identifier: MIT
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { assistantsFixture } from './assistants-fixture.mjs';
import { audioFixture } from './audio-fixture.mjs';
import { TranscriptionService } from '../server/transcription.mjs';
import { command } from '../shared/domain.mjs';
export async function mediaFixture(directory, options = {}) {
  const audio = audioFixture(12),
    video = await readFile(new URL('../tests/fixtures/media/quiet-motion.mp4', import.meta.url)),
    transcriptions = [];
  const listener = createServer(async (req, res) => {
    const form = await new Request('http://localhost', {
      method: 'POST',
      headers: req.headers,
      body: req,
      duplex: 'half',
    }).formData();
    transcriptions.push(Buffer.from(await form.get('file').arrayBuffer()));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ text: 'A quiet lunch at noon, followed by a walk.' }));
  }).listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const f = await assistantsFixture(directory, {
    ...options,
    configure(store, services) {
      services.transcription = new TranscriptionService({
        baseUrl: `http://127.0.0.1:${listener.address().port}`,
        model: 'independent-listener',
      });
      if (options.seed)
        store.mutate((s) => {
          const a = command(s, 'file.add', {
            name: 'Lunch.wav',
            mime: 'audio/wav',
            base64: audio.toString('base64'),
          });
          const v = command(s, 'file.add', {
            name: 'Garden.mp4',
            mime: 'video/mp4',
            base64: video.toString('base64'),
          });
          s.messages.push({
            id: 'media-fixture-message',
            role: 'user',
            threadId: 'main',
            text: 'Keep these recordings here.',
            fileIds: [a.id, v.id],
            createdAt: new Date().toISOString(),
          });
        });
    },
    respond: async (body) => {
      if (body.messages.at(-1).role === 'tool')
        return {
          role: 'assistant',
          content: 'Your recording says: a quiet lunch at noon, followed by a walk.',
        };
      const file = f.store.read().files.find((x) => x.name === 'Lunch.wav');
      return {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'read-lunch-recording',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ id: file.id }) },
          },
        ],
      };
    },
  });
  return {
    ...f,
    audio,
    video,
    transcriptions,
    async close() {
      await f.close();
      listener.closeAllConnections();
      await new Promise((r) => listener.close(r));
    },
  };
}
