// SPDX-License-Identifier: MIT
// Explicit owner requests only. Ollama owns its cache; Relay never deletes shared weights.
import { randomUUID } from 'node:crypto';
import { ollamaProbe } from './local-model-runtime.mjs';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const key = 'local-model-download';
export const localModelSuggestion = Object.freeze({
  model: 'qwen3.5:4b',
  name: 'Qwen 3.5 · 4B',
  size: 'about 4 GB',
  url: 'https://ollama.com/library/qwen3.5:4b',
});
export function localModelTag(value) {
  // Official Ollama registry names, optionally with one publisher namespace. No URL,
  // registry host, filesystem path, implicit mutable latest tag or hosted cloud model.
  if (
    typeof value !== 'string' ||
    value.length > 160 ||
    !/^(?:[a-z0-9][a-z0-9_-]*\/)?[a-z0-9][a-z0-9_.-]*:[a-z0-9][a-z0-9_.-]*$/.test(value) ||
    value.includes('..') ||
    /(?:^|[-:/])cloud(?:$|[-:])/.test(value)
  )
    throw fail(
      'Enter an Ollama model and tag, such as qwen3.5:4b. Cloud models and registry URLs are not supported.',
    );
  return value;
}
export class LocalModelDownloads {
  constructor(
    store,
    { fetcher = fetch, probe = ollamaProbe, timeout = 2 * 60 * 60 * 1000, stall = 120000 } = {},
  ) {
    Object.assign(this, { store, fetcher, probe, timeout, stall, closed: false, pending: null });
    const saved = store.secret(key);
    this.state = null;
    if (saved) {
      try {
        const data = JSON.parse(saved);
        if (
          !/^[a-f0-9-]{36}$/.test(data.id) ||
          !['running', 'ready', 'error', 'cancelled', 'interrupted'].includes(data.phase)
        )
          throw Error();
        this.state = {
          id: data.id,
          model: localModelTag(data.model),
          phase: data.phase,
          stage: '',
          completed: 0,
          total: 0,
          error: '',
        };
        if (data.phase === 'running' || data.phase === 'interrupted') {
          this.state.phase = 'interrupted';
          this.state.error =
            'Download interrupted. Retry when you’re ready; Ollama may reuse saved parts.';
        } else if (data.phase === 'error')
          this.state.error = 'The download did not finish. Check Ollama and try again.';
        this.persist();
      } catch {
        throw fail('Local download status could not be read.', 503);
      }
    }
  }
  persist() {
    this.store.secret(key, JSON.stringify(this.state));
  }
  status() {
    return { suggestion: localModelSuggestion, download: this.state && { ...this.state } };
  }
  start(input) {
    if (this.closed) throw fail('Relay is stopping. Try again after reconnecting.', 503);
    const model = localModelTag(input?.model);
    const id = input?.id || randomUUID();
    if (
      typeof id !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
    )
      throw fail('Choose a new download request.');
    if (this.state?.id === id) {
      if (this.state.model !== model)
        throw fail('This download request already belongs to another model.', 409);
      return this.status();
    }
    if (this.pending) throw fail('Wait for the current model download, or cancel it first.', 409);
    this.controller = new AbortController();
    this.state = {
      id,
      model,
      phase: 'running',
      stage: 'Preparing download…',
      completed: 0,
      total: 0,
      error: '',
    };
    this.persist();
    this.pending = this.run(model, this.controller.signal).finally(() => {
      this.pending = null;
    });
    return this.status();
  }
  async run(model, ownerSignal) {
    const deadline = AbortSignal.timeout(this.timeout);
    const stalled = new AbortController();
    const signal = AbortSignal.any([ownerSignal, deadline, stalled.signal]);
    let timer, reader;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => stalled.abort(), this.stall);
    };
    try {
      reset();
      if (!(await this.probe(signal)).running) throw Error('Ollama unavailable');
      signal.throwIfAborted();
      const response = await this.fetcher('http://127.0.0.1:11434/api/pull', {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: true, insecure: false }),
      });
      if (!response.ok || !response.body) throw Error('Pull failed');
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '',
        success = false;
      const event = (line) => {
        if (!line.trim()) return;
        const value = JSON.parse(line);
        if (!value || typeof value !== 'object' || value.error || typeof value.status !== 'string')
          throw Error('Invalid event');
        if (value.status === 'success') {
          success = true;
          return;
        }
        this.state.stage =
          value.status.startsWith('pulling ') && value.digest
            ? 'Downloading a model file…'
            : value.status.includes('verif')
              ? 'Checking downloaded files…'
              : value.status.includes('manifest') && !value.status.startsWith('pulling')
                ? 'Finishing download…'
                : 'Preparing download…';
        this.state.total = Number.isSafeInteger(value.total) && value.total > 0 ? value.total : 0;
        this.state.completed =
          this.state.total && Number.isSafeInteger(value.completed) && value.completed >= 0
            ? Math.min(value.completed, this.state.total)
            : 0;
      };
      for (;;) {
        const item = await reader.read();
        signal.throwIfAborted();
        if (item.done) break;
        reset();
        // Progress is consumed and discarded. Bound each line and the request's
        // lifetime, not total progress bytes: large models can legitimately emit
        // tens of MB of small progress events before their files finish.
        buffer += decoder.decode(item.value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          if (newline > 65536) throw Error('Progress line too large');
          event(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
        if (buffer.length > 65536) throw Error('Progress line too large');
      }
      buffer += decoder.decode();
      if (buffer) event(buffer);
      if (!success) throw Error('No completion receipt');
      // A success line alone is insufficient: the requested model must be listed locally.
      const tags = await this.fetcher('http://127.0.0.1:11434/api/tags', {
        method: 'GET',
        redirect: 'error',
        signal,
      });
      if (!tags.ok || !tags.body) throw Error('No model catalog');
      await reader.cancel();
      reader = tags.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const item = await reader.read();
        signal.throwIfAborted();
        if (item.done) break;
        size += item.value.length;
        if (size > 2 * 1024 * 1024) throw Error('Catalog too large');
        chunks.push(item.value);
      }
      const catalog = JSON.parse(Buffer.concat(chunks).toString());
      if (!catalog.models?.some((m) => m.name === model || m.model === model))
        throw Error('Model not installed');
      signal.throwIfAborted();
      this.state = { ...this.state, phase: 'ready', stage: 'Ready to use', completed: 0, total: 0 };
    } catch {
      const phase = ownerSignal.aborted ? (this.closed ? 'interrupted' : 'cancelled') : 'error';
      this.state = {
        ...this.state,
        phase,
        stage: '',
        completed: 0,
        total: 0,
        error:
          phase === 'error'
            ? 'The download did not finish. Check your connection, free disk space and Ollama, then try again.'
            : phase === 'interrupted'
              ? 'Download interrupted. Retry when you’re ready; Ollama may reuse saved parts.'
              : '',
      };
    } finally {
      clearTimeout(timer);
      await reader?.cancel().catch(() => {});
      this.persist();
    }
  }
  async cancel(input) {
    if (!this.state || input?.id !== this.state.id)
      throw fail('This download changed. Check its current status.', 409);
    if (this.pending) {
      this.controller.abort();
      await this.pending;
    }
    return this.status();
  }
  async close() {
    this.closed = true;
    this.controller?.abort();
    await this.pending;
  }
}
