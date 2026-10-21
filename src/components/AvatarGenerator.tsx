import { useEffect, useRef, useState } from 'react';
import { X, Sparkle } from '@phosphor-icons/react';
import { api } from '../api';
import { Field } from './ui';
import { readAvatarPicture } from '../avatar-image';
import { avatarStyles, imageFormats, imagePresets } from '../../shared/image-catalog.mjs';

type Record = { baseUrl: string; model: string; format: string; hasKey?: boolean };
type Connection = {
  revision: number;
  mode: string;
  configured: boolean;
  saved: Record | null;
  environment: Record | null;
};
type Draft = Record & { apiKey: string; preset: string };
const initial = (): Draft => ({ ...imagePresets[0], preset: 'openai', apiKey: '' });

export default function AvatarGenerator({
  onUse,
  onClose,
}: {
  onUse: (file: File) => Promise<void>;
  onClose: () => void;
}) {
  const [data, setData] = useState<Connection | null>(null);
  const [setup, setSetup] = useState(false);
  const [draft, setDraft] = useState<Draft>(initial);
  const [prompt, setPrompt] = useState('');
  const [style, setStyle] = useState('anime');
  const [busy, setBusy] = useState('loading');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<{ file: File; url: string } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const previewURL = useRef('');
  const previewPanel = useRef<HTMLDivElement | null>(null);
  const usePicture = useRef<HTMLButtonElement | null>(null);
  const current =
    data?.mode === 'environment' ? data.environment : data?.mode === 'saved' ? data.saved : null;
  const server = api.mode() === 'server';
  useEffect(() => {
    if (preview) {
      previewPanel.current?.scrollIntoView({ block: 'nearest' });
      usePicture.current?.focus({ preventScroll: true });
    }
  }, [preview]);
  function editConnection(value?: Connection) {
    const state = value || data;
    const record = state?.saved || state?.environment;
    setDraft(
      record
        ? {
            ...record,
            apiKey: '',
            hasKey: !!state?.saved?.hasKey,
            preset: imagePresets.find((p) => p.baseUrl === record.baseUrl)?.id || 'custom',
          }
        : initial(),
    );
    setSetup(true);
  }
  async function load() {
    const abort = new AbortController();
    controller.current = abort;
    setBusy('loading');
    setError('');
    try {
      const result = await api.request('/image-connection', { signal: abort.signal });
      if (alive.current) {
        setData(result);
        if (!result.configured && !result.saved && !result.environment) editConnection(result);
      }
    } catch (e) {
      if (alive.current && !abort.signal.aborted) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy('');
    }
  }
  useEffect(() => {
    alive.current = true;
    if (server) void load();
    else setBusy('');
    return () => {
      alive.current = false;
      controller.current?.abort();
      if (previewURL.current) URL.revokeObjectURL(previewURL.current);
    };
  }, []);
  async function update(payload: object) {
    setBusy('saving');
    setError('');
    setNotice('');
    try {
      const result = await api.request('/image-connection', {
        method: 'POST',
        body: JSON.stringify({ ...payload, revision: data?.revision }),
      });
      if (alive.current) {
        setData(result);
        setSetup(false);
        setDraft(initial());
        setNotice(result.configured ? 'Image service ready.' : 'Image generation is off.');
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy('');
    }
  }
  async function generate() {
    if (!data?.configured || !prompt.trim() || busy) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy('generating');
    setError('');
    setNotice('');
    let url = '';
    try {
      const result = await api.request('/avatar/generate', {
        method: 'POST',
        signal: abort.signal,
        body: JSON.stringify({ prompt, style, revision: data.revision }),
      });
      const bytes = Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0));
      const file = new File([bytes], 'Your character', { type: result.mime });
      const picture = await readAvatarPicture(file);
      url = picture.url;
      if (!alive.current || abort.signal.aborted) return;
      if (previewURL.current) URL.revokeObjectURL(previewURL.current);
      previewURL.current = url;
      setPreview({ file, url });
      url = '';
    } catch (e) {
      if (alive.current) {
        if (abort.signal.aborted) setNotice('Stopped. Your current character is kept.');
        else setError((e as Error).message);
      }
    } finally {
      if (url) URL.revokeObjectURL(url);
      if (alive.current) setBusy('');
    }
  }
  return (
    <section
      className="avatar-generator"
      aria-label="Create a character"
      onKeyDown={(e) => {
        // This inline editor lives inside the profile form; Enter must not save that profile.
        if (e.key === 'Enter' && e.target instanceof HTMLInputElement) e.preventDefault();
      }}
    >
      <div className="section-line">
        <h4>Create a character</h4>
        <button
          type="button"
          className="icon-button"
          aria-label="Close character generator"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      {!server ? (
        <p className="form-note">
          Connect to your Relay server to use an image service. You can still choose a character or
          upload a picture.
        </p>
      ) : (
        <>
          {busy === 'loading' && <p role="status">Opening image settings…</p>}
          {data && !setup && (
            <details className="avatar-image-service" open={!data.configured}>
              <summary>Image service</summary>
              <p className="form-note">
                {current
                  ? `${current.model} · ${new URL(current.baseUrl).host}`
                  : 'Image generation is off.'}
              </p>
              <div className="form-actions">
                <button
                  className="text-button"
                  type="button"
                  disabled={!!busy}
                  onClick={() => editConnection()}
                >
                  Change image service
                </button>
                {data.configured && (
                  <button
                    className="text-button"
                    type="button"
                    disabled={!!busy}
                    onClick={() => void update({ action: 'select', mode: 'off' })}
                  >
                    Turn off
                  </button>
                )}
                {!data.configured && data.saved && (
                  <button
                    className="text-button"
                    type="button"
                    disabled={!!busy}
                    onClick={() => void update({ action: 'select', mode: 'saved' })}
                  >
                    Use saved image service
                  </button>
                )}
                {data.environment && data.mode !== 'environment' && (
                  <button
                    className="text-button"
                    type="button"
                    disabled={!!busy}
                    onClick={() => void update({ action: 'select', mode: 'environment' })}
                  >
                    Use server image service
                  </button>
                )}
              </div>
            </details>
          )}
          {data && setup && (
            <fieldset className="model-fields" disabled={!!busy}>
              <p className="form-note">
                Connect an image service once. Your chat model stays separate.
              </p>
              <Field label="Image provider">
                <select
                  value={draft.preset}
                  onChange={(e) => {
                    const preset = imagePresets.find((p) => p.id === e.target.value)!;
                    setDraft({ ...preset, preset: preset.id, apiKey: '', hasKey: false });
                  }}
                >
                  {imagePresets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Image API key"
                hint={
                  draft.hasKey
                    ? 'Leave blank to keep the saved key for this destination.'
                    : 'Stored encrypted on your Relay server. Optional for a local service.'
                }
              >
                <input
                  type="password"
                  autoComplete="new-password"
                  value={draft.apiKey}
                  maxLength={8192}
                  onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                />
              </Field>
              <Field label="Image model">
                <input
                  value={draft.model}
                  maxLength={200}
                  onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                />
              </Field>
              <details className="model-endpoint" open={draft.preset === 'custom'}>
                <summary>Connection details</summary>
                <Field
                  label="Image endpoint"
                  hint="An API base URL. Localhost refers to your Relay server computer."
                >
                  <input
                    type="text"
                    inputMode="url"
                    value={draft.baseUrl}
                    maxLength={2000}
                    onChange={(e) =>
                      setDraft({ ...draft, baseUrl: e.target.value, apiKey: '', hasKey: false })
                    }
                  />
                </Field>
                <Field label="Image API format">
                  <select
                    value={draft.format}
                    onChange={(e) =>
                      setDraft({ ...draft, format: e.target.value, apiKey: '', hasKey: false })
                    }
                  >
                    {imageFormats.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </details>
              <div className="form-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!draft.baseUrl.trim() || !draft.model.trim()}
                  onClick={() =>
                    void update({
                      action: 'save',
                      ...draft,
                      apiKey: draft.apiKey || (draft.hasKey ? undefined : ''),
                    })
                  }
                >
                  Save image service
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setSetup(false);
                    setDraft(initial());
                  }}
                >
                  Cancel setup
                </button>
                {data.saved && (
                  <button
                    type="button"
                    className="text-button danger-text"
                    onClick={() => void update({ action: 'remove' })}
                  >
                    Forget saved image service
                  </button>
                )}
              </div>
            </fieldset>
          )}
          {data?.configured && !setup && (
            <>
              <div className="avatar-styles" role="group" aria-label="Character style">
                {avatarStyles.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    aria-pressed={style === item.id}
                    disabled={!!busy}
                    onClick={() => setStyle(item.id)}
                  >
                    {item.name}
                  </button>
                ))}
              </div>
              <Field label="Describe your character">
                <textarea
                  value={prompt}
                  maxLength={2000}
                  rows={3}
                  disabled={!!busy}
                  placeholder="A tiny moon rabbit with a leaf scarf…"
                  onChange={(e) => setPrompt(e.target.value)}
                />
              </Field>
              <p className="form-note">
                Only this description and style go to{' '}
                {current ? new URL(current.baseUrl).host : 'your image service'}. Each generation
                may incur a provider charge.
              </p>
              <div className="form-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!!busy || !prompt.trim()}
                  onClick={() => void generate()}
                >
                  <Sparkle size={17} />
                  {busy === 'generating'
                    ? 'Creating your character…'
                    : preview
                      ? 'Generate another'
                      : 'Generate character'}
                </button>
                {busy === 'generating' && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => controller.current?.abort()}
                  >
                    Stop generation
                  </button>
                )}
              </div>
              {busy === 'generating' && (
                <p role="status" className="form-note">
                  Creating one picture. Stopping keeps your current character; the provider may
                  still complete and charge for this request.
                </p>
              )}
            </>
          )}
          {preview && (
            <div className="generated-avatar-preview" ref={previewPanel}>
              <img src={preview.url} alt="Generated character preview" />
              <div>
                <p>Like this little face?</p>
                <p className="form-note">
                  Use it in your profile draft, then save when you’re ready.
                </p>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!!busy}
                  ref={usePicture}
                  onClick={async () => {
                    await onUse(preview.file);
                  }}
                >
                  Use this picture
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={!!busy}
                  onClick={() => {
                    URL.revokeObjectURL(previewURL.current);
                    previewURL.current = '';
                    setPreview(null);
                  }}
                >
                  Discard picture
                </button>
              </div>
            </div>
          )}
          {error && (
            <div role="alert" className="form-error">
              {error}
              <button
                type="button"
                className="text-button"
                disabled={!!busy}
                onClick={() => void load()}
              >
                Reload image settings
              </button>
            </div>
          )}
          {notice && (
            <p role="status" className="form-note">
              {notice}
            </p>
          )}
        </>
      )}
    </section>
  );
}
