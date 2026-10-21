// SPDX-License-Identifier: MIT
const MAX_AUDIO = 8 * 1024 * 1024;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export function recordingFormat(bytes, contentType) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.length > MAX_AUDIO)
    throw fail('Use a recording between 12 bytes and 8 MB.');
  const mime = String(contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const matches = {
    'audio/mpeg': [
      bytes.toString('ascii', 0, 3) === 'ID3' ||
        (bytes[0] === 0xff &&
          (bytes[1] & 0xe0) === 0xe0 &&
          (bytes[1] & 0x06) !== 0 &&
          (bytes[2] & 0xf0) !== 0xf0 &&
          (bytes[2] & 0x0c) !== 0x0c),
      'mp3',
    ],
    'audio/flac': [bytes.toString('ascii', 0, 4) === 'fLaC', 'flac'],
    'audio/webm': [bytes.subarray(0, 4).toString('hex') === '1a45dfa3', 'webm'],
    'audio/mp4': [bytes.toString('ascii', 4, 8) === 'ftyp', 'm4a'],
    'audio/ogg': [bytes.toString('ascii', 0, 4) === 'OggS', 'ogg'],
    'audio/wav': [
      bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE',
      'wav',
    ],
  };
  if (!matches[mime]?.[0]) throw fail('This recording is not a supported audio file.');
  return { mime, extension: matches[mime][1] };
}

export class TranscriptionService {
  constructor({ baseUrl = '', model = '', apiKey = '', timeout = 60000 } = {}) {
    this.configured = Boolean(baseUrl && model);
    this.model = model;
    this.apiKey = apiKey;
    this.timeout = timeout;
    this.busy = false;
    this.destination = '';
    if (!baseUrl) return;
    const url = new URL(baseUrl);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        'Use an HTTPS transcription base URL, or loopback HTTP for local development, without credentials or query parameters.',
      );
    this.url = `${url.href.replace(/\/$/, '')}/audio/transcriptions`;
    this.destination = url.host;
  }
  async transcribe(bytes, contentType, signal) {
    if (!this.configured) throw fail('Set up listening in Settings to use voice input.', 503);
    const format = recordingFormat(bytes, contentType);
    if (this.busy)
      throw fail('Another recording is being transcribed. Try again when it finishes.', 429);
    this.busy = true;
    const timeout = AbortSignal.timeout(this.timeout);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      combined.throwIfAborted();
      const form = new FormData();
      form.set('model', this.model);
      form.set('response_format', 'json');
      form.set('file', new Blob([bytes], { type: format.mime }), `recording.${format.extension}`);
      const response = await fetch(this.url, {
        method: 'POST',
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
        body: form,
        signal: combined,
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw fail(
          `The transcription service returned HTTP ${response.status}. Your recording is still available to retry.`,
          502,
        );
      }
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 256 * 1024) {
          await reader.cancel();
          throw fail('The transcription response was too large.', 502);
        }
        chunks.push(value);
      }
      let result;
      try {
        result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw fail('The transcription service returned an unreadable response.', 502);
      }
      if (typeof result.text !== 'string' || result.text.length > 20000)
        throw fail('The transcription service returned an invalid transcript.', 502);
      const text = result.text.trim();
      if (!text) throw fail('No speech was recognized. Try recording again.', 422);
      return { text };
    } catch (error) {
      if (signal?.aborted) throw fail('Transcription cancelled.', 499);
      if (timeout.aborted)
        throw fail('Transcription timed out. Your recording is still available to retry.', 504);
      if (error.status) throw error;
      throw fail(
        'The transcription service could not be reached. Your recording is still available to retry.',
        502,
      );
    } finally {
      this.busy = false;
    }
  }
}
