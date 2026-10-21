import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Plus,
  ArrowClockwise,
  ArrowSquareOut,
  CaretRight,
  Desktop,
} from '@phosphor-icons/react';
import { api } from '../api';
import { tr } from '../i18n';
import { Field } from './ui';
import {
  modelPresets,
  modelProtocols,
  localOllamaConnection,
} from '../../shared/model-catalog.mjs';
import { useModelSignIn } from './useModelSignIn';
import LocalModelSetup from './LocalModelSetup';
import ModelAbilitySummary from './ModelAbilitySummary';
type Abilities = {
  tools: 'auto' | 'supported' | 'unsupported';
  vision: 'auto' | 'supported' | 'unsupported';
};
type Connection = {
  id: string;
  revision: number | string;
  name: string;
  preset: string;
  baseUrl: string;
  protocol: string;
  model: string;
  hasKey: boolean;
  readOnly: boolean;
  reportUsage?: boolean;
  abilities?: Abilities;
  replyMode?: 'quick' | 'default';
};
type Connections = {
  active: string | null;
  connections: Connection[];
  fallbacks?: Record<string, string[]>;
};
type Draft = {
  oauthId?: string;
  id?: string;
  name: string;
  preset: string;
  baseUrl: string;
  protocol: string;
  model: string;
  apiKey: string;
  hasKey?: boolean;
  reportUsage?: boolean;
  abilities?: Abilities;
  replyMode?: 'quick' | 'default';
};
const blank = (id = 'openai'): Draft => {
  const preset = modelPresets.find((p) => p.id === id)!;
  return {
    ...preset,
    id: undefined,
    preset: id,
    model: '',
    apiKey: '',
    replyMode: localOllamaConnection(preset) ? 'quick' : 'default',
  };
};
export default function ModelConnections({
  onActivated,
  returnToChat = false,
}: {
  onActivated?: () => void;
  returnToChat?: boolean;
}) {
  const [data, setData] = useState<Connections>({ active: null, connections: [] });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [localSetup, setLocalSetup] = useState(false);
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [manualModel, setManualModel] = useState(false);
  const [remove, setRemove] = useState(false);
  const [backupChoice, setBackupChoice] = useState('');
  const server = api.mode() === 'server';
  const discovery = useRef(0);
  const signIn = useModelSignIn((id) => {
    const next = { ...blank('openrouter'), oauthId: id };
    setDraft(next);
    setModels([]);
    setManualModel(false);
    setError('');
    setNotice('');
    const generation = ++discovery.current;
    setBusy('discover');
    void api
      .request('/models/discover', { method: 'POST', body: JSON.stringify(next) })
      .then((result) => {
        if (discovery.current !== generation) return;
        setModels(result.models);
        setNotice(
          result.models.length ? '' : 'OpenRouter is connected. Enter a model ID to finish.',
        );
      })
      .catch(() => {
        if (discovery.current === generation)
          setError(
            'Connected, but the model list could not load. Try Find models or enter a model ID.',
          );
      })
      .finally(() => {
        if (discovery.current === generation) setBusy('');
      });
  });
  useEffect(
    () => () => {
      discovery.current++;
    },
    [],
  );
  useEffect(() => {
    if (!server) return;
    let active = true;
    api
      .request('/models')
      .then((state) => {
        if (active) {
          setData(state);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [server]);
  function edit(value: Partial<Draft>) {
    if ('baseUrl' in value || 'protocol' in value || 'model' in value) {
      value.abilities = { tools: 'auto', vision: 'auto' };
      value.replyMode = localOllamaConnection({ ...draft, ...value }) ? 'quick' : 'default';
    }
    setDraft((current) => (current ? { ...current, ...value } : current));
    if ('baseUrl' in value || 'protocol' in value || 'apiKey' in value) setModels([]);
    setError('');
    setNotice('');
  }
  function open(connection?: Connection, preset = 'openai') {
    setDraft(connection ? { ...connection, apiKey: '' } : blank(preset));
    setModels([]);
    setManualModel(false);
    setError('');
    setNotice('');
    setRemove(false);
  }
  async function request(action: string, payload: object) {
    setBusy(action);
    setError('');
    setNotice('');
    try {
      return await api.request(`/models/${action}`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The connection could not be updated.');
      return null;
    } finally {
      setBusy('');
    }
  }
  function payload() {
    if (!draft) return {};
    return { ...draft, apiKey: draft.apiKey || (draft.hasKey ? undefined : '') };
  }
  const current = data.connections.find((c) => c.id === data.active);
  const preset = modelPresets.find((p) => p.id === draft?.preset);
  const backups = data.active ? data.fallbacks?.[data.active] || [] : [];
  const availableBackups = data.connections.filter(
    (c) => c.id !== data.active && !backups.includes(c.id),
  );
  async function updateBackups(ids: string[]) {
    const result = await request('fallbacks', { id: data.active, ids });
    if (result) {
      setData(result);
      setBackupChoice('');
      setNotice(
        ids.length
          ? 'Backup models saved for new requests.'
          : 'Backup models turned off for new requests.',
      );
    }
  }
  return (
    <article className="settings-card model-connections" aria-label="AI models">
      {!server ? (
        <p className="setup-note">
          Open the Relay app or connect your Relay server to add a model.
        </p>
      ) : (
        <>
          {loaded && !draft && !localSetup && (
            <>
              {!!data.connections.length && (
                <div className="model-active">
                  <div>
                    <span className="model-caption">
                      {current ? 'USING NOW' : 'NO MODEL SELECTED'}
                    </span>
                    <h2>{current?.name || 'AI is off'}</h2>
                    <p>
                      {current?.model ||
                        'Use a provider you already have, or a model running on your computer.'}
                    </p>
                  </div>
                  {current && <Check size={22} aria-label="Selected model" />}
                </div>
              )}
              {!!data.connections.length && (
                <Field
                  label="Active connection"
                  hint="Applies to new requests. Work already in progress keeps its model."
                >
                  <select
                    value={data.active || ''}
                    disabled={!!busy}
                    onChange={async (e) => {
                      const result = await request('select', { id: e.target.value || null });
                      if (result) {
                        setData(result);
                        await api.refresh();
                        setNotice(
                          e.target.value
                            ? 'Model selected.'
                            : 'AI is disconnected. Saved connections are kept.',
                        );
                        if (result.active) onActivated?.();
                      }
                    }}
                  >
                    <option value="">No AI model</option>
                    {data.connections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} · {c.model}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {current && (
                <ModelAbilitySummary
                  key={`${current.id}:${current.revision}`}
                  connection={{ id: current.id }}
                />
              )}
              {current && data.connections.length > 1 && (
                <details className="model-backups">
                  <summary>
                    Backup models{backups.length ? ` · ${backups.length} ready` : ' · off'}
                  </summary>
                  <p className="form-note">
                    If {current.name} is unavailable, try these models in order. Each can receive
                    the same chat, files and tool results, with its own provider charges. Applies to
                    new requests.
                  </p>
                  {backups.length > 0 && (
                    <ol aria-label="Backup model order">
                      {backups.map((id, index) => {
                        const backup = data.connections.find((c) => c.id === id)!;
                        return (
                          <li key={id}>
                            <span>
                              {backup.name}
                              <small>{backup.model}</small>
                            </span>
                            <div>
                              {index > 0 && (
                                <button
                                  className="text-button"
                                  type="button"
                                  disabled={!!busy}
                                  aria-label={`Move ${backup.name} earlier`}
                                  onClick={() => {
                                    const ids = [...backups];
                                    [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];
                                    void updateBackups(ids);
                                  }}
                                >
                                  Move up
                                </button>
                              )}
                              <button
                                className="text-button"
                                type="button"
                                disabled={!!busy}
                                aria-label={`Remove ${backup.name} backup`}
                                onClick={() =>
                                  void updateBackups(backups.filter((entry) => entry !== id))
                                }
                              >
                                Remove
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                  {backups.length < 3 && availableBackups.length > 0 && (
                    <div className="model-backup-add">
                      <Field label="Add a backup model">
                        <select
                          value={backupChoice}
                          disabled={!!busy}
                          onChange={(e) => setBackupChoice(e.target.value)}
                        >
                          <option value="">Choose a saved model</option>
                          {availableBackups.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name} · {c.model}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={!!busy || !availableBackups.some((c) => c.id === backupChoice)}
                        onClick={() => void updateBackups([...backups, backupChoice])}
                      >
                        Add backup
                      </button>
                    </div>
                  )}
                  {backups.length > 0 && (
                    <button
                      className="text-button"
                      type="button"
                      disabled={!!busy}
                      onClick={() => void updateBackups([])}
                    >
                      Turn off backups
                    </button>
                  )}
                </details>
              )}
              <div className="model-saved">
                {data.connections.map((c) => (
                  <div className="model-saved-row" key={c.id}>
                    <div>
                      <strong>{c.name}</strong>
                      <span>{c.model}</span>
                    </div>
                    {c.readOnly ? (
                      <small>Set on server</small>
                    ) : (
                      <button
                        className="text-button"
                        disabled={!!busy}
                        onClick={() => open(c)}
                        aria-label={`Edit ${c.name}`}
                      >
                        Edit
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {!signIn.flow && (
                <div className="model-setup-choices">
                  {(!data.connections.length || returnToChat) && (
                    <p className="model-setup-intro">
                      {returnToChat
                        ? tr('Choose how to connect. Your draft stays unsent.')
                        : 'Choose how to connect. Your chats stay together.'}
                    </p>
                  )}
                  <button
                    className="model-setup-choice"
                    aria-label="Connect OpenRouter"
                    disabled={!!busy || signIn.starting}
                    onClick={() => void signIn.begin()}
                  >
                    <ArrowSquareOut size={22} aria-hidden="true" />
                    <span>
                      <strong>{signIn.starting ? 'Opening browser…' : 'Connect OpenRouter'}</strong>
                      <small>Sign in, then choose a model. No API key to copy.</small>
                    </span>
                    <CaretRight size={18} aria-hidden="true" />
                  </button>
                  <button
                    className="model-setup-choice"
                    aria-label="Use a local model"
                    disabled={!!busy || signIn.starting}
                    onClick={() => {
                      setError('');
                      setNotice('');
                      setLocalSetup(true);
                    }}
                  >
                    <Desktop size={22} aria-hidden="true" />
                    <span>
                      <strong>Use a local model</strong>
                      <small>Set up local AI or use Ollama or LM Studio.</small>
                    </span>
                    <CaretRight size={18} aria-hidden="true" />
                  </button>
                  <button
                    className="model-setup-choice"
                    aria-label="Add a model"
                    disabled={!!busy || !!signIn.flow || signIn.starting}
                    onClick={() => open()}
                  >
                    <Plus size={22} aria-hidden="true" />
                    <span>
                      <strong>Add a model</strong>
                      <small>Use an API key or enter a custom connection.</small>
                    </span>
                    <CaretRight size={18} aria-hidden="true" />
                  </button>
                  <p className="model-caption-note">Your provider’s usage and limits apply.</p>
                </div>
              )}
            </>
          )}
          {localSetup && (
            <LocalModelSetup
              saved={data.connections}
              onCancel={() => setLocalSetup(false)}
              onManual={() => {
                setLocalSetup(false);
                open(undefined, 'ollama');
              }}
              onConnected={async () => {
                setData(await api.request('/models'));
                await api.refresh();
                setLocalSetup(false);
                setNotice('Connection saved. New requests will use this model.');
                onActivated?.();
              }}
            />
          )}
          {signIn.flow?.phase === 'waiting' && (
            <div className="model-sign-in" role="status">
              <strong>Finish signing in with OpenRouter</strong>
              <p>Return here after signing in. Your current model stays selected until you save.</p>
              {signIn.flow.openUrl && (
                <a
                  className="secondary-button"
                  href={signIn.flow.openUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open sign-in
                </a>
              )}
              <button className="text-button" onClick={() => void signIn.cancel()}>
                Cancel sign-in
              </button>
            </div>
          )}
          {signIn.error && (
            <p className="form-error" role="alert">
              {signIn.error}
            </p>
          )}
          {draft && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const result = await request('save', { ...payload(), activate: true });
                if (result) {
                  setData(result);
                  setDraft(null);
                  signIn.forget();
                  await api.refresh();
                  setNotice('Connection saved. New requests will use this model.');
                  onActivated?.();
                }
              }}
            >
              <fieldset disabled={!!busy} className="model-fields">
                {!draft.oauthId && (
                  <Field label="Provider">
                    <select
                      disabled={!!draft.oauthId}
                      value={draft.preset}
                      onChange={(e) => {
                        const next = blank(e.target.value);
                        setDraft({ ...next, id: draft.id });
                        setModels([]);
                        setManualModel(false);
                        setNotice('');
                        setError('');
                      }}
                    >
                      {modelPresets.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {draft.oauthId ? (
                  <p className="model-sign-in">Signed in with OpenRouter.</p>
                ) : (
                  <Field
                    label={preset?.local ? 'API key (optional)' : 'API key'}
                    hint={
                      draft.hasKey
                        ? 'A key is saved. Leave blank to keep it, or enter a replacement.'
                        : 'Stored encrypted on your Relay server. Never added to chat history.'
                    }
                  >
                    <input
                      type="password"
                      value={draft.apiKey}
                      onChange={(e) => edit({ apiKey: e.target.value })}
                      autoComplete="new-password"
                      spellCheck={false}
                      maxLength={8192}
                      placeholder={draft.hasKey ? 'Saved key' : 'Paste your provider’s API key'}
                      required={!preset?.local && !draft.hasKey}
                    />
                  </Field>
                )}
                {(!models.length || manualModel) && (
                  <Field
                    label="Model"
                    hint="Enter the model ID, or use Find models to choose from a list."
                  >
                    <input
                      value={draft.model}
                      onChange={(e) => edit({ model: e.target.value })}
                      required
                      maxLength={200}
                      autoComplete="off"
                      placeholder="Choose or type a model ID"
                    />
                  </Field>
                )}
                {(!draft.oauthId || !models.length || manualModel) && (
                  <button
                    className="text-button"
                    type="button"
                    onClick={async () => {
                      const result = await request('discover', payload());
                      if (result) {
                        setModels(result.models);
                        setManualModel(
                          !!draft.model &&
                            !result.models.some((m: { id: string }) => m.id === draft.model),
                        );
                        setNotice(
                          result.models.length
                            ? `${result.models.length} models found${result.more ? ' (first page)' : ''}. Choose a model, or enter its ID.`
                            : 'No models were listed. You can still enter a model ID.',
                        );
                      }
                    }}
                  >
                    <ArrowClockwise size={16} />{' '}
                    {busy === 'discover' ? 'Loading models…' : 'Find models'}
                  </button>
                )}
                {!!models.length && !manualModel && (
                  <Field label="Available models">
                    <select
                      value={models.some((m) => m.id === draft.model) ? draft.model : ''}
                      onChange={(e) => edit({ model: e.target.value })}
                      required
                    >
                      <option value="" disabled>
                        Choose a model
                      </option>
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {!!models.length && (
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => setManualModel(!manualModel)}
                  >
                    {manualModel ? 'Choose from the list' : 'Enter a model ID instead'}
                  </button>
                )}
                <details
                  className="model-endpoint"
                  open={draft.preset === 'custom' || !!preset?.local}
                >
                  <summary>Connection details</summary>
                  <Field label="Connection name">
                    <input
                      value={draft.name}
                      onChange={(e) => edit({ name: e.target.value })}
                      maxLength={80}
                      required
                    />
                  </Field>
                  <Field
                    label="Endpoint"
                    hint="Localhost means the computer running your Relay server, including when you use the phone app."
                  >
                    <input
                      type="url"
                      disabled={!!draft.oauthId}
                      value={draft.baseUrl}
                      onChange={(e) => edit({ baseUrl: e.target.value, hasKey: false, apiKey: '' })}
                      required
                      maxLength={2000}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </Field>
                  <Field label="API format">
                    <select
                      disabled={!!draft.oauthId}
                      value={draft.protocol}
                      onChange={(e) =>
                        edit({ protocol: e.target.value, hasKey: false, apiKey: '' })
                      }
                    >
                      {modelProtocols.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {draft.protocol === 'chat' && (
                    <label className="usage-report-option">
                      <input
                        type="checkbox"
                        checked={draft.reportUsage !== false}
                        onChange={(e) => edit({ reportUsage: e.target.checked })}
                      />
                      <span>
                        Request token usage{' '}
                        <small>
                          Turn off if your custom endpoint doesn’t support streaming usage reports.
                        </small>
                      </span>
                    </label>
                  )}
                  <p className="model-caption-note">
                    Choose a model with tool calling for assistant actions and vision for computer
                    screenshots.
                  </p>
                  {localOllamaConnection(draft) && (
                    <Field
                      label="Reply style"
                      hint="Quick replies turn off extra thinking when your local model supports it. Model default uses the model’s usual reasoning, which may take longer."
                    >
                      <select
                        value={draft.replyMode || 'default'}
                        onChange={(e) => edit({ replyMode: e.target.value as Draft['replyMode'] })}
                      >
                        <option value="quick">Quick replies</option>
                        <option value="default">Model default</option>
                      </select>
                    </Field>
                  )}
                  <Field
                    label="Assistant actions"
                    hint="Automatic reads Ollama’s reported abilities. Choose Not supported for a text-only model on another provider."
                  >
                    <select
                      value={draft.abilities?.tools || 'auto'}
                      onChange={(e) =>
                        edit({
                          abilities: {
                            tools: e.target.value as Abilities['tools'],
                            vision: draft.abilities?.vision || 'auto',
                          },
                        })
                      }
                    >
                      <option value="auto">Automatic</option>
                      <option value="supported">Supported</option>
                      <option value="unsupported">Not supported · chat only</option>
                    </select>
                  </Field>
                  <Field label="Image support">
                    <select
                      value={draft.abilities?.vision || 'auto'}
                      onChange={(e) =>
                        edit({
                          abilities: {
                            tools: draft.abilities?.tools || 'auto',
                            vision: e.target.value as Abilities['vision'],
                          },
                        })
                      }
                    >
                      <option value="auto">Automatic</option>
                      <option value="supported">Supported</option>
                      <option value="unsupported">Not supported</option>
                    </select>
                  </Field>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={!draft.model}
                    onClick={async () => {
                      const result = await request('test', payload());
                      if (result) setNotice(result.message);
                    }}
                  >
                    {busy === 'test' ? 'Testing…' : 'Test connection'}
                  </button>
                  <p className="model-caption-note">
                    Optional: send a short test message. Your provider may charge for it.
                  </p>
                </details>
                <p className="model-destination">
                  When used, this model receives your chats, files and tool results at{' '}
                  <strong>
                    {draft.baseUrl
                      ? (() => {
                          try {
                            return new URL(draft.baseUrl).host;
                          } catch {
                            return 'the endpoint you enter';
                          }
                        })()
                      : 'the endpoint you enter'}
                  </strong>
                  .
                </p>
                <div className="form-actions">
                  <button className="primary-button" type="submit">
                    {busy === 'save' ? 'Saving…' : 'Save & use model'}
                  </button>
                  <button
                    className="text-button"
                    type="button"
                    onClick={async () => {
                      if (draft.oauthId && !(await signIn.cancel())) return;
                      discovery.current++;
                      setDraft(null);
                      setError('');
                      setNotice('');
                    }}
                  >
                    Cancel
                  </button>
                </div>
                {draft.id &&
                  (!remove ? (
                    <button
                      type="button"
                      className="text-button danger-text"
                      onClick={() => setRemove(true)}
                    >
                      Remove connection
                    </button>
                  ) : (
                    <div className="model-remove">
                      <p>Remove this connection and its saved key? Your chats stay saved.</p>
                      <button
                        type="button"
                        className="text-button danger-text"
                        onClick={async () => {
                          const result = await request('remove', { id: draft.id });
                          if (result) {
                            setData(result);
                            setDraft(null);
                            await api.refresh();
                            setNotice('Connection removed.');
                          }
                        }}
                      >
                        Remove saved connection
                      </button>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => setRemove(false)}
                      >
                        Keep connection
                      </button>
                    </div>
                  ))}
              </fieldset>
            </form>
          )}
        </>
      )}
      {error && (
        <p className="model-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="model-notice" role="status">
          {notice}
        </p>
      )}
    </article>
  );
}
