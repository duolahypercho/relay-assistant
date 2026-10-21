// SPDX-License-Identifier: MIT
// A provider failure is distinct from a local error, refusal, malformed response or cancellation.
import { compactToolCatalogRequested } from '../shared/model-catalog.mjs';

export class ModelUnavailableError extends Error {
  constructor(message, reason, status) {
    super(message);
    this.name = 'ModelUnavailableError';
    this.reason = reason;
    // Upstream authentication failures must not become Relay session-expiry responses.
    if (status) this.providerStatus = status;
  }
}
export function providerHttpError(status) {
  const message =
    status === 429
      ? 'The AI service is busy (HTTP 429). Try again in a moment.'
      : status === 408 || status === 504
        ? `The AI service took too long to respond (HTTP ${status}). Try again in a moment.`
        : status >= 500 && status <= 599
          ? `The AI service is temporarily unavailable (HTTP ${status}). Try again in a moment.`
          : `The model provider returned HTTP ${status}. Check the endpoint, model ID and credentials.`;
  const reason =
    status === 429
      ? 'busy'
      : status === 401 || status === 402
        ? 'account'
        : status === 408
          ? 'timeout'
          : status >= 500 && status <= 599
            ? 'unavailable'
            : null;
  return reason ? new ModelUnavailableError(message, reason, status) : new Error(message);
}
export function providerStreamError(error) {
  const code = error?.type || error?.code || error?.status;
  const reason = ['rate_limit_error', 'rate_limit_exceeded', 'RESOURCE_EXHAUSTED'].includes(code)
    ? 'busy'
    : ['overloaded_error', 'server_error', 'internal_error', 'UNAVAILABLE', 'INTERNAL'].includes(
          code,
        )
      ? 'unavailable'
      : ['authentication_error', 'invalid_api_key', 'insufficient_quota'].includes(code)
        ? 'account'
        : null;
  const message = 'The model provider could not complete the response.';
  return reason ? new ModelUnavailableError(message, reason) : new Error(message);
}
const origin = (record) => `${record.id}:${record.revision}`;

/** Preserve ordinary conversation/tool results, but never replay another connection's opaque state. */
export function messagesForConnection(messages, record, primary) {
  return messages.map(({ modelOrigin, providerOutput, responseOutput, ...message }) => ({
    ...message,
    ...(modelOrigin === origin(record) || (!modelOrigin && primary)
      ? { providerOutput, responseOutput }
      : {}),
  }));
}

export class ModelFailover {
  constructor(
    records,
    { selected, switchTo = () => {}, guard = () => {}, beforeAttempt, provider },
  ) {
    this.records = records;
    this.index = selected ? records.findIndex((record) => record.id === selected) : 0;
    if (this.index < 0)
      throw new Error('The model choice for this request is no longer available.');
    this.switchTo = switchTo;
    this.guard = guard;
    this.provider = provider;
    this.beforeAttempt = beforeAttempt;
  }
  // Keep the request's discovery mode stable when a backup model takes over.
  get compactTools() {
    return compactToolCatalogRequested(this.records[0]);
  }
  get configured() {
    return !!this.records.length;
  }
  get model() {
    return this.records[this.index]?.model || '';
  }
  get protocol() {
    return this.records[this.index]?.protocol || '';
  }
  async complete(messages, tools = [], options = {}) {
    // All candidates share a bounded deadline; stopping the original request stops every backup.
    const budget = AbortSignal.timeout(180000);
    const signal = options.signal ? AbortSignal.any([options.signal, budget]) : budget;
    while (this.index < this.records.length) {
      signal.throwIfAborted();
      await this.beforeAttempt?.(signal);
      await options.beforeAttempt?.(signal);
      signal.throwIfAborted();
      this.guard();
      const record = this.records[this.index];
      let visible = false;
      try {
        const result = await this.provider(record).complete(
          messagesForConnection(messages, record, this.index === 0),
          tools,
          {
            ...options,
            getMessages: () => messagesForConnection(messages, record, this.index === 0),
            beforeAttempt: async (attemptSignal) => {
              await this.beforeAttempt?.(attemptSignal);
              const changed = await options.beforeAttempt?.(attemptSignal);
              attemptSignal?.throwIfAborted();
              this.guard();
              return changed;
            },
            signal,
            onText: (text) => {
              if (text) visible = true;
              options.onText?.(text);
            },
          },
        );
        signal.throwIfAborted();
        this.guard();
        return { ...result, modelOrigin: origin(record) };
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        // Never replace text already shown, or reinterpret local/policy errors as provider outages.
        const reason =
          error instanceof ModelUnavailableError
            ? error.reason
            : error?.name === 'TimeoutError'
              ? 'timeout'
              : null;
        if (!reason || visible || this.index + 1 >= this.records.length) throw error;
        this.guard();
        const next = this.records[this.index + 1];
        this.switchTo(record, next, reason);
        this.index++;
      }
    }
  }
}
