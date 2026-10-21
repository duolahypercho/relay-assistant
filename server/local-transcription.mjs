// SPDX-License-Identifier: MIT
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { recordingFormat } from './transcription.mjs';
const fail = (message, status = 502) => Object.assign(new Error(message), { status });
const maximumSamples = 16000 * 120;

export function localWavPCM(bytes) {
  if (
    bytes.length < 44 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE'
  )
    throw fail('Choose a PCM WAV recording.', 400);
  const end = bytes.readUInt32LE(4) + 8;
  if (end > bytes.length || end < 44) throw fail('This WAV recording is incomplete.', 400);
  let format, data;
  for (let offset = 12; offset + 8 <= end;) {
    const name = bytes.toString('ascii', offset, offset + 4),
      length = bytes.readUInt32LE(offset + 4),
      start = offset + 8;
    if (start + length > end) throw fail('This WAV recording is incomplete.', 400);
    if (name === 'fmt ') {
      if (format || length < 16) throw fail('This WAV format is invalid.', 400);
      format = {
        type: bytes.readUInt16LE(start),
        channels: bytes.readUInt16LE(start + 2),
        rate: bytes.readUInt32LE(start + 4),
        align: bytes.readUInt16LE(start + 12),
        bits: bytes.readUInt16LE(start + 14),
      };
    }
    if (name === 'data') {
      if (data) throw fail('Use one continuous WAV recording.', 400);
      data = bytes.subarray(start, start + length);
    }
    offset = start + length + (length % 2);
  }
  if (
    !format ||
    !data ||
    ![1, 2].includes(format.channels) ||
    format.rate < 8000 ||
    format.rate > 96000 ||
    !(
      (format.type === 1 && [16, 24, 32].includes(format.bits)) ||
      (format.type === 3 && format.bits === 32)
    ) ||
    format.align !== (format.channels * format.bits) / 8 ||
    data.length % format.align
  )
    throw fail('Use a mono or stereo PCM WAV recording.', 400);
  const frames = data.length / format.align,
    count = Math.floor((frames * 16000) / format.rate);
  if (count < 1600 || count > maximumSamples)
    throw fail('Use a recording between a tenth of a second and two minutes.', 400);
  const output = Buffer.alloc(count * 4),
    width = format.bits / 8;
  const sample = (frame, channel) => {
    const at = frame * format.align + channel * width;
    const value =
      format.type === 3 ? data.readFloatLE(at) : data.readIntLE(at, width) / 2 ** (format.bits - 1);
    if (!Number.isFinite(value)) throw fail('This recording contains invalid audio samples.', 400);
    return Math.max(-1, Math.min(1, value));
  };
  for (let i = 0; i < count; i++) {
    const from = Math.floor((i * format.rate) / 16000),
      to = Math.min(frames, Math.max(from + 1, Math.floor(((i + 1) * format.rate) / 16000)));
    let sum = 0;
    for (let j = from; j < to; j++)
      for (let channel = 0; channel < format.channels; channel++) sum += sample(j, channel);
    output.writeFloatLE(sum / ((to - from) * format.channels), i * 4);
  }
  return output;
}

export function listeningProcess(
  executable,
  args,
  { signal, limit, descriptor, env = {} },
  spawnProcess = spawn,
) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0,
      failure,
      finished = false;
    const child = spawnProcess(executable, args, {
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore', ...(descriptor === undefined ? [] : [descriptor])],
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', ...env },
    });
    const stop = (error) => {
      if (finished || failure) return;
      failure = error;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const abort = () => stop(new DOMException('Listening cancelled.', 'AbortError'));
    const clean = () => {
      finished = true;
      signal.removeEventListener('abort', abort);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on('data', (bytes) => {
      size += bytes.length;
      if (size > limit)
        stop(fail('The recording or transcript is too long. Try a shorter recording.', 413));
      else chunks.push(bytes);
    });
    child.on('error', () => {
      clean();
      reject(failure || fail('Local listening could not start. Check the Relay computer.'));
    });
    child.on('close', (code) => {
      clean();
      if (failure) reject(failure);
      else if (code === 3) reject(fail('No speech was recognized. Try recording again.', 422));
      else if (code !== 0)
        reject(fail('Local listening could not read this recording. Try a new recording.'));
      else resolve(Buffer.concat(chunks));
    });
  });
}

