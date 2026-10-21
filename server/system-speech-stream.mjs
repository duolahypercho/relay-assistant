// SPDX-License-Identifier: MIT
// The Mac adapter explicitly requests mono PCM16 WAV. Its data-size field is
// finalized only when say exits, so preview reads are bounded by the live file.
import { open } from 'node:fs/promises';

export function systemPcmLayout(bytes, final = false) {
  if (bytes.length < 12) return null;
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE')
    throw Error('The Mac voice did not create a WAV recording.');
  let format = false;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (kind === 'fmt ') {
      if (offset + 24 > bytes.length) return null;
      if (
        size < 16 ||
        bytes.readUInt16LE(offset + 8) !== 1 ||
        bytes.readUInt16LE(offset + 10) !== 1 ||
        bytes.readUInt32LE(offset + 12) !== 22050 ||
        bytes.readUInt16LE(offset + 20) !== 2 ||
        bytes.readUInt16LE(offset + 22) !== 16
      )
        throw Error('The Mac voice returned an unsupported audio format.');
      format = true;
    }
    if (kind === 'data') {
      if (!format) throw Error('The Mac voice is missing its audio format.');
      if (final && (size % 2 || offset + 8 + size > bytes.length))
        throw Error('The Mac voice returned an incomplete recording.');
      return { offset: offset + 8, size };
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

export function previewSystemSpeech(file, onAudio, signal) {
  let sent = 0,
    stopped = false,
    failure,
    timer,
    pending = Promise.resolve();
  const emit = async (bytes) => {
    signal?.throwIfAborted();
    await onAudio({ encoding: 'pcm16', sampleRate: 22050, channels: 1, audio: bytes });
    sent += bytes.length;
  };
  const poll = async () => {
    let handle;
    try {
      signal?.throwIfAborted();
      handle = await open(file, 'r');
      const { size } = await handle.stat();
      if (size > 8 * 1024 * 1024) throw Error('The voice recording exceeded 8 MB.');
      const header = Buffer.alloc(Math.min(size, 65536));
      await handle.read(header, 0, header.length, 0);
      const layout = systemPcmLayout(header);
      if (!layout) return;
      let available = Math.min(size - layout.offset, layout.size || Infinity) - sent;
      // Buffer about 200 ms before the first playback to absorb small transport gaps.
      while (available >= 8820) {
        const bytes = Buffer.alloc(Math.min(65536, available - (available % 2)));
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, layout.offset + sent);
        if (bytesRead !== bytes.length) throw Error('The Mac voice recording changed.');
        await emit(bytes);
        available -= bytes.length;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') failure = error;
    } finally {
      await handle?.close();
    }
  };
  const tick = () => {
    pending = poll().finally(() => {
      if (!stopped && !failure) timer = setTimeout(tick, 40);
    });
  };
  timer = setTimeout(tick, 40);
  const stop = async () => {
    stopped = true;
    clearTimeout(timer);
    await pending;
  };
  return {
    stop,
    async finish(audio) {
      await stop();
      if (failure) throw failure;
      const layout = systemPcmLayout(audio, true);
      if (!layout || !layout.size || sent > layout.size)
        throw Error('The Mac voice returned an incomplete recording.');
      for (; sent < layout.size;) {
        const end = Math.min(layout.size, sent + 65536);
        await emit(audio.subarray(layout.offset + sent, layout.offset + end));
      }
    },
  };
}
