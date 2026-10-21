// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { uid, iso } from '../shared/seed.mjs';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const metadata = (memo) => ({ kind: 'voice', id: memo.id, transcript: memo.transcript });
export class SpeechService {
  constructor({ baseUrl = '', model = '', apiKey = '', voice = 'coral', timeout = 60000 } = {}) {
    this.configured = !!(baseUrl && model);
    this.model = model;
    this.apiKey = apiKey;
    this.voice = voice;
    this.timeout = timeout;
    this.destination = '';
    this.active = new Set();
    if (!baseUrl) return;
    const url = new URL(baseUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        'Use an HTTPS speech base URL, or loopback HTTP, without credentials or query parameters.',
      );
    this.url = url.href.replace(/\/$/, '') + '/audio/speech';
    this.destination = url.host;
    if (typeof voice !== 'string' || !voice.trim() || voice.length > 120)
      throw new Error('Choose a speech voice identifier.');
  }
  async synthesize(text, signal) {
    const timeout = AbortSignal.timeout(this.timeout);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      combined.throwIfAborted();
      const response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          voice: this.voice,
          input: text,
          response_format: 'wav',
        }),
        signal: combined,
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw fail(
          `The speech service returned HTTP ${response.status}. Try again when it is available.`,
          502,
        );
      }
      const chunks = [];
      let size = 0;
      const reader = response.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 8 * 1024 * 1024) {
          await reader.cancel();
          throw fail('The voice recording exceeded 8 MB. Ask for a shorter reply.', 502);
        }
        chunks.push(value);
      }
      const bytes = Buffer.concat(chunks);
      if (
        bytes.length < 44 ||
        bytes.toString('ascii', 0, 4) !== 'RIFF' ||
        bytes.toString('ascii', 8, 12) !== 'WAVE'
      )
        throw fail('The speech service did not return a WAV recording.', 502);
      combined.throwIfAborted();
      return bytes;
    } catch (error) {
      if (signal?.aborted) throw new DOMException('Voice creation cancelled.', 'AbortError');
      if (timeout.aborted) throw fail('Voice creation timed out. You can try again.', 504);
      if (error.status) throw error;
      throw fail('The speech service could not be reached. You can try again.', 502);
    }
  }
  async createMemo(store, { text, sourceKey, messageId }, signal, guard = () => {}, onAudio) {
    if (typeof text !== 'string' || !text.trim() || text.length > 4096)
      throw fail('A voice memo needs between 1 and 4,096 characters. Ask for a shorter reply.');
    const key = `${sourceKey}:${createHash('sha256').update(text).digest('hex')}`;
    const cached = store.voiceMemoForSource(key);
    if (cached) return metadata(cached);
    if (!this.configured) throw fail('Set up speaking in Settings to hear replies.', 503);
    if (this.active.has(key) || this.active.size >= 2)
      throw fail('Voice creation is already in progress. Try again when it finishes.', 429);
    this.active.add(key);
    try {
      const audio = await this.synthesize(
        text,
        signal,
        onAudio
          ? async (part) => {
              signal?.throwIfAborted();
              guard();
              const message = messageId && store.read().messages.find((m) => m.id === messageId);
              if (
                messageId &&
                (!message ||
                  message.role !== 'assistant' ||
                  message.text !== text ||
                  message.interrupted)
              )
                throw fail('The reply changed while its voice was being created. Try again.', 409);
              await onAudio(part);
            }
          : undefined,
      );
      signal?.throwIfAborted();
      guard();
      return store.mutate((s) => {
        // Recheck the frozen source after network I/O; never attach audio to changed text.
        const message = messageId ? s.messages.find((m) => m.id === messageId) : null;
        if (
          messageId &&
          (!message || message.role !== 'assistant' || message.text !== text || message.interrupted)
        )
          throw fail('The reply changed while its voice was being created. Try again.', 409);
        const existing = store.voiceMemoForSource(key);
        if (existing) return metadata(existing);
        const id = uid('voice');
        store.putVoiceMemo({ id, sourceKey: key, transcript: text, audio, createdAt: iso() });
        const card = metadata({ id, transcript: text });
        if (message) {
          message.cards ||= [];
          message.cards.push(card);
        }
        return card;
      });
    } finally {
      this.active.delete(key);
    }
  }
  async forMessage(store, id, signal, guard = () => {}, onAudio) {
    const message = store.read().messages.find((m) => m.id === id);
    if (!message || message.role !== 'assistant' || message.interrupted)
      throw fail('Choose a completed assistant reply.', 404);
    return this.createMemo(
      store,
      { text: message.text, sourceKey: `message:${id}`, messageId: id },
      signal,
      guard,
      onAudio,
    );
  }
}
