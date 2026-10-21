import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { InstallationState } from './LocalModelInstall';

export type QuickSetupState = {
  suggestion: { model: string; name: string; size: string; url: string };
  selection: string;
  job: null | {
    id: string;
    model: string;
    phase: string;
    step: string;
    error: string;
    connected: boolean;
    progress: null | { stage: string; completed: number; total: number };
  };
};
const stages: Record<string, string> = {
  checking: 'Checking your computer…',
  installing: 'Installing Ollama…',
  starting: 'Starting local AI…',
  'checking-model': 'Checking your model…',
  downloading: 'Downloading your model…',
  ready: 'Local AI is ready.',
};
const size = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);

export default function LocalModelQuickSetup({
  initial,
  installation,
  needsInstall,
  running,
  startWithRelay: initialStartup,
  onConnected,
  onOther,
  onBack,
}: {
  initial: QuickSetupState;
  installation: InstallationState;
  needsInstall: boolean;
  running: boolean;
  startWithRelay: boolean;
  onConnected: () => Promise<void>;
  onOther: () => void;
  onBack: () => void;
}) {
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  const [startup, setStartup] = useState(initialStartup);
  const mounted = useRef(true),
    observed = useRef(initial.job?.phase === 'running' ? initial.job.id : '');
  const connected = useRef(onConnected);
  connected.current = onConnected;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const job = state.job,
    working = job?.phase === 'running';
  async function receive(next: QuickSetupState) {
    if (!mounted.current) return;
    setState(next);
    setUncertain(false);
    if (next.job?.connected && observed.current === next.job.id) {
      observed.current = '';
      await connected.current();
    }
  }
  useEffect(() => {
    if (!working) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.request('/models/local/setup', { signal: controller.signal });
        if (controller.signal.aborted) return;
        setError('');
        await receive(next);
        if (next.job?.phase !== 'running') return;
      } catch {
        if (controller.signal.aborted) return;
        setError('Reconnecting to setup progress…');
      }
      timer = setTimeout(poll, 800);
    };
    timer = setTimeout(poll, 400);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [working]);
  async function action(kind: 'start' | 'cancel' | 'check') {
    setBusy(true);
    setError('');
    try {
      const id = kind === 'start' ? crypto.randomUUID() : job?.id;
      if (kind === 'start') observed.current = id!;
      const next = await api.request(
        `/models/local/setup${kind === 'check' ? '' : '/' + kind}`,
        kind === 'check'
          ? {}
          : {
              method: 'POST',
              body: JSON.stringify(
                kind === 'cancel'
                  ? { id }
                  : {
                      id,
                      model: state.suggestion.model,
                      selection: state.selection,
                      install: needsInstall,
                      startWithRelay: startup,
                    },
              ),
            },
      );
      await receive(next);
    } catch (e) {
      if (mounted.current) {
        setError(e instanceof Error ? e.message : 'Setup could not be updated.');
        // An interrupted response is not proof that the server rejected the action.
        try {
          await receive(await api.request('/models/local/setup'));
        } catch {
          if (mounted.current) setUncertain(true);
        }
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section className="local-model-setup local-model-quick" aria-label="Local model setup">
      <h2>A model on your computer</h2>
      <p className="form-note">
        Chat and work with AI running on your Relay computer. Your phone connects to it too.
      </p>
      <div className="local-model-pick">
        <strong>{state.suggestion.name}</strong>
        <span>
          {state.suggestion.size}
          {needsInstall ? ` + ${size(installation.bytes)} for Ollama` : ''}
        </span>
      </div>
      {working ? (
        <div className="local-model-download" aria-live="polite">
          <p role="status">{stages[job.step] || 'Setting up local AI…'}</p>
          {job.progress?.total ? (
            <>
              <progress
                aria-label="Local AI setup progress"
                value={job.progress.completed}
                max={job.progress.total}
              />
              <p className="form-note">
                {size(job.progress.completed)} of {size(job.progress.total)} · current file
              </p>
            </>
          ) : (
            <progress aria-label="Local AI setup progress" />
          )}
          <p className="form-note">You can leave this page. Setup continues while Relay is open.</p>
          <button className="text-button" disabled={busy} onClick={() => void action('cancel')}>
            Cancel setup
          </button>
        </div>
      ) : (
        <>
          {job?.phase === 'cancelled' && (
            <p role="status">
              Setup cancelled. Your AI connection is unchanged. Downloaded files are kept.
            </p>
          )}
          {job?.error && (
            <p role="alert" className="form-error">
              {job.error}
            </p>
          )}
          {job?.connected ? (
            <>
              <p role="status">Local AI is ready.</p>
              <button
                className="primary-button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError('');
                  try {
                    await onConnected();
                  } catch {
                    if (mounted.current)
                      setError(
                        'Reconnect to Relay, then try again. Your model is already connected.',
                      );
                  } finally {
                    if (mounted.current) setBusy(false);
                  }
                }}
              >
                Done
              </button>
            </>
          ) : (
            <>
              <p className="form-note">
                {needsInstall
                  ? 'Installs Ollama, downloads this model and connects it to your chat.'
                  : 'Starts Ollama if needed, downloads this model and connects it to your chat.'}
              </p>
              <button
                className="primary-button"
                disabled={busy}
                onClick={() => void action(uncertain ? 'check' : 'start')}
              >
                {busy
                  ? 'Preparing…'
                  : uncertain
                    ? 'Check progress'
                    : job && job.phase !== 'complete'
                      ? 'Continue setup'
                      : 'Set up & use'}
              </button>
            </>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {!working && (
        <details className="model-endpoint">
          <summary>Model &amp; setup details</summary>
          <p className="form-note">
            Supports chat, tools and images. Speed depends on your computer. Chats, files and tool
            results go to Ollama on your Relay computer.
          </p>
          <a className="text-link" href={state.suggestion.url} target="_blank" rel="noreferrer">
            Model details &amp; license
          </a>
          {needsInstall && (
            <p className="form-note">
              Ollama {installation.version} comes from its official release. Relay checks the
              download and keeps it in its own data folder.{' '}
              <a className="text-link" href={installation.details} target="_blank" rel="noreferrer">
                Release &amp; licenses
              </a>
            </p>
          )}
          {!running && (
            <label className="check-row">
              <input
                type="checkbox"
                checked={startup}
                disabled={busy}
                onChange={(e) => setStartup(e.target.checked)}
              />
              Start Ollama with Relay
            </label>
          )}
          <p className="form-note">
            When Relay starts Ollama, quitting Relay stops it. Completed downloads stay available.
          </p>
        </details>
      )}
      <div className="form-actions">
        {!working && (
          <button className="text-button" disabled={busy || uncertain} onClick={onOther}>
            Choose another model
          </button>
        )}
        <button className="text-button" disabled={busy} onClick={onBack}>
          Back
        </button>
      </div>
    </section>
  );
}
