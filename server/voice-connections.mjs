// SPDX-License-Identifier: MIT
import { encrypt, decrypt } from './google.mjs';
import { TranscriptionService } from './transcription.mjs';
import { SpeechService } from './speech.mjs';
import { SystemSpeechService } from './system-speech.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const kinds = ['transcription', 'speech'];
const serviceClass = (kind) => (kind === 'speech' ? SpeechService : TranscriptionService);
function clean(value, label, limit, optional = false) {
  if (
    typeof value !== 'string' ||
    value.length > limit ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    (!optional && !value.trim())
  )
    throw fail(`Enter a valid ${label}.`);
  return value.trim();
}
// A single saved connection per audio capability keeps setup small. The facade
// pins each operation to its service and prevents edits during active audio work.
export class VoiceConnections {
  constructor(
    store,
    { key, environment = {}, systemSpeech = new SystemSpeechService(), localTranscription = null },
  ) {
    this.store = store;
    this.key = key;
    this.environment = environment;
    this.systemSpeech = systemSpeech;
    this.localTranscription = localTranscription;
    this.pending = { transcription: 0, speech: 0 };
    this.delegates = {};
    this.read(); // Never replace an unreadable vault with an empty one.
    for (const kind of kinds) this[kind] = this.facade(kind);
  }
  check(kind) {
    if (!kinds.includes(kind)) throw fail('Choose listening or speaking.');
  }
  read() {
    const raw = this.store.secret('voice-connections');
    if (raw) {
      try {
        return decrypt(raw, this.key);
      } catch {
        throw fail(
          'Saved voice connections could not be unlocked. Restore the model vault key.',
          503,
        );
      }
    }
    return Object.fromEntries(
      kinds.map((kind) => [
        kind,
        {
          revision: 0,
          mode:
            this.environment[kind]?.baseUrl && this.environment[kind]?.model
              ? 'environment'
              : 'off',
          saved: null,
        },
      ]),
    );
  }
  record(kind) {
    this.check(kind);
    const state = this.read()[kind];
    if (kind === 'speech' && state.mode === 'system')
      return this.systemSpeech.configured ? { source: 'system', model: 'Mac system voice' } : null;
    if (kind === 'transcription' && state.mode === 'local')
      return this.localTranscription?.configured
        ? { source: 'local', model: 'Whisper Base' }
        : null;
    return state.mode === 'environment'
      ? this.environment[kind]
      : state.mode === 'saved'
        ? state.saved
        : null;
  }
  publicState() {
    const data = this.read();
    const safe = (record) =>
      record?.baseUrl && record?.model
        ? {
            baseUrl: record.baseUrl,
            model: record.model,
            voice: record.voice || '',
            hasKey: !!record.apiKey,
          }
        : null;
    return Object.fromEntries(
      kinds.map((kind) => [
        kind,
        {
          revision: data[kind].revision,
          mode: data[kind].mode,
          saved: safe(data[kind].saved),
          environment: safe(this.environment[kind]),
          configured: !!this.record(kind),
          ...(kind === 'speech'
            ? { system: { available: this.systemSpeech.configured, name: 'Mac system voice' } }
            : this.localTranscription
              ? { local: this.localTranscription.installation.status() }
              : {}),
        },
      ]),
    );
  }
  fresh(kind, input) {
    this.check(kind);
    const state = this.read()[kind];
    if (input?.revision !== state.revision)
      throw fail(
        'Voice settings changed in another window. Cancel and reopen this connection.',
        409,
      );
    return state;
  }
  candidate(kind, input) {
    const state = this.fresh(kind, input);
    const raw = clean(input.baseUrl, 'endpoint', 2000);
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw fail('Enter a complete endpoint URL.');
    }
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    )
      throw fail(
        'Use HTTPS, or HTTP on the Relay server’s localhost, without credentials or query parameters.',
      );
    const baseUrl = url.href.replace(/\/+$/, '');
    const record = {
      baseUrl,
      model: clean(input.model, 'model ID', 200),
      apiKey:
        input.apiKey === undefined
          ? state.saved?.baseUrl === baseUrl
            ? state.saved.apiKey
            : ''
          : clean(input.apiKey, 'API key', 8192, true),
      ...(kind === 'speech' ? { voice: clean(input.voice, 'voice ID', 120) } : {}),
    };
    return record;
  }
  update(kind, input) {
    const previous = this.fresh(kind, input);
    if (this.pending[kind] || this.store.read().voiceCalls?.some((c) => c.status === 'active'))
      throw fail('Finish the voice chat or audio request before changing this connection.', 409);
    const data = this.read();
    if (input.action === 'save')
      data[kind] = {
        revision: previous.revision + 1,
        mode: 'saved',
        saved: this.candidate(kind, input),
      };
    else if (input.action === 'remove')
      data[kind] = { revision: previous.revision + 1, mode: 'off', saved: null };
    else if (
      input.action === 'select' &&
      ['saved', 'environment', 'off', 'system', 'local'].includes(input.mode)
    ) {
      if (input.mode === 'system' && (kind !== 'speech' || !this.systemSpeech.configured))
        throw fail('The Mac voice is unavailable for this connection. Choose a speech service.');
      if (
        input.mode === 'local' &&
        (kind !== 'transcription' || !this.localTranscription?.configured)
      )
        throw fail('Set up local listening on your Relay computer first.');
      if (input.mode === 'saved' && !previous.saved) throw fail('Save a connection first.');
      if (
        input.mode === 'environment' &&
        !(this.environment[kind]?.baseUrl && this.environment[kind]?.model)
      )
        throw fail('No voice connection is configured on the server.');
      data[kind] = { ...previous, revision: previous.revision + 1, mode: input.mode };
    } else throw fail('Choose a supported voice settings action.');
    this.store.secret('voice-connections', encrypt(data, this.key));
    delete this.delegates[kind];
    this.store.emit('change', this.store.read());
    return this.publicState();
  }
  checkLocalVoice(input) {
    this.fresh('transcription', input);
    this.fresh('speech', { revision: input.speechRevision });
    if (!this.systemSpeech.configured)
      throw fail('Local voice setup needs the installed voice on a Relay Mac.', 503);
    if (
      this.pending.transcription ||
      this.pending.speech ||
      this.store.read().voiceCalls?.some((call) => call.status === 'active')
    )
      throw fail('Finish the voice chat or audio request before setting up voice.', 409);
  }
  selectLocalVoice(input) {
    this.checkLocalVoice(input);
    if (!this.localTranscription?.configured)
      throw fail('Set up local listening on your Relay computer first.');
    // One encrypted write selects the pair. A stale revision or active request
    // prevents both changes, so another device never sees a half-selected setup.
    const data = this.read();
    data.transcription = {
      ...data.transcription,
      revision: data.transcription.revision + 1,
      mode: 'local',
    };
    data.speech = { ...data.speech, revision: data.speech.revision + 1, mode: 'system' };
    this.store.secret('voice-connections', encrypt(data, this.key));
    this.delegates = {};
    this.store.emit('change', this.store.read());
    return this.publicState();
  }
  delegate(kind) {
    const record = this.record(kind);
    if (kind === 'speech' && record?.source === 'system') return this.systemSpeech;
    if (kind === 'transcription' && record?.source === 'local') return this.localTranscription;
    const identity = JSON.stringify(record);
    if (this.delegates[kind]?.identity !== identity)
      this.delegates[kind] = { identity, service: new (serviceClass(kind))(record || {}) };
    return this.delegates[kind].service;
  }
  async use(kind, fn) {
    this.pending[kind]++;
    try {
      return await fn();
    } finally {
      this.pending[kind]--;
    }
  }
  facade(kind) {
    const manager = this;
    const facade = {
      get configured() {
        return !!manager.record(kind);
      },
      get destination() {
        return manager.delegate(kind).destination;
      },
      get inputFormat() {
        return manager.delegate(kind).inputFormat || '';
      },
    };
    for (const method of kind === 'speech' ? ['forMessage', 'createMemo'] : ['transcribe'])
      facade[method] = (...args) =>
        manager.use(kind, () => manager.delegate(kind)[method](...args));
    return facade;
  }
  async test(kind, input, signal) {
    this.fresh(kind, input);
    const local =
      (kind === 'speech' && input.source === 'system') ||
      (kind === 'transcription' && input.source === 'local');
    const record = local ? null : this.candidate(kind, input);
    if (this.pending[kind])
      throw fail('An audio request is already in progress. Try again when it finishes.', 429);
    return this.use(kind, async () => {
      const service = local
        ? kind === 'speech'
          ? this.systemSpeech
          : this.localTranscription
        : new (serviceClass(kind))(record);
      if (!service) throw fail('Local listening is unavailable on this server.', 503);
      if (kind === 'speech') {
        const audio = await service.synthesize('Hi, I’m Relay. This is how I’ll sound.', signal);
        return { audio: audio.toString('base64'), mime: 'audio/wav' };
      }
      const recording = input.recording;
      if (
        !recording ||
        typeof recording.data !== 'string' ||
        recording.data.length > 11184812 ||
        recording.data.length % 4 !== 0 ||
        /[^A-Za-z0-9+/=]/.test(recording.data) ||
        !/^[^=]*={0,2}$/.test(recording.data)
      )
        throw fail('Choose a WAV, WebM, Ogg or M4A recording under 8 MB.');
      return service.transcribe(Buffer.from(recording.data, 'base64'), recording.mime, signal);
    });
  }
}
