import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

export type InstallationState = {
  supported: boolean;
  version: string;
  bytes: number;
  details: string;
  installation: null | {
    id: string;
    phase: string;
    stage: string;
    completed: number;
    error: string;
  };
};
const megabytes = (n: number) => `${Math.round(n / 1e6)} MB`;
export default function LocalModelInstall({
  initial,
  onReady,
  onRunning,
}: {
  initial: InstallationState;
  onReady: () => void;
  onRunning: (running: boolean) => void;
}) {
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true),
    ready = useRef(onReady);
  ready.current = onReady;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => setState(initial), [initial]);
  const job = state.installation,
    running = job?.phase === 'running';
  useEffect(() => {
    onRunning(running);
  }, [running, onRunning]);
  useEffect(() => {
    if (!running) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next: InstallationState = await api.request('/models/local/installation', {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setState(next);
        setError('');
        if (next.installation?.phase === 'ready') ready.current();
        if (next.installation?.phase !== 'running') return;
      } catch {
        if (controller.signal.aborted) return;
        setError('Reconnecting to installation progress…');
      }
      timer = setTimeout(poll, 800);
    };
    timer = setTimeout(poll, 500);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [running]);
  async function action(kind: 'start' | 'cancel') {
    setBusy(true);
    setError('');
    try {
      const next = await api.request(`/models/local/installation/${kind}`, {
        method: 'POST',
        body: JSON.stringify({ id: kind === 'start' ? crypto.randomUUID() : job?.id }),
      });
      if (mounted.current) {
        setState(next);
        if (next.installation?.phase === 'ready') ready.current();
      }
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : 'Installation could not be updated.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section className="local-model-download" aria-label="Install local AI">
      {running ? (
        <>
          <p role="status">{job.stage}</p>
          <progress aria-label="Ollama installation" value={job.completed} max={state.bytes} />
          <p className="form-note">
            {megabytes(job.completed)} of {megabytes(state.bytes)}
          </p>
          <p className="form-note">
            You can leave this page. Installation continues while Relay is open.
          </p>
          <button className="text-button" disabled={busy} onClick={() => void action('cancel')}>
            Cancel installation
          </button>
        </>
      ) : (
        <>
          <p>
            <strong>Get Ollama</strong>
          </p>
          <p className="form-note">
            Run AI on your Relay computer. Install Ollama here, then choose a model.
          </p>
          {job?.phase === 'cancelled' && <p role="status">Installation cancelled.</p>}
          {job?.error && (
            <p className="form-error" role="alert">
              {job.error}
            </p>
          )}
          <button className="primary-button" disabled={busy} onClick={() => void action('start')}>
            {busy
              ? 'Preparing…'
              : job && job.phase !== 'ready'
                ? 'Retry installation'
                : `Install Ollama · ${megabytes(state.bytes)}`}
          </button>
          <details className="model-endpoint">
            <summary>About this installation</summary>
            <p className="form-note">
              Ollama {state.version} is downloaded from its official release and checked before
              installation in Relay’s data folder. Model downloads come next.
            </p>
            <a className="text-link" href={state.details} target="_blank" rel="noreferrer">
              Release &amp; licenses
            </a>
          </details>
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
