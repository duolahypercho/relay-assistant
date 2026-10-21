// SPDX-License-Identifier: MIT
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ModelProvider } from './model.mjs';
import { ModelFailover } from './model-failover.mjs';
import { ModelUsage } from './model-usage.mjs';
import { modelJSON } from './model-stream.mjs';
import { ModelOAuth } from './model-oauth.mjs';
import { encrypt, decrypt } from './google.mjs';
import { modelPresets, modelProtocols, localOllamaConnection } from '../shared/model-catalog.mjs';
import { ModelCapabilities, abilitySettings } from './model-capabilities.mjs';

export function modelVaultKey(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'model-vault.key');
  try {
    writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  chmodSync(path, 0o600);
  const key = readFileSync(path);
  if (key.length !== 32)
    throw new Error('The model vault key is invalid. Restore it from your backup.');
  return key;
}
const clean = (value, label, limit, optional = false) => {
  if (
    typeof value !== 'string' ||
    value.length > limit ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    (!optional && !value.trim())
  )
    throw new Error(`Enter a valid ${label}.`);
  return value.trim();
};
export function modelEndpoint(value) {
  const raw = clean(value, 'endpoint', 2000);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Enter a complete endpoint URL.');
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error('Keep credentials, query parameters, and fragments out of the endpoint URL.');
  const host = url.hostname;
  const local = host === 'localhost' || host === '[::1]' || /^127\./.test(host);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    throw new Error('Use HTTPS, or HTTP on the Relay server’s localhost for a local model.');
  return url.href.replace(/\/+$/, '');
}

