// Original six-second clip, actual decoding, independent HTTP model/listening service.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { assistantsFixture } from './assistants-fixture.mjs';
import { TranscriptionService } from '../server/transcription.mjs';
import { command } from '../shared/domain.mjs';
export const videoQuestion = 'What changes in this clip, and what does its soundtrack say?';
export const videoAnswer =
  'The sampled frames are red near 0.5s, blue near 2.5s, and green near 4.5s. The soundtrack transcript says: “Meet by the river at noon.”';
export async function videoReaderFixture(directory, options = {}) {
  const bytes = await readFile(
    new URL('../tests/fixtures/media/three-colors.mp4', import.meta.url),
  );
  const frames = [],
    transcriptions = [],
    errors = [];
  let file;
  const listener = createServer(async (req, res) => {
    try {
      const form = await new Request('http://localhost', {
        method: 'POST',
        headers: req.headers,
        body: req,
        duplex: 'half',
      }).formData();
      const wav = Buffer.from(await form.get('file').arrayBuffer());
      assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
      assert(wav.length >= 6 * 32000 && wav.length < 6 * 32000 + 1024);
      // The extracted soundtrack is not a header-only or silent substitute.
      assert(wav.subarray(1000, 32000).some((b) => b > 10 && b < 240));
      transcriptions.push(wav);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ text: 'Meet by the river at noon.' }));
    } catch (error) {
      errors.push(error.message);
      res.writeHead(500).end('Fixture audio check failed.');
    }
  }).listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const transcriptionBaseUrl = `http://127.0.0.1:${listener.address().port}`;
  const f = await assistantsFixture(directory, {
    ...options,
    configure(store, services) {
      services.transcription = new TranscriptionService({
        baseUrl: transcriptionBaseUrl,
        model: 'independent-listener',
      });
      store.mutate((s) => {
        file = command(s, 'file.add', {
          name: 'Color study.mp4',
          mime: 'video/mp4',
          base64: bytes.toString('base64'),
        });
      });
    },
    async respond(body) {
      try {
        const results = body.messages
          .filter((m) => m.role === 'tool')
          .map((m) => JSON.parse(m.content));
        assert(
          results.every((r) => !r.error),
          JSON.stringify(results),
        );
        const call = (name, args, id) => ({
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        });
        if (!results.length)
          return {
            role: 'assistant',
            content: null,
            tool_calls: [call('read_file', { id: file.id }, 'read-video')],
          };
        if (results.length === 1) {
          const meta = results[0].result;
          assert.equal(meta.durationSeconds, 6);
          assert.equal(meta.hasAudio, true);
          return {
            role: 'assistant',
            content: null,
            tool_calls: [
              ...[0.5, 2.5, 4.5].map((timeSeconds, index) =>
                call(
                  'read_video_frame',
                  { id: file.id, contentHash: meta.contentHash, timeSeconds },
                  `video-frame-${index}`,
                ),
              ),
              call(
                'transcribe_video',
                { id: file.id, contentHash: meta.contentHash, startSeconds: 0, durationSeconds: 6 },
                'video-audio',
              ),
            ],
          };
        }
        const visuals = body.messages.flatMap((m) =>
          Array.isArray(m.content) ? m.content.filter((c) => c.type === 'image_url') : [],
        );
        assert.equal(visuals.length, 3);
        assert.equal(results.length, 5);
        assert.match(results.at(-1).result.transcript, /Meet by the river at noon/);
        const colors = [];
        for (const visual of visuals) {
          const image = await loadImage(visual.image_url.url);
          const canvas = createCanvas(image.width, image.height),
            ctx = canvas.getContext('2d');
          ctx.drawImage(image, 0, 0);
          colors.push([...ctx.getImageData(100, 100, 1, 1).data]);
        }
        assert(colors[0][0] > colors[0][1] * 2);
        assert(colors[1][2] > colors[1][0] * 2);
        assert(colors[2][1] > colors[2][0] * 2);
        frames.push(...colors);
        return { role: 'assistant', content: videoAnswer };
      } catch (error) {
        errors.push(error.message);
        return { role: 'assistant', content: 'Fixture failed.' };
      }
    },
  });
  return {
    ...f,
    bytes,
    file,
    frames,
    transcriptions,
    errors,
    transcriptionBaseUrl,
    async close() {
      await f.close();
      listener.closeAllConnections();
      await new Promise((r) => listener.close(r));
    },
  };
}