export class LocalTranscriptionService {
  constructor(
    installation,
    { runner = listeningProcess, temporaryRoot = tmpdir(), timeout = 60000, ffmpeg } = {},
  ) {
    Object.assign(this, { installation, runner, temporaryRoot, timeout, ffmpeg });
    this.destination = 'your Relay computer';
    this.inputFormat = 'wav';
    this.pending = null;
    this.controller = null;
    this.closed = false;
  }
  get configured() {
    return !this.closed && this.installation.ready();
  }
  async transcribe(bytes, contentType, signal) {
    if (!this.configured) throw fail('Set up local listening in Settings first.', 503);
    const format = recordingFormat(bytes, contentType);
    if (this.pending)
      throw fail('Another recording is being transcribed. Try again when it finishes.', 429);
    this.controller = new AbortController();
    const deadline = AbortSignal.timeout(this.timeout),
      combined = AbortSignal.any([this.controller.signal, deadline, ...(signal ? [signal] : [])]);
    this.pending = this.run(bytes, format, combined);
    try {
      return await this.pending;
    } catch (error) {
      if (signal?.aborted || this.controller.signal.aborted)
        throw fail('Transcription cancelled.', 499);
      if (deadline.aborted)
        throw fail(
          'Local listening took too long. Your recording is still available to retry.',
          504,
        );
      if (error.status) throw error;
      throw fail('Local listening could not finish. Check your Relay computer and try again.');
    } finally {
      this.pending = null;
    }
  }
  async run(bytes, format, signal) {
    signal.throwIfAborted();
    let directory;
    try {
      directory = await mkdtemp(join(this.temporaryRoot, 'relay-local-audio-'));
      let pcm;
      if (format.extension === 'wav') pcm = localWavPCM(bytes);
      else {
        const configured = this.ffmpeg || process.env.RELAY_FFMPEG_PATH;
        const executable = (
          configured
            ? [configured]
            : ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']
        ).find((path) => isAbsolute(path) && existsSync(path));
        if (!executable)
          throw fail(
            'This audio format needs FFmpeg on your Relay computer. Dictation and WAV recordings can still use local listening.',
            503,
          );
        const file = join(directory, 'recording');
        await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
        const handle = await open(file, 'r');
        try {
          const container = { webm: 'matroska', m4a: 'mov', mp3: 'mp3', ogg: 'ogg', flac: 'flac' }[
            format.extension
          ];
          pcm = await this.runner(
            executable,
            [
              '-v',
              'error',
              '-max_alloc',
              '67108864',
              '-nostdin',
              '-threads',
              '1',
              '-protocol_whitelist',
              'fd',
              '-f',
              container,
              ...(container === 'mov' ? ['-enable_drefs', '0'] : []),
              '-fd',
              '3',
              '-i',
              'fd:',
              '-vn',
              '-t',
              '121',
              '-ac',
              '1',
              '-ar',
              '16000',
              '-f',
              'f32le',
              'pipe:1',
            ],
            {
              signal,
              limit: maximumSamples * 4,
              descriptor: handle.fd,
              env: { PATH: dirname(executable) },
            },
          );
        } finally {
          await handle.close();
        }
      }
      signal.throwIfAborted();
      if (pcm.length < 6400 || pcm.length > maximumSamples * 4 || pcm.length % 4)
        throw fail('Use a recording between a tenth of a second and two minutes.', 400);
      const path = join(directory, 'samples.f32');
      await writeFile(path, pcm, { flag: 'wx', mode: 0o600 });
      const files = this.installation.paths();
      const output = await this.runner(files.helper, [files.library, files.model, path], {
        signal,
        limit: 80000,
      });
      signal.throwIfAborted();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(output).trim();
      if (!text || /^\[(BLANK_AUDIO|SILENCE)\]$/i.test(text))
        throw fail('No speech was recognized. Try recording again.', 422);
      if (text.length > 20000)
        throw fail('The transcript is too long. Try a shorter recording.', 413);
      return { text };
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
  async close() {
    this.closed = true;
    this.controller?.abort();
    await this.pending?.catch(() => {});
  }
}
