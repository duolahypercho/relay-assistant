// SPDX-License-Identifier: MIT
// Actual local recognition, audio decoding, no-speech and process cleanup.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { localListeningFixture } from './local-listening-fixture.mjs';
import { speechWav } from '../shared/voice-activity.mjs';
const exec = promisify(execFile),
  directory = await mkdtemp(join(tmpdir(), 'relay-listening-runtime-'));
const f = await localListeningFixture(directory);
const source = resolve('../../work/local-listening-research/probe.wav'),
  checks = [];
try {
  f.installation.start({ id: randomUUID(), revision: 0 });
  await f.installation.pending;
  assert.equal(f.installation.state.phase, 'ready');
  for (const [extension, mime, codec] of [
    ['wav', 'audio/wav', null],
    ['m4a', 'audio/mp4', 'aac'],
    ['webm', 'audio/webm', 'libopus'],
    ['mp3', 'audio/mpeg', 'libmp3lame'],
    ['flac', 'audio/flac', 'flac'],
    ['ogg', 'audio/ogg', 'libopus'],
  ]) {
    const path = codec ? join(directory, 'speech.' + extension) : source;
    if (codec)
      await exec('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-i', source, '-c:a', codec, path]);
    const bytes = await readFile(path),
      started = Date.now();
    const result = await f.transcription.transcribe(bytes, mime);
    assert.match(result.text, /water the plants tomorrow morning/i);
    checks.push({
      extension,
      bytes: bytes.length,
      text: result.text,
      durationMs: Date.now() - started,
    });
    assert.equal(
      (await readdir(directory)).filter((p) => p.startsWith('relay-local-audio-')).length,
      0,
    );
  }
  const silence = Buffer.from(speechWav([new Float32Array(16000)], 16000));
  await assert.rejects(f.transcription.transcribe(silence, 'audio/wav'), (e) => e.status === 422);
  const controller = new AbortController();
  const pending = f.transcription.transcribe(
    await readFile(source),
    'audio/wav',
    controller.signal,
  );
  const rejection = assert.rejects(pending, (e) => e.status === 499);
  const timer = setTimeout(() => controller.abort(), 50);
  await rejection;
  clearTimeout(timer);
  assert.equal(
    (await readdir(directory)).filter((p) => p.startsWith('relay-local-audio-')).length,
    0,
  );
  const recovered = await f.transcription.transcribe(await readFile(source), 'audio/wav');
  assert.match(recovered.text, /water the plants tomorrow morning/i);
  assert.equal(f.store.read().messages.length, 0);
  await writeFile(
    resolve('../relay-evidence/local-listening-runtime-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        checks,
        silenceRejected: true,
        cancellationRecovered: true,
        privateAudioCleaned: true,
        limits:
          'Original synthetic sentence and actual local inference. Compressed-file decoding uses separately installed FFmpeg. Not a language/noise quality benchmark.',
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS: real WAV, M4A, WebM, MP3, FLAC, Ogg recognition; silence, cancellation and cleanup',
  );
} finally {
  await f.close();
  await rm(directory, { recursive: true, force: true });
}
