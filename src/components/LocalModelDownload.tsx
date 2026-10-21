import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Field } from './ui';

export type DownloadState = {
  suggestion: { model: string; name: string; size: string; url: string };
  download: null | {
    id: string;
    model: string;
    phase: string;
    stage: string;
    completed: number;
    total: number;
    error: string;
  };
};
const bytes = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
export default function LocalModelDownload({
  initial,
  running,
  installed,
  onReady,
  onRunning,
}: {
  initial: DownloadState;
  running: boolean;
  installed: string[];
  onReady: (model: string) => void;
  onRunning: (value: boolean) => void;
}) {
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [custom, setCustom] = useState(false);
  const [model, setModel] = useState(initial.suggestion.model);
  const mounted = useRef(true);
  const ready = useRef(onReady);
  ready.current = onReady;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => setState(initial), [initial]);
  const job = state.download;
  const downloading = job?.phase === 'running';
  useEffect(() => {
    onRunning(downloading);
  }, [downloading, onRunning]);
  useEffect(() => {
    if (!downloading) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next: DownloadState = await api.request('/models/local/download', {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setState(next);
        setError('');
        if (next.download?.phase === 'ready') ready.current(next.download.model);
        if (next.download?.phase !== 'running') return;
      } catch {
        if (controller.signal.aborted) return;
        setError('Reconnecting to download progress…');
      }
      timer = setTimeout(poll, 800);
    };
    timer = setTimeout(poll, 500);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [downloading]);
  async function action(kind: 'start' | 'cancel', target = model) {
    setBusy(true);
    setError('');
    try {
      const next = await api.request(`/models/local/download/${kind}`, {
        method: 'POST',
        body: JSON.stringify(
          kind === 'start' ? { model: target, id: crypto.randomUUID() } : { id: job?.id },
        ),
      });
      if (mounted.current) setState(next);
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : 'Download could not be updated.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const content = (
    <>
      {downloading ? (
        <>
          <p>
            <strong>{job.model}</strong>
          </p>
          <p role="status">{job.stage}</p>
          {!!job.total && (
            <div>
              <progress aria-label="Current model file" value={job.completed} max={job.total} />
              <p className="form-note">
                {bytes(job.completed)} of {bytes(job.total)} · current file
              </p>
            </div>
          )}
          <p className="form-note">
            You can leave this page. The download continues while Relay and Ollama are running.
          </p>
          <button className="text-button" disabled={busy} onClick={() => void action('cancel')}>
            Cancel download
          </button>
        </>
      ) : (
        <>
          {job?.phase === 'ready' && (
            <p role="status">{job.model} is downloaded. Choose it above to use it.</p>
          )}
          {job?.phase === 'cancelled' && (
            <p role="status">Download cancelled. Ollama may keep downloaded parts for a retry.</p>
          )}
          {job?.error && (
            <p className="form-error" role="alert">
              {job.error}
            </p>
          )}
          {running && (
            <>
              <p>
                <strong>{state.suggestion.name}</strong> · {state.suggestion.size}
              </p>
              <p className="form-note">
                A local chat model with tools and image support. Downloads to your Relay computer;
                speed depends on its hardware.
              </p>
              <a className="text-link" href={state.suggestion.url} target="_blank" rel="noreferrer">
                Model details &amp; license
              </a>
              <div className="form-actions">
                {!installed.includes(state.suggestion.model) && (
                  <button
                    className="primary-button"
                    disabled={busy}
                    onClick={() => void action('start', state.suggestion.model)}
                  >
                    Download · {state.suggestion.size}
                  </button>
                )}
                {(job?.phase === 'error' ||
                  job?.phase === 'interrupted' ||
                  job?.phase === 'cancelled') &&
                  job.model !== state.suggestion.model && (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => void action('start', job.model)}
                    >
                      Retry {job.model}
                    </button>
                  )}
              </div>
              <button
                className="text-button"
                aria-expanded={custom}
                onClick={() => setCustom(!custom)}
              >
                Choose another Ollama model
              </button>
              {custom && (
                <div>
                  <Field label="Ollama model tag">
                    <input
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      placeholder="qwen3.5:4b"
                      maxLength={160}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                  </Field>
                  <p className="form-note">
                    Enter a local model from the Ollama library. Its size and hardware needs vary;
                    check its model page first.
                  </p>
                  <button
                    className="secondary-button"
                    disabled={busy || !model.trim()}
                    onClick={() => void action('start', model.trim())}
                  >
                    Download model
                  </button>
                </div>
              )}
              <p className="form-note">
                After downloading, choose Use this model to connect it. Your current model stays
                selected until then.
              </p>
            </>
          )}
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
  if (!running && !job) return null;
  return (
    <section className="local-model-download" aria-label="Download a local model">
      {installed.length && !downloading && !job?.error && job?.phase !== 'cancelled' ? (
        <details>
          <summary>Get another model</summary>
          {content}
        </details>
      ) : (
        content
      )}
    </section>
  );
}
