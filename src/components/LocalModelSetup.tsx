import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Field } from './ui';
import ModelAbilitySummary from './ModelAbilitySummary';
import LocalModelDownload, { type DownloadState } from './LocalModelDownload';
import LocalModelInstall, { type InstallationState } from './LocalModelInstall';
import LocalModelQuickSetup, { type QuickSetupState } from './LocalModelQuickSetup';

type Service = {
  preset: string;
  name: string;
  baseUrl: string;
  status: 'ready' | 'empty' | 'unavailable';
  models: { id: string; name: string }[];
  more: boolean;
};
type Saved = { id: string; baseUrl: string; protocol: string; model: string };
type Runtime = {
  available: boolean;
  installed: boolean;
  running: boolean;
  managed: boolean;
  canStart: boolean;
  occupied: boolean;
  busy: boolean;
  phase: string;
  error: string;
  revision: number;
  startWithRelay: boolean;
};
export default function LocalModelSetup({
  saved,
  onConnected,
  onCancel,
  onManual,
}: {
  saved: Saved[];
  onConnected: () => Promise<void>;
  onCancel: () => void;
  onManual: () => void;
}) {
  const [services, setServices] = useState<Service[]>([]);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [startWithRelay, setStartWithRelay] = useState(true);
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState('');
  const [downloads, setDownloads] = useState<DownloadState | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [installation, setInstallation] = useState<InstallationState | null>(null);
  const [installing, setInstalling] = useState(false);
  const [setup, setSetup] = useState<QuickSetupState | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const preferred = useRef('');
  const startup = useRef<AbortController | null>(null);
  useEffect(() => () => startup.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setServices([]);
    setSelected('');
    api
      .request('/models/local', { method: 'POST', body: '{}', signal: controller.signal })
      .then(
        (result: {
          services: Service[];
          runtime?: Runtime;
          downloads?: DownloadState;
          installation?: InstallationState;
          setup?: QuickSetupState;
        }) => {
          if (controller.signal.aborted) return;
          setServices(result.services);
          setSetup(result.setup || null);
          setRuntime(result.runtime || null);
          setDownloads(result.downloads || null);
          setInstallation(result.installation || null);
          setInstalling(result.installation?.installation?.phase === 'running');
          if (result.runtime)
            setStartWithRelay(
              result.runtime.revision === 0 && !result.runtime.running
                ? true
                : result.runtime.startWithRelay,
            );
          const choices = result.services.flatMap((s) =>
            s.models.map((m) => JSON.stringify([s.preset, m.id])),
          );
          const downloaded =
            preferred.current ||
            (result.downloads?.download?.phase === 'ready' ? result.downloads.download.model : '');
          const preferredChoice = JSON.stringify(['ollama', downloaded]);
          setSelected(
            choices.includes(preferredChoice)
              ? preferredChoice
              : choices.length === 1
                ? choices[0]
                : '',
          );
          preferred.current = '';
        },
      )
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [attempt]);
  useEffect(() => {
    if (!runtime?.busy) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void api
        .request('/models/local/runtime', { signal: controller.signal })
        .then((next: Runtime) => {
          if (controller.signal.aborted) return;
          setRuntime(next);
          if (!next.busy) setAttempt((value) => value + 1);
        })
        .catch(() => {});
    }, 800);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [runtime?.busy]);
  async function startOllama() {
    if (!runtime) return;
    const controller = new AbortController();
    startup.current = controller;
    setStarting(true);
    setError('');
    setNotice('');
    try {
      const result = await api.request('/models/local/start', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({ revision: runtime.revision, startWithRelay }),
      });
      if (!controller.signal.aborted) {
        setRuntime(result);
        setNotice('');
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setError(error instanceof Error ? error.message : 'Ollama could not start.');
      else setNotice('Startup cancelled. Your model selection is unchanged.');
    } finally {
      if (startup.current === controller) {
        startup.current = null;
        setStarting(false);
        setAttempt((value) => value + 1);
      }
    }
  }
  const choices = services.flatMap((s) =>
    s.models.map((m) => ({ ...m, service: s, value: JSON.stringify([s.preset, m.id]) })),
  );
  const choice = choices.find((c) => c.value === selected);
  const offerInstall =
    !!installation?.supported && !runtime?.installed && !runtime?.running && !choices.length;
  const existingChoice =
    choice &&
    saved.find(
      (c) => c.baseUrl === choice.service.baseUrl && c.protocol === 'chat' && c.model === choice.id,
    );
  if (
    !loading &&
    setup &&
    installation &&
    (setup.job?.phase === 'running' ||
      (!advanced &&
        !choices.length &&
        !runtime?.busy &&
        installation.installation?.phase !== 'running' &&
        downloads?.download?.phase !== 'running' &&
        (installation.supported || runtime?.canStart || runtime?.running)))
  ) {
    return (
      <LocalModelQuickSetup
        initial={setup}
        installation={installation}
        needsInstall={!runtime?.installed && !runtime?.running}
        running={!!runtime?.running}
        startWithRelay={startWithRelay}
        onConnected={onConnected}
        onBack={onCancel}
        onOther={() => {
          setAdvanced(true);
          setAttempt((value) => value + 1);
        }}
      />
    );
  }
  return (
    <section className="local-model-setup" aria-label="Local model setup">
      <h2>A model on your computer</h2>
      <p className="form-note">
        Find Ollama or LM Studio on the computer running Relay. On your phone, this still means your
        Relay server.
      </p>
      {loading ? (
        <p role="status">Looking for local models…</p>
      ) : (
        <>
          {choices.length ? (
            <Field label="Local model">
              <select
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                disabled={saving}
              >
                <option value="" disabled>
                  Choose a model
                </option>
                {choices.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.name} · {c.service.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            !error &&
            !offerInstall && (
              <p className="local-model-empty" role="status">
                {runtime?.canStart
                  ? 'Ollama is installed and ready to start.'
                  : downloads && services.some((s) => s.preset === 'ollama' && s.status === 'empty')
                    ? 'Ollama is ready. Download a model to get started.'
                    : 'No local models found. Open Ollama or LM Studio on your Relay computer, load a chat model, then check again.'}
              </p>
            )
          )}
          {!!choices.length && (
            <p className="form-note">
              Choose a chat model with tool calling for assistant actions. Reading images and the
              computer screen also needs vision.
            </p>
          )}
          {services.some((s) => s.status === 'empty' && !(downloads && s.preset === 'ollama')) && (
            <p className="form-note">
              {`${services
                .filter((s) => s.status === 'empty' && !(downloads && s.preset === 'ollama'))
                .map((s) => s.name)
                .join(
                  ' and ',
                )} ${services.filter((s) => s.status === 'empty').length > 1 ? 'are' : 'is'} running with no models listed.`}
            </p>
          )}
          {services.some((s) => s.more) && (
            <p className="form-note">
              Showing the first model page. Use connection details to enter another model ID.
            </p>
          )}
          {choice && (
            <p className="model-destination">
              Your chats, files and tool results will go to {choice.service.name} on your Relay
              computer when you send a message.
            </p>
          )}
          {choice && (
            <ModelAbilitySummary
              connection={
                existingChoice
                  ? { id: existingChoice.id }
                  : {
                      preset: choice.service.preset,
                      baseUrl: choice.service.baseUrl,
                      protocol: 'chat',
                      model: choice.id,
                      apiKey: '',
                    }
              }
            />
          )}
        </>
      )}
      {!loading && offerInstall && installation && (
        <LocalModelInstall
          initial={installation}
          onRunning={setInstalling}
          onReady={() => {
            setInstalling(false);
            setAttempt((value) => value + 1);
          }}
        />
      )}
      {!loading && runtime?.available && (runtime.installed || runtime.startWithRelay) && (
        <div className="local-model-runtime">
          {runtime.running ? (
            <p className="form-note">
              {runtime.managed ? 'Ollama is running with Relay.' : 'Ollama is already running.'}
            </p>
          ) : !starting && !runtime.busy && runtime.occupied ? (
            <p className="form-note">
              Ollama’s local port is in use. Open Ollama on the Relay computer, then check again.
            </p>
          ) : null}
          {runtime.canStart && !starting && (
            <button className="primary-button" disabled={saving} onClick={() => void startOllama()}>
              Start Ollama
            </button>
          )}
          {(starting || runtime.busy) && <p role="status">Starting Ollama…</p>}
          {starting && (
            <button className="text-button" onClick={() => startup.current?.abort()}>
              Cancel start
            </button>
          )}
          <details className="model-endpoint" open={!runtime.running}>
            <summary>Startup options</summary>
            <label className="check-row">
              <input
                type="checkbox"
                checked={startWithRelay}
                disabled={saving || starting || runtime.busy}
                onChange={async (e) => {
                  const value = e.target.checked;
                  setStartWithRelay(value);
                  if (!runtime.running && runtime.revision === 0) {
                    setStartWithRelay(value);
                    return;
                  }
                  setSaving(true);
                  setError('');
                  try {
                    const result = await api.request('/models/local/preference', {
                      method: 'POST',
                      body: JSON.stringify({ revision: runtime.revision, startWithRelay: value }),
                    });
                    setRuntime(result);
                    setStartWithRelay(result.startWithRelay);
                  } catch (error) {
                    setStartWithRelay(runtime.startWithRelay);
                    setError(
                      error instanceof Error
                        ? error.message
                        : 'Startup settings could not be saved.',
                    );
                  } finally {
                    setSaving(false);
                  }
                }}
              />
              Start Ollama with Relay
            </label>
            <p className="form-note">
              Uses models already installed on your Relay computer. When Relay starts Ollama,
              quitting Relay stops it.
            </p>
          </details>
          {runtime.error && !error && (
            <p role="alert" className="form-error">
              {runtime.error}
            </p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {!loading && downloads && (
        <LocalModelDownload
          initial={downloads}
          onRunning={setDownloading}
          running={
            !!runtime?.running ||
            services.some((s) => s.preset === 'ollama' && s.status !== 'unavailable')
          }
          installed={services.find((s) => s.preset === 'ollama')?.models.map((m) => m.id) || []}
          onReady={(model) => {
            preferred.current = model;
            setAttempt((value) => value + 1);
          }}
        />
      )}
      {notice && (
        <p className="form-note" role="status">
          {notice}
        </p>
      )}
      <div className="form-actions">
        {choice && (
          <button
            className="primary-button"
            disabled={saving || loading || starting || runtime?.busy}
            onClick={async () => {
              setSaving(true);
              setError('');
              try {
                const existing = saved.find(
                  (c) =>
                    c.baseUrl === choice.service.baseUrl &&
                    c.protocol === 'chat' &&
                    c.model === choice.id,
                );
                await api.request(existing ? '/models/select' : '/models/save', {
                  method: 'POST',
                  body: JSON.stringify(
                    existing
                      ? { id: existing.id }
                      : {
                          name: `${choice.service.name} · ${choice.id}`.slice(0, 80),
                          preset: choice.service.preset,
                          baseUrl: choice.service.baseUrl,
                          protocol: 'chat',
                          model: choice.id,
                          apiKey: '',
                          activate: true,
                        },
                  ),
                });
                await onConnected();
              } catch (e) {
                setError(e instanceof Error ? e.message : 'The model could not be connected.');
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? 'Connecting…' : 'Use this model'}
          </button>
        )}
        {!loading && (
          <button
            className="text-button"
            disabled={saving || starting || runtime?.busy}
            onClick={() => {
              setError('');
              setNotice('');
              setAttempt((value) => value + 1);
            }}
          >
            Check again
          </button>
        )}
        <button
          className="text-button"
          disabled={saving}
          onClick={() => {
            startup.current?.abort();
            onCancel();
          }}
        >
          {downloading || installing ? 'Back' : 'Cancel'}
        </button>
      </div>
      <button className="text-button" disabled={saving || starting} onClick={onManual}>
        Enter connection details
      </button>
    </section>
  );
}
