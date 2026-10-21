import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { readVideo, readVideoFrame, readVideoAudio } from '../server/video-reader.mjs';
import { Store } from '../server/store.mjs';
import { command } from '../shared/domain.mjs';
import { executeTool } from '../server/agent.mjs';
const bytes = await readFile(new URL('./fixtures/media/three-colors.mp4', import.meta.url));
const file = { name: 'Color study.mp4', mime: 'video/mp4', base64: bytes.toString('base64') };
const silent = {
  ...file,
  base64: (await readFile(new URL('./fixtures/media/quiet-motion.mp4', import.meta.url))).toString(
    'base64',
  ),
};
async function pixel(url) {
  const image = await loadImage(url);
  const canvas = createCanvas(image.width, image.height),
    ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return [...ctx.getImageData(image.width / 2, image.height / 2, 1, 1).data];
}
function audioData(wav) {
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  for (let offset = 12; offset + 8 < wav.length;) {
    const size = wav.readUInt32LE(offset + 4);
    if (wav.toString('ascii', offset, offset + 4) === 'fmt ') {
      assert.equal(wav.readUInt16LE(offset + 10), 1);
      assert.equal(wav.readUInt32LE(offset + 12), 16000);
    }
    if (wav.toString('ascii', offset, offset + 4) === 'data')
      return wav.subarray(offset + 8, Math.min(wav.length, offset + 8 + size));
    offset += 8 + size + (size % 2);
  }
  throw Error('Missing PCM samples');
}
test('video metadata and timestamped frames decode distinct actual pixels without altering the source', async () => {
  const original = structuredClone(file),
    metadata = await readVideo(file);
  assert.equal(metadata.durationSeconds, 6);
  assert.equal(metadata.hasAudio, true);
  assert.equal(metadata.width, 320);
  assert.match(metadata.contentHash, /^[a-f0-9]{64}$/);
  const colors = [];
  for (const timeSeconds of [0.5, 2.5, 4.5]) {
    const frame = await readVideoFrame(file, { timeSeconds, contentHash: metadata.contentHash });
    colors.push(await pixel(frame.image));
    assert.equal(frame.timeSeconds, timeSeconds);
    assert.match(frame.sourceNotice, /untrusted/);
    assert.match(frame.samplingNotice, /not continuous/);
  }
  assert(colors[0][0] > colors[0][1] * 2);
  assert(colors[1][2] > colors[1][0] * 2);
  assert(colors[2][1] > colors[2][0] * 2);
  assert.deepEqual(file, original);
});
test('frame previews fit the display aspect ratio for portrait, anamorphic and large video', async () => {
  for (const [name, width, height] of [
    ['portrait', 180, 320],
    ['anamorphic', 720, 540],
    ['large-landscape', 1280, 720],
  ]) {
    const bytes = await readFile(new URL(`./fixtures/media/${name}.mp4`, import.meta.url));
    const file = { name: `${name}.mp4`, mime: 'video/mp4', base64: bytes.toString('base64') };
    const { contentHash } = await readVideo(file);
    const frame = await readVideoFrame(file, { timeSeconds: 0, contentHash });
    const image = await loadImage(frame.image);
    assert.equal(image.width, width, name);
    assert.equal(image.height, height, name);
  }
});
test('soundtrack segments use real bounded mono PCM from the selected time', async () => {
  const { contentHash } = await readVideo(file);
  const rates = [];
  for (const startSeconds of [0.3, 3.3]) {
    const result = await readVideoAudio(file, { contentHash, startSeconds, durationSeconds: 1 });
    const samples = audioData(result.bytes);
    assert.equal(samples.length, 32000);
    let crossings = 0;
    for (let n = 2; n < samples.length; n += 2)
      if (samples.readInt16LE(n - 2) <= 0 && samples.readInt16LE(n) > 0) crossings++;
    rates.push(crossings);
    assert.equal(result.startSeconds, startSeconds);
    assert.equal(result.endSeconds, startSeconds + 1);
  }
  assert(Math.abs(rates[0] - 440) < 8, String(rates));
  assert(Math.abs(rates[1] - 880) < 8, String(rates));
  const ending = await readVideoAudio(file, { contentHash, startSeconds: 5, durationSeconds: 120 });
  assert.equal(ending.endSeconds, 6);
});
test('invalid containers, sizes, hashes and timestamps fail without interpreting a playlist', async () => {
  const meta = await readVideo(file);
  for (const bytes of [
    Buffer.from('#EXTM3U\nhttp://127.0.0.1/private\n'),
    Buffer.from('<html>video</html>'),
    Buffer.alloc(8 * 1024 * 1024 + 1),
  ])
    await assert.rejects(
      readVideo({ ...file, base64: bytes.toString('base64') }),
      /supported|8 MB/,
    );
  await assert.rejects(readVideo({ ...file, mime: 'text/html' }), /not found/);
  await assert.rejects(readVideoFrame(file, { timeSeconds: 1 }), /content hash/);
  await assert.rejects(
    readVideoFrame(file, { timeSeconds: 1, contentHash: '0'.repeat(64) }),
    /changed/,
  );
  for (const timeSeconds of [-1, 6, NaN, Infinity, '1'])
    await assert.rejects(
      readVideoFrame(file, { timeSeconds, contentHash: meta.contentHash }),
      /timestamp/,
    );
  for (const durationSeconds of [0, -1, 121, NaN, '1'])
    await assert.rejects(
      readVideoAudio(file, { durationSeconds, contentHash: meta.contentHash }),
      /120 seconds/,
    );
  const sm = await readVideo(silent);
  assert.equal(sm.hasAudio, false);
  await assert.rejects(readVideoAudio(silent, { contentHash: sm.contentHash }), /no audio/);
  await assert.rejects(
    readVideo({ ...file, base64: bytes.subarray(0, 100).toString('base64') }),
    /damaged|duration/,
  );
});
test('video tools recheck source and execution authority before delivering pixels or sending audio', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const f = store.mutate((s) => command(s, 'file.add', file));
    const meta = (await executeTool(store, 'read_file', { id: f.id })).result;
    const before = store.read();
    const frame = await executeTool(store, 'read_video_frame', {
      id: f.id,
      contentHash: meta.contentHash,
      timeSeconds: 0.5,
    });
    assert.equal(frame.card.id, f.id);
    assert.match(frame.imageLabel, /0.5 seconds/);
    assert.deepEqual(store.read(), before);
    await assert.rejects(
      executeTool(store, 'transcribe_video', { id: f.id, contentHash: meta.contentHash }),
      /Set up listening/,
    );
    let guards = 0,
      calls = 0;
    await assert.rejects(
      executeTool(
        store,
        'transcribe_video',
        { id: f.id, contentHash: meta.contentHash },
        {
          guard() {
            if (++guards === 2)
              store.mutate((s) => {
                s.files.find((x) => x.id === f.id).base64 = silent.base64;
              });
          },
          transcription: {
            configured: true,
            async transcribe() {
              calls++;
              return { text: 'late' };
            },
          },
        },
      ),
      /changed/,
    );
    assert.equal(calls, 0);
    store.mutate((s) => {
      s.files.find((x) => x.id === f.id).base64 = file.base64;
    });
    let permitted = true;
    await assert.rejects(
      executeTool(
        store,
        'transcribe_video',
        { id: f.id, contentHash: meta.contentHash },
        {
          guard() {
            if (!permitted) throw Error('Owner took control');
          },
          transcription: {
            configured: true,
            async transcribe(wav, mime) {
              assert.equal(mime, 'audio/wav');
              audioData(wav);
              permitted = false;
              return { text: 'late' };
            },
          },
        },
      ),
      /Owner took control/,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(readVideo(file, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(store.read().messages.length, 0);
  } finally {
    store.close();
  }
});
test('decoder receives only its inherited source descriptor, bounded output, no provider environment and no network/file protocols', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-video-test-'));
  const previous = process.env.RELAY_FFMPEG_PATH;
  const previousKey = process.env.RELAY_MODEL_API_KEY;
  try {
    process.env.RELAY_MODEL_API_KEY = 'fixture-key-must-not-reach-decoder';
    const fake = join(directory, 'decoder');
    await writeFile(
      fake,
      `#!${process.execPath}\nconst args=process.argv.slice(2);\nif(args[args.indexOf('-protocol_whitelist')+1]!=='fd' || args[args.indexOf('-fd')+1]!=='3' || args.includes('file:') || process.env.RELAY_MODEL_API_KEY)process.exit(2);\nprocess.stdout.write(Buffer.alloc(2200000));\n`,
      { mode: 0o700 },
    );
    process.env.RELAY_FFMPEG_PATH = fake;
    const { contentHash } = await readVideo(file);
    await assert.rejects(readVideoFrame(file, { timeSeconds: 1, contentHash }), /size limit/);
    await writeFile(fake, `#!${process.execPath}\nsetInterval(()=>{},1000);\n`);
    const controller = new AbortController();
    const pending = readVideoFrame(file, {
      timeSeconds: 1,
      contentHash,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending, { name: 'AbortError' });
    // Its slot and temporary source are released before another decode is accepted.
    process.env.RELAY_FFMPEG_PATH = '/does-not-exist/ffmpeg';
    await assert.rejects(
      readVideoFrame(file, { timeSeconds: 1, contentHash }),
      /Install a current FFmpeg/,
    );
  } finally {
    if (previous === undefined) delete process.env.RELAY_FFMPEG_PATH;
    else process.env.RELAY_FFMPEG_PATH = previous;
    if (previousKey === undefined) delete process.env.RELAY_MODEL_API_KEY;
    else process.env.RELAY_MODEL_API_KEY = previousKey;
    await rm(directory, { recursive: true, force: true });
  }
});
test('concurrent decodes are bounded and cancelled or timed-out child processes have exited before returning', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-video-process-test-'));
  const previous = process.env.RELAY_FFMPEG_PATH;
  const controllers = [new AbortController(), new AbortController()];
  let pending = [];
  try {
    const fake = join(directory, 'decoder'),
      pids = join(directory, 'pids');
    await writeFile(
      fake,
      `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(pids)},process.pid+'\\n');setInterval(()=>{},1000);\n`,
      { mode: 0o700 },
    );
    const { contentHash } = await readVideo(file);
    process.env.RELAY_FFMPEG_PATH = fake;
    pending = controllers.map((controller) =>
      readVideoFrame(file, { timeSeconds: 1, contentHash, signal: controller.signal }),
    );
    const settled = Promise.allSettled(pending);
    let started = [];
    for (let i = 0; i < 100; i++) {
      started = (await readFile(pids, 'utf8').catch(() => ''))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(Number);
      if (started.length === 2) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(started.length, 2);
    await assert.rejects(readVideoFrame(file, { timeSeconds: 1, contentHash }), /Other videos/);
    controllers.forEach((c) => c.abort());
    assert((await settled).every((r) => r.status === 'rejected' && r.reason.name === 'AbortError'));
    for (const pid of started) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    await assert.rejects(readVideoFrame(file, { timeSeconds: 1, contentHash }), /too long/);
    const all = (await readFile(pids, 'utf8')).trim().split('\n').map(Number);
    assert.equal(all.length, 3);
    for (const pid of all) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    controllers.forEach((c) => c.abort());
    await Promise.allSettled(pending);
    if (previous === undefined) delete process.env.RELAY_FFMPEG_PATH;
    else process.env.RELAY_FFMPEG_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