export class ModelConnections {
  constructor(store, { key, environment = {}, fetcher = fetch }) {
    this.store = store;
    this.key = key;
    this.fetcher = fetcher;
    this.environment = environment;
    this.capabilities = new ModelCapabilities(fetcher);
    // Fail closed if an existing vault cannot be unlocked. Never silently erase saved keys.
    this.read();
    this.usage = new ModelUsage(store);
    this.oauth = new ModelOAuth(this);
  }
  read() {
    const raw = this.store.secret('model-connections');
    if (!raw)
      return {
        active: this.environment.baseUrl && this.environment.model ? 'environment' : null,
        connections: [],
      };
    try {
      return decrypt(raw, this.key);
    } catch {
      throw new Error(
        'Saved model connections could not be unlocked. Restore the model vault key.',
      );
    }
  }
  write(data) {
    this.store.secret('model-connections', encrypt(data, this.key));
    this.store.emit('change', this.store.read());
  }
  record(id) {
    if (id === 'environment' && this.environment.baseUrl && this.environment.model)
      return {
        ...this.environment,
        id,
        name: 'Server environment',
        preset: 'custom',
        revision: createHash('sha256').update(JSON.stringify(this.environment)).digest('hex'),
      };
    return this.read().connections.find((c) => c.id === id);
  }
  get current() {
    return this.record(this.read().active);
  }
  get configured() {
    return !!this.current;
  }
  get model() {
    return this.current?.model || '';
  }
  get protocol() {
    return this.current?.protocol || '';
  }
  publicState() {
    const state = this.read();
    const records = [...state.connections];
    const env = this.record('environment');
    if (env) records.unshift(env);
    return {
      active: state.active,
      fallbacks: state.fallbacks || {},
      connections: records.map(({ apiKey, ...record }) => ({
        ...record,
        hasKey: !!apiKey,
        readOnly: record.id === 'environment',
      })),
    };
  }
  busy(id) {
    const s = this.store.read();
    const includes = (binding) =>
      binding?.id === id || binding?.fallbacks?.some((entry) => entry.id === id);
    return (
      s.runs.some(
        (r) => includes(r.modelConnection) && ['queued', 'running', 'waiting'].includes(r.status),
      ) ||
      (s.handoffs || []).some(
        (h) =>
          includes(h.modelConnection) && !['completed', 'failed', 'cancelled'].includes(h.status),
      )
    );
  }
  candidate(input) {
    const prior = input.id ? this.record(input.id) : null;
    if (input.id && (!prior || input.id === 'environment'))
      throw new Error('That connection cannot be edited.');
    if (input.id && this.busy(input.id))
      throw new Error(
        'This connection is answering a request. Wait for it to finish before editing.',
      );
    const preset = modelPresets.find((p) => p.id === input.preset);
    if (!preset) throw new Error('Choose a provider.');
    const baseUrl = modelEndpoint(input.baseUrl || preset.baseUrl);
    const protocol = input.protocol || preset.protocol;
    if (input.reportUsage !== undefined && typeof input.reportUsage !== 'boolean')
      throw new Error('Usage reporting must be on or off.');
    if (!modelProtocols.some((p) => p.id === protocol))
      throw new Error('Choose a supported API format.');
    // A saved secret is scoped to its original destination and API format.
    const changedDestination =
      prior &&
      (prior.baseUrl !== baseUrl || prior.protocol !== protocol || prior.preset !== preset.id);
    const local = localOllamaConnection({ baseUrl, protocol });
    const replyMode =
      input.replyMode ??
      (!changedDestination && prior?.model === input.model
        ? prior?.replyMode || 'default'
        : local
          ? 'quick'
          : 'default');
    if (!['quick', 'default'].includes(replyMode) || (!local && replyMode !== 'default'))
      throw Error('Quick replies are available for local Ollama chat connections.');
    const signedIn = input.oauthId ? this.oauth.credentials(input) : null;
    const apiKey = signedIn
      ? signedIn.apiKey
      : input.apiKey === undefined
        ? changedDestination
          ? ''
          : prior?.apiKey || ''
        : clean(input.apiKey, 'API key', 8192, true);
    if (!preset.local && !apiKey) throw new Error('Enter an API key for this provider.');
    return {
      id: prior?.id || signedIn?.id || randomUUID(),
      revision: (prior?.revision || 0) + 1,
      name: clean(input.name || preset.name, 'connection name', 80),
      preset: preset.id,
      baseUrl,
      protocol,
      reportUsage: input.reportUsage ?? prior?.reportUsage ?? true,
      apiKey,
      model: clean(input.model, 'model ID', 200),
      ...(local ? { replyMode } : {}),
      abilities: abilitySettings(
        input.abilities,
        !changedDestination && prior?.model === input.model ? prior?.abilities : undefined,
      ),
    };
  }
  save(input) {
    const flow = input.oauthId ? this.oauth.ready(input) : null;
    if (flow?.phase === 'saved') {
      if (!this.record(flow.connectionId))
        throw Error('This saved connection was removed. Sign in again.');
      return { id: flow.connectionId, ...this.publicState() };
    }
    const connection = this.candidate(input);
    const data = this.read();
    if (!input.id && data.connections.length >= 30)
      throw new Error('You can save up to 30 model connections.');
    data.connections = [...data.connections.filter((c) => c.id !== connection.id), connection];
    if (!data.active || input.activate === true) data.active = connection.id;
    if (flow) this.oauth.commit(flow, data);
    else this.write(data);
    return { id: connection.id, ...this.publicState() };
  }
  select(id) {
    if (id !== null && !this.record(id)) throw new Error('Choose a saved connection.');
    const data = this.read();
    data.active = id;
    this.write(data);
    return this.publicState();
  }
  remove(id) {
    if (!this.record(id) || id === 'environment')
      throw new Error('That connection cannot be removed.');
    if (this.busy(id))
      throw new Error(
        'This connection is answering a request. Wait for it to finish before removing it.',
      );
    const data = this.read();
    data.connections = data.connections.filter((c) => c.id !== id);
    if (data.active === id) data.active = null;
    if (data.fallbacks) {
      delete data.fallbacks[id];
      for (const primary of Object.keys(data.fallbacks))
        data.fallbacks[primary] = data.fallbacks[primary].filter((entry) => entry !== id);
    }
    this.write(data);
    return this.publicState();
  }
  provider(record, purpose = 'assistant') {
    return new ModelProvider({
      ...record,
      fetcher: this.fetcher,
      observe: () => this.usage.begin(record, purpose),
      getCapabilities: (signal) => this.capabilities.resolve(record, signal),
    });
  }
  async inspectAbilities(input, signal) {
    const record =
      input.id && Object.keys(input).length === 1 ? this.record(input.id) : this.candidate(input);
    if (!record) throw Error('Choose a saved model or enter its connection details.');
    return this.capabilities.resolve(record, signal);
  }
  setFallbacks(id, ids) {
    if (!this.record(id)) throw new Error('Choose a saved primary model.');
    if (
      !Array.isArray(ids) ||
      ids.length > 3 ||
      new Set(ids).size !== ids.length ||
      ids.some((entry) => typeof entry !== 'string' || entry === id || !this.record(entry))
    )
      throw new Error('Choose up to three different saved backup models.');
    const data = this.read();
    data.fallbacks ||= {};
    data.fallbacks[id] = [...ids];
    this.write(data);
    return this.publicState();
  }
  binding() {
    const current = this.current;
    if (!current) return { id: null };
    return {
      id: current.id,
      revision: current.revision,
      fallbacks: (this.read().fallbacks?.[current.id] || []).map((id) => {
        const record = this.record(id);
        if (!record)
          throw new Error('A backup model is no longer available. Update your AI models.');
        return { id, revision: record.revision };
      }),
    };
  }
  records(binding) {
    return [binding, ...(binding.fallbacks || [])].map((entry) => {
      const record = this.record(entry.id);
      if (!record || record.revision !== entry.revision)
        throw new Error(
          'The model connection for this request changed. Retry the request with your selected model.',
        );
      return record;
    });
  }
  forRun(run, { beforeAttempt } = {}) {
    let binding = run.modelConnection;
    if (!binding) {
      binding = this.binding();
      this.store.mutate((s) => {
        const item = s.runs.find((r) => r.id === run.id);
        if (item) item.modelConnection ||= binding;
        binding = item?.modelConnection || binding;
      });
    }
    if (!binding.id) return { configured: false };
    const records = this.records(binding);
    const guard = () => {
      const item = this.store.read().runs.find((r) => r.id === run.id);
      if (
        !item ||
        !['queued', 'running', 'waiting'].includes(item.status) ||
        (run.leaseOwner && item.leaseOwner !== run.leaseOwner)
      )
        throw new DOMException('This request has stopped or changed workers.', 'AbortError');
    };
    return new ModelFailover(records, {
      selected: binding.selected,
      beforeAttempt,
      provider: (record) => this.provider(record),
      guard,
      switchTo: (from, to, reason) => {
        guard();
        this.store.mutate((s) => {
          const item = s.runs.find((r) => r.id === run.id);
          item.modelConnection.selected = to.id;
          item.modelConnection.display = {
            name: to.name,
            model: to.model,
            primary: records[0].name,
            reason,
          };
          item.modelConnection.failovers ||= [];
          item.modelConnection.failovers.push({
            from: from.id,
            to: to.id,
            reason,
            at: new Date().toISOString(),
          });
        });
      },
    });
  }
  complete(...args) {
    const binding = this.binding();
    if (!binding.id) throw new Error('Connect a model in Settings first.');
    return new ModelFailover(this.records(binding), {
      provider: (record) => this.provider(record),
    }).complete(...args);
  }
  async discoverLocal(signal) {
    // Explicit owner discovery only. Never scan a network, reuse credentials,
    // follow redirects, start a service, or select a model as a side effect.
    const services = await Promise.all(
      modelPresets
        .filter((p) => ['ollama', 'lmstudio'].includes(p.id))
        .map(async (preset) => {
          const service = {
            preset: preset.id,
            name: preset.name.replace(' · local', ''),
            baseUrl: preset.baseUrl,
          };
          try {
            const result = await this.discover(
              { ...preset, id: undefined, preset: preset.id, apiKey: '' },
              AbortSignal.any([AbortSignal.timeout(3000), ...(signal ? [signal] : [])]),
            );
            const seen = new Set();
            const models = result.models.filter(({ id }) => {
              if (!id.trim() || /[\u0000-\u001f\u007f]/.test(id) || seen.has(id)) return false;
              seen.add(id);
              return true;
            });
            return { ...service, ...result, models, status: models.length ? 'ready' : 'empty' };
          } catch {
            return { ...service, models: [], status: 'unavailable', more: false };
          }
        }),
    );
    signal?.throwIfAborted();
    return { services };
  }
  async discover(input, signal) {
    // Model is not needed to list the provider’s catalog.
    const record = this.candidate({ ...input, model: input.model || 'catalog' });
    const provider = this.provider(record);
    const res = await provider.request(
      'models',
      { method: 'GET' },
      signal || AbortSignal.timeout(20000),
    );
    const data = await modelJSON(res, 16_000_000);
    const models =
      record.protocol === 'gemini'
        ? (data.models || [])
            .filter(
              (m) =>
                !m.supportedGenerationMethods ||
                m.supportedGenerationMethods.includes('generateContent'),
            )
            .map((m) => ({ id: m.name?.replace(/^models\//, ''), name: m.displayName }))
        : (data.data || []).map((m) => ({ id: m.id, name: m.display_name || m.name }));
    return {
      models: models
        .filter((m) => typeof m.id === 'string' && m.id.length <= 200)
        .slice(0, 2000)
        .map((m) => ({ id: m.id, name: String(m.name || m.id).slice(0, 200) })),
      more: !!(data.has_more || data.nextPageToken),
    };
  }
  async test(input, signal) {
    const record = this.candidate(input);
    const result = await this.provider(record, 'connection-test').complete(
      [{ role: 'user', content: 'Reply with the word Connected.' }],
      [],
      { signal, maxOutputTokens: 2048 },
    );
    if (!result.text.trim()) throw new Error('The model returned no text. Choose a chat model.');
    return {
      ok: true,
      message:
        'The model replied. This checks text generation; tool and image support depend on your model.',
    };
  }
}
