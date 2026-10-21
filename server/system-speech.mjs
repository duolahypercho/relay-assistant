// SPDX-License-Identifier: MIT
// Original adapter for the installed macOS speech tool. No voice assets are bundled.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SpeechService } from './speech.mjs';
import { previewSystemSpeech } from './system-speech-stream.mjs';
const maximumBytes = 8 * 1024 * 1024;
const fail = (message, status = 502) => Object.assign(new Error(message), { status });

export function systemSpeechProcess({ file, text, signal, timeout }, spawnSpeech = spawn) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let failure,
      finished = false;
    const child = spawnSpeech(
      '/usr/bin/say',
      ['--file-format=WAVE', '--data-format=LEI16@22050', '-o', file, '-f', '-'],
      {
        shell: false,
        detached: true,
        stdio: ['pipe', 'ignore', 'ignore'],
        env: {
          HOME: process.env.HOME,
          PATH: '/usr/bin:/bin',
          LANG: process.env.LANG,
          TMPDIR: process.env.TMPDIR,
        },
      },
    );
    const stop = (error) => {
      if (finished || failure) return;
      failure = error;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const cancel = () => stop(new DOMException('Voice creation cancelled.', 'AbortError'));
    const timer = setTimeout(
      () => stop(fail('The Mac voice took too long. Try again, or choose a speech service.', 504)),
      timeout,
    );
    const sizeCheck = setInterval(() => {
      void stat(file)
        .then((info) => {
          if (info.size > maximumBytes)
            stop(fail('The voice recording exceeded 8 MB. Ask for a shorter reply.'));
        })
        .catch(() => {});
    }, 100);
    function cleanup() {
      finished = true;
      clearTimeout(timer);
      clearInterval(sizeCheck);
      signal?.removeEventListener('abort', cancel);
    }
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.on('error', () => {
      cleanup();
      reject(
        failure ||
          fail(
            'The Mac voice could not start. Choose a speech service or check the Mac’s speech settings.',
          ),
      );
    });
    child.on('close', (code) => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          fail('The Mac voice could not finish. Try another system voice or a speech service.'),
        );
      else resolve();
    });
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') stop(fail('The Mac voice could not read this reply.'));
    });
    // Text only crosses stdin. Neutralize macOS embedded speech commands such as long pauses.
    child.stdin.end(text.replace(/\[\[|\]\]/g, ' '));
  });
}

export class SystemSpeechService extends SpeechService {
  constructor({
    platform = process.platform,
    exists = existsSync,
    runner = systemSpeechProcess,
    temporaryRoot = tmpdir(),
    timeout = 60000,
  } = {}) {
    super();
    this.configured = platform === 'darwin' && exists('/usr/bin/say');
    this.destination = 'your Relay Mac';
    this.model = 'Mac system voice';
    this.runner = runner;
    this.temporaryRoot = temporaryRoot;
    this.timeout = timeout;
    this.running = 0;
  }
  async synthesize(text, signal, onAudio) {
    if (!this.configured)
      throw fail(
        'The Mac voice is unavailable on this Relay server. Choose a speech service.',
        503,
      );
    if (typeof text !== 'string' || !text.trim() || text.length > 4096 || text.includes('\0'))
      throw fail('Use between 1 and 4,096 characters of text for the Mac voice.', 400);
    signal?.throwIfAborted();
    if (this.running >= 2) throw fail('The Mac voice is busy. Try again when it finishes.', 429);
    this.running++;
    let directory, preview;
    try {
      directory = await mkdtemp(join(this.temporaryRoot, 'relay-system-voice-'));
      const file = join(directory, 'reply.wav');
      if (onAudio) preview = previewSystemSpeech(file, onAudio, signal);
      await this.runner({ file, text, signal, timeout: this.timeout });
      signal?.throwIfAborted();
      const info = await stat(file);
      if (!info.isFile() || info.size > maximumBytes || info.size < 44)
        throw fail('The Mac voice did not create a usable recording. Try again.');
      const audio = await readFile(file);
      if (audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE')
        throw fail('The Mac voice did not create a WAV recording.');
      signal?.throwIfAborted();
      await preview?.finish(audio);
      return audio;
    } catch (error) {
      signal?.throwIfAborted();
      if (error.name === 'AbortError' || error.status) throw error;
      throw fail(
        'The Mac voice could not create a recording. Try again, or choose a speech service.',
      );
    } finally {
      await preview?.stop();
      this.running--;
      if (directory)
        await rm(directory, { recursive: true, force: true }).catch(() => {
          throw fail(
            'The Mac voice could not remove its temporary recording. Check the Mac’s temporary storage.',
          );
        });
    }
  }
}
