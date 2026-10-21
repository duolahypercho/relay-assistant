import { useEffect, useRef, useState } from 'react';
import { Microphone, SpeakerHigh } from '@phosphor-icons/react';
import { api } from '../api';
import { useWorkspace } from '../context';
import { Field } from './ui';
import LocalListeningSetup, { type ListeningSetup } from './LocalListeningSetup';
import './voice-connections.css';

type Kind = 'transcription' | 'speech';
type Connection = { baseUrl: string; model: string; voice?: string; hasKey: boolean };
type Setting = {
  revision: number;
  mode: 'saved' | 'environment' | 'off' | 'system' | 'local';
  configured: boolean;
  saved: Connection | null;
  environment: Connection | null;
  system?: { available: boolean; name: string };
  local?: ListeningSetup;
};
type State = Record<Kind, Setting>;
type Draft = Connection & { kind: Kind; revision: number; apiKey: string };
const label = (kind: Kind) => (kind === 'speech' ? 'Speaking' : 'Listening');
const empty: Connection = { baseUrl: '', model: '', voice: '', hasKey: false };
export default function VoiceConnections() {
  const { s, connectAI } = useWorkspace();
  const [data, setData] = useState<State | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [recording, setRecording] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const controller = useRef<AbortController | null>(null);
  const server = api.mode() === 'server';
  useEffect(() => {
    if (server) void load();
    return () => controller.current?.abort();
  }, [server]);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  async function request(path: string, payload?: object, prepared?: AbortController) {
    if (prepared?.signal.aborted) return null;
    if (!prepared) controller.current?.abort();
    const current = prepared || new AbortController();
    controller.current = current;
    setBusy(path.endsWith('/test') ? 'test' : 'save');
    setError('');
    setNotice('');
    setPreview('');
    try {
      const result = await api.request(`/voice-connections${path}`, {
        signal: current.signal,
        ...(payload ? { method: 'POST', body: JSON.stringify(payload) } : {}),
      });
      return current.signal.aborted ? null : result;
    } catch (e) {
      if (!current.signal.aborted)
        setError(e instanceof Error ? e.message : 'Voice setup could not be updated.');
      return null;
    } finally {
      if (controller.current === current) setBusy('');
    }
  }
  async function load(kind?: Kind) {
    const result: State | null = await request('');
    if (result) {
      setData(result);
      if (kind) {
        setDraft({
          ...(result[kind].saved || result[kind].environment || empty),
          hasKey: !!result[kind].saved?.hasKey,
          kind,
          revision: result[kind].revision,
          apiKey: '',
        });
        setRecording(null);
      }
    }
  }
  function edit(value: Partial<Draft>) {
    setDraft((current) => (current ? { ...current, ...value } : null));
    setError('');
    setNotice('');
    setPreview('');
  }
  async function update(kind: Kind, action: string, payload: object) {
    const result = await request(`/${kind}/${action}`, payload);
    if (result) {
      setData(result);
      setDraft(null);
      setRecording(null);
      await api.refresh();
      setNotice(
        `${label(kind)} ${action === 'remove' ? 'connection forgotten.' : 'settings saved.'}`,
      );
    }
  }
  function payload() {
    return draft ? { ...draft, apiKey: draft.apiKey || (draft.hasKey ? undefined : '') } : {};
  }
  async function testConnection() {
    if (!draft) return;
    const current = new AbortController();
    controller.current?.abort();
    controller.current = current;
    setBusy('test');
    setError('');
    setNotice('');
    setPreview('');
    const input = payload();
    let audio;
    if (draft.kind === 'transcription') {
      if (!recording || recording.size > 8 * 1024 * 1024) {
        setError('Choose a WAV, WebM, Ogg or M4A recording under 8 MB.');
        setBusy('');
        return;
      }
      try {
        const bytes = await recording.arrayBuffer();
        const parts: string[] = [];
        const values = new Uint8Array(bytes);
        for (let i = 0; i < values.length; i += 8192)
          parts.push(String.fromCharCode(...values.subarray(i, i + 8192)));
        const extension = recording.name.split('.').at(-1)?.toLowerCase();
        const mime =
          (
            {
              wav: 'audio/wav',
              webm: 'audio/webm',
              ogg: 'audio/ogg',
              m4a: 'audio/mp4',
              mp4: 'audio/mp4',
            } as Record<string, string>
          )[extension || ''] || recording.type;
        audio = { data: btoa(parts.join('')), mime };
      } catch {
        if (!current.signal.aborted) {
          setError('That recording could not be read. Choose it again.');
          setBusy('');
        }
        return;
      }
    }
    const result = await request(`/${draft.kind}/test`, { ...input, recording: audio }, current);
    if (result?.audio) {
      const bytes = Uint8Array.from(atob(result.audio), (char) => char.charCodeAt(0));
      setPreview(URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' })));
      setNotice('Your voice preview is ready.');
    } else if (result?.text) setNotice(`Heard: ${result.text}`);
  }
  async function previewSystemVoice() {
    if (!data) return;
    const result = await request('/speech/test', {
      revision: data.speech.revision,
      source: 'system',
    });
    if (result?.audio) {
      const bytes = Uint8Array.from(atob(result.audio), (char) => char.charCodeAt(0));
      setPreview(URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' })));
      setNotice('Your Mac voice preview is ready.');
    }
  }
  const localVoiceActive = !!(
    data?.transcription.configured &&
    data?.speech.configured &&
    data.transcription.mode === 'local' &&
    data.speech.mode === 'system'
  );
  const installation = data?.transcription.local?.installation;
  const quickVoice = !!(
    data?.transcription.local?.supported &&
    data.speech.system?.available &&
    ((!data.transcription.configured && !data.speech.configured) ||
      localVoiceActive ||
      (installation?.speechRevision !== undefined &&
        (installation.phase === 'running' || (!installation.connected && installation.error))))
  );
  const connectionFields =
    data &&
    !draft &&
    (['transcription', 'speech'] as Kind[]).map((kind) => {
      const item = data[kind];
      const active =
        item.mode === 'saved' ? item.saved : item.mode === 'environment' ? item.environment : null;
      return (
        <div className="voice-setting" key={kind}>
          <div className="voice-setting-heading">
            {kind === 'speech' ? <SpeakerHigh size={20} /> : <Microphone size={20} />}
            <div>
              <h3>{label(kind)}</h3>
              <p>
                {item.mode === 'system'
                  ? item.system?.available
                    ? 'Mac system voice'
                    : 'Mac voice unavailable on this server'
                  : item.mode === 'local'
                    ? item.configured
                      ? 'Local listening'
                      : 'Local listening unavailable'
                    : active
                      ? `${active.model}${kind === 'speech' ? ` · ${active.voice}` : ''}`
                      : kind === 'speech'
                        ? 'Give replies a voice'
                        : 'Turn your speech into messages'}
              </p>
            </div>
            <button className="text-button" disabled={!!busy} onClick={() => void load(kind)}>
              {item.saved
                ? `Edit ${label(kind).toLowerCase()}`
                : `Set up ${label(kind).toLowerCase()}`}
            </button>
          </div>
          {(item.saved ||
            item.environment ||
            item.mode === 'system' ||
            item.local?.installed ||
            item.mode === 'local') && (
            <Field label={`${label(kind)} connection`}>
              <select
                value={item.mode}
                disabled={!!busy}
                onChange={(e) =>
                  void update(kind, 'select', {
                    revision: item.revision,
                    mode: e.target.value,
                  })
                }
              >
                <option value="off">Off</option>
                {(item.local?.installed || item.mode === 'local') && (
                  <option value="local" disabled={!item.local?.installed}>
                    Local listening
                  </option>
                )}
                {(item.system?.available || item.mode === 'system') && (
                  <option value="system" disabled={!item.system?.available}>
                    Mac system voice
                  </option>
                )}
                {item.saved && <option value="saved">Saved connection</option>}
                {item.environment && <option value="environment">Server configuration</option>}
              </select>
            </Field>
          )}
          {kind === 'transcription' && item.local && (
            <LocalListeningSetup
              initial={item.local}
              revision={item.revision}
              active={item.mode === 'local' && item.configured}
              disabled={!!busy}
              onChanged={async () => {
                const next = await api.request('/voice-connections');
                setData(next);
                await api.refresh();
              }}
              onSelect={() =>
                void update('transcription', 'select', {
                  revision: item.revision,
                  mode: 'local',
                })
              }
            />
          )}
          {kind === 'speech' && item.system?.available && (
            <div className="system-voice-choice">
              <p>
                Use the installed voice on your Relay Mac. Replies play on the device you’re using.
                No speech-service account is needed.
              </p>
              <div className="form-actions">
                {!item.saved && !item.environment && item.mode !== 'system' && (
                  <button
                    className="primary-button"
                    disabled={!!busy}
                    onClick={() =>
                      void update('speech', 'select', {
                        revision: item.revision,
                        mode: 'system',
                      })
                    }
                  >
                    Use Mac voice
                  </button>
                )}
                <button
                  className="text-button"
                  disabled={!!busy}
                  onClick={() => void previewSystemVoice()}
                >
                  {busy === 'test' ? 'Creating preview…' : 'Preview Mac voice'}
                </button>
              </div>
              <p className="form-note">
                The first preview may take a moment. You can change the voice in the Mac’s speech
                settings.
              </p>
            </div>
          )}
        </div>
      );
    });
  return (
    <article className="settings-card voice-connections" aria-label="Voice settings">
      <div className="settings-title">
        <SpeakerHigh size={23} />
        <div>
          <h2>A voice for your assistant</h2>
          <p>Talk naturally, dictate a message, or listen to a reply.</p>
        </div>
      </div>
      {!server ? (
        <p className="setup-note">
          Open the Relay app or connect your Relay server to set up voice.
        </p>
      ) : (
        <>
          {!data && !busy && (
            <button className="secondary-button" onClick={() => void load()}>
              Load voice settings
            </button>
          )}
          {data && !draft && quickVoice && (
            <section className="voice-quick" aria-label="Simple voice setup">
              <LocalListeningSetup
                initial={data.transcription.local!}
                revision={data.transcription.revision}
                speechRevision={data.speech.revision}
                chatConfigured={s.connections.model.configured}
                active={localVoiceActive}
                disabled={!!busy}
                onChanged={async () => {
                  setData(await api.request('/voice-connections'));
                  await api.refresh();
                }}
                onSelect={() => {}}
              />
              {localVoiceActive && (
                <button
                  className="text-button"
                  disabled={!!busy}
                  onClick={() => void previewSystemVoice()}
                >
                  {busy === 'test' ? 'Creating preview…' : 'Preview voice'}
                </button>
              )}
              {localVoiceActive && !s.connections.model.configured && (
                <button className="primary-button" onClick={connectAI}>
                  Connect AI
                </button>
              )}
            </section>
          )}
          {!draft &&
            (quickVoice ? (
              <details
                className="voice-options"
                open={optionsOpen}
                onToggle={(e) => setOptionsOpen(e.currentTarget.open)}
              >
                <summary>Voice options</summary>
                {optionsOpen && connectionFields}
              </details>
            ) : (
              connectionFields
            ))}
          {!draft && preview && <audio controls src={preview} aria-label="Voice preview" />}
          {draft && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void update(draft.kind, 'save', payload());
              }}
            >
              <h3>Set up {label(draft.kind).toLowerCase()}</h3>
              <fieldset className="model-fields" disabled={!!busy}>
                <Field
                  label="Audio endpoint"
                  hint="Use a compatible audio API. Localhost means the computer running your Relay server."
                >
                  <input
                    type="url"
                    value={draft.baseUrl}
                    required
                    maxLength={2000}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="https://your-provider.example/v1"
                    onChange={(e) => edit({ baseUrl: e.target.value, apiKey: '', hasKey: false })}
                  />
                </Field>
                <Field label="Audio model" hint="Enter the exact model ID from your provider.">
                  <input
                    value={draft.model}
                    required
                    maxLength={200}
                    autoComplete="off"
                    onChange={(e) => edit({ model: e.target.value })}
                  />
                </Field>
                {draft.kind === 'speech' && (
                  <Field label="Voice ID">
                    <input
                      value={draft.voice || ''}
                      required
                      maxLength={120}
                      autoComplete="off"
                      onChange={(e) => edit({ voice: e.target.value })}
                    />
                  </Field>
                )}
                <Field
                  label="Audio API key (optional)"
                  hint={
                    draft.hasKey
                      ? 'A key is saved. Leave blank to keep it, or enter a replacement.'
                      : 'Stored encrypted on your server. Leave blank for a service without a key.'
                  }
                >
                  <input
                    type="password"
                    value={draft.apiKey}
                    autoComplete="new-password"
                    spellCheck={false}
                    maxLength={8192}
                    onChange={(e) => edit({ apiKey: e.target.value })}
                  />
                </Field>
                {draft.hasKey && (
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => edit({ hasKey: false, apiKey: '' })}
                  >
                    Clear saved key on save
                  </button>
                )}
                <details className="model-endpoint">
                  <summary>Test this connection</summary>
                  {draft.kind === 'transcription' ? (
                    <Field
                      label="Audio test file"
                      hint="WAV, WebM, Ogg or M4A, up to 8 MB. Testing sends this recording to the endpoint above without adding a chat message."
                    >
                      <input
                        type="file"
                        accept=".wav,.webm,.ogg,.m4a,.mp4,audio/wav,audio/webm,audio/ogg,audio/mp4"
                        onChange={(e) => {
                          setRecording(e.target.files?.[0] || null);
                          setNotice('');
                          setError('');
                        }}
                      />
                    </Field>
                  ) : (
                    <p className="setup-note">
                      Testing sends “Hi, I’m Relay. This is how I’ll sound.” to this endpoint and
                      creates an audio preview. Provider usage charges may apply.
                    </p>
                  )}
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={
                      !draft.baseUrl ||
                      !draft.model ||
                      (draft.kind === 'speech' ? !draft.voice : !recording)
                    }
                    onClick={() => void testConnection()}
                  >
                    {busy === 'test'
                      ? 'Testing…'
                      : draft.kind === 'speech'
                        ? 'Preview voice'
                        : 'Test recording'}
                  </button>
                </details>
                {preview && <audio controls src={preview} aria-label="Voice preview" />}
                <p className="model-destination">
                  {draft.kind === 'speech'
                    ? 'Reply text is sent to this endpoint to make audio.'
                    : 'Your microphone recordings are sent to this endpoint to recognize speech.'}{' '}
                  Supports{' '}
                  {draft.kind === 'speech'
                    ? '/audio/speech with WAV output.'
                    : '/audio/transcriptions with JSON output.'}
                </p>
                <div className="form-actions">
                  <button className="primary-button" type="submit">
                    Save {label(draft.kind).toLowerCase()}
                  </button>
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => {
                      setDraft(null);
                      setError('');
                      setNotice('');
                      setPreview('');
                      setRecording(null);
                    }}
                  >
                    Cancel
                  </button>
                  {data?.[draft.kind].saved && (
                    <button
                      className="text-button danger"
                      type="button"
                      onClick={() =>
                        void update(draft.kind, 'remove', { revision: draft.revision })
                      }
                    >
                      Forget connection
                    </button>
                  )}
                </div>
              </fieldset>
            </form>
          )}
          {busy === 'test' && (
            <button
              className="text-button"
              onClick={() => {
                controller.current?.abort();
                setBusy('');
                setNotice('Test cancelled. Your settings are unchanged.');
              }}
            >
              Cancel test
            </button>
          )}
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="setup-note" role="status">
              {notice}
            </p>
          )}
        </>
      )}
    </article>
  );
}
