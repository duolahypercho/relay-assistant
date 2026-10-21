import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, StopCircle, Terminal } from '@phosphor-icons/react';
import { api } from '../api';
import { useWorkspace } from '../context';
import './computer-jobs.css';

type Job = {
  id: string;
  title: string;
  command?: string;
  cwd?: string;
  seconds?: number;
  pty?: boolean;
  status: string;
  error?: string;
  createdAt?: string;
  result?: { stdout?: string; stderr?: string; exitCode?: number | null; truncated?: boolean };
};
const active = new Set(['starting', 'running', 'paused', 'uncertain']);
const labels: Record<string, string> = {
  starting: 'Starting',
  running: 'Working',
  paused: 'Paused while you’re in control',
  uncertain: 'Checking the existing job',
  completed: 'Finished',
  failed: 'Failed',
  timed_out: 'Time limit reached',
  cancelled: 'Stopped',
  interrupted: 'Interrupted',
  expired: 'Older result removed',
};
function useJobs(id?: string) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const revision = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    async function refresh() {
      const version = revision.current;
      try {
        if (!document.hidden) {
          const result = await api.request(
            '/computer/jobs' + (id ? `/${encodeURIComponent(id)}` : ''),
          );
          if (!stopped && version === revision.current) {
            setJobs(id ? [result] : result.jobs);
            setError('');
          }
        }
      } catch (e: any) {
        if (!stopped && version === revision.current) setError(e.message);
      }
      if (!stopped) timer = setTimeout(() => void refresh(), 3000);
    }
    void refresh();
    return () => {
      stopped = true;
      alive.current = false;
      clearTimeout(timer);
    };
  }, [id]);
  async function stop(jobId: string) {
    if (busy) return;
    revision.current++;
    setBusy(jobId);
    setError('');
    try {
      const result = await api.request(`/computer/jobs/${encodeURIComponent(jobId)}/stop`, {
        method: 'POST',
        body: '{}',
      });
      if (alive.current)
        setJobs((previous) => previous.map((job) => (job.id === result.id ? result : job)));
    } catch (e: any) {
      if (alive.current) setError(e.message);
    } finally {
      if (alive.current) {
        revision.current++;
        setBusy('');
      }
    }
  }
  return { jobs, error, busy, stop };
}
function JobInput({ job }: { job: Job }) {
  const fieldId = useId();
  const storageKey = `relay.computer-input.${job.id}`;
  const [saved] = useState(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(storageKey) || '{}');
      return {
        text: typeof value.text === 'string' ? value.text.slice(0, 4000) : '',
        attempt:
          typeof value.attempt?.data === 'string' &&
          value.attempt.data.length <= 4096 &&
          /^[a-zA-Z0-9-]{1,120}$/.test(value.attempt.operationId)
            ? (value.attempt as { data: string; operationId: string })
            : null,
      };
    } catch {
      return { text: '', attempt: null };
    }
  });
  const [text, setText] = useState(saved.text);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const attempt = useRef<{ data: string; operationId: string } | null>(saved.attempt);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function send(data: string, clear = false) {
    if (busy || job.status !== 'running') return;
    if (new TextEncoder().encode(data).length > 4096) {
      setError('Send a shorter line (up to 4 KB).');
      return;
    }
    if (attempt.current?.data !== data)
      attempt.current = { data, operationId: crypto.randomUUID() };
    try {
      sessionStorage.setItem(storageKey, JSON.stringify({ text, attempt: attempt.current }));
    } catch {
      setError(
        'This tab could not save the input receipt. Free some browser storage before sending.',
      );
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await api.request(`/computer/jobs/${encodeURIComponent(job.id)}/input`, {
        method: 'POST',
        body: JSON.stringify(attempt.current),
      });
      if (alive.current) {
        attempt.current = null;
        if (clear) setText('');
        try {
          sessionStorage.setItem(
            storageKey,
            JSON.stringify({ text: clear ? '' : text, attempt: null }),
          );
        } catch {
          /* Receipt already confirmed. */
        }
        setMessage('Input sent. Watch the output for the result.');
      }
    } catch (e: any) {
      if (alive.current) setError(e.message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const disabled = busy || job.status !== 'running';
  return (
    <div className="computer-job-input">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send(text + '\n', true);
        }}
      >
        <label htmlFor={fieldId}>Reply to this program</label>
        <div>
          <input
            id={fieldId}
            value={text}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            maxLength={4000}
            placeholder="Type a reply…"
            onChange={(event) => {
              setText(event.target.value);
              try {
                sessionStorage.setItem(
                  storageKey,
                  JSON.stringify({ text: event.target.value, attempt: attempt.current }),
                );
              } catch {
                /* Sending requires a saved receipt. */
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault();
            }}
          />
          <button className="secondary-button" disabled={disabled} type="submit">
            {busy ? 'Sending…' : 'Send input'}
          </button>
        </div>
      </form>
      <div className="computer-job-actions">
        <button
          type="button"
          className="text-button"
          disabled={disabled}
          onClick={() => void send('\u0003')}
        >
          Interrupt
        </button>
        <button
          type="button"
          className="text-button"
          disabled={disabled}
          onClick={() => void send('\u0004')}
        >
          Finish input
        </button>
      </div>
      {job.status === 'paused' && (
        <p className="muted">Give control back to Relay to reply to this program.</p>
      )}
      {error && <p role="alert">{error}</p>}
      <p aria-live="polite">{message}</p>
    </div>
  );
}
function Result({ job }: { job: Job }) {
  useEffect(() => {
    if (job.pty && !active.has(job.status)) {
      try {
        sessionStorage.removeItem(`relay.computer-input.${job.id}`);
      } catch {
        /* Nothing to clear. */
      }
    }
  }, [job.id, job.status, job.pty]);
  return (
    <div className="computer-job-result">
      {job.error && <p>{job.error}</p>}
      {(job.result?.stdout || job.result?.stderr) && (
        <pre aria-label={`Output for ${job.title}`}>
          {job.result.stdout}
          {job.result.stderr ? '\n' + job.result.stderr : ''}
        </pre>
      )}
      {job.result?.truncated && (
        <p className="muted">Showing the latest output. Earlier output exceeded the log limit.</p>
      )}
      {job.result?.exitCode != null && <p className="muted">Exit code {job.result.exitCode}</p>}
      {job.pty && active.has(job.status) && <JobInput job={job} />}
      {(job.command || job.cwd) && (
        <details className="computer-job-command">
          <summary>Command details</summary>
          {job.command && (
            <p>
              <code>{job.command}</code>
            </p>
          )}
          {job.cwd && (
            <p className="muted">
              Folder: {job.cwd} · Limit: {job.seconds}s
            </p>
          )}
        </details>
      )}
    </div>
  );
}
export function ComputerJobCard({ id, title }: { id: string; title: string }) {
  const { go } = useWorkspace();
  const { jobs, error, busy, stop } = useJobs(id);
  const job = jobs[0];
  return (
    <section className="computer-job-card" aria-label={`Computer job: ${title}`} data-job-id={id}>
      <div className="computer-job-heading">
        <Terminal size={19} />
        <strong>{job?.title || title}</strong>
      </div>
      <p role="status">{job ? labels[job.status] || job.status : 'Checking progress…'}</p>
      {job && (
        <details>
          <summary>Details & output</summary>
          <Result job={job} />
        </details>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="computer-job-actions">
        <button className="text-button" onClick={() => go('computer')}>
          Open computer <ArrowRight size={15} />
        </button>
        {job && active.has(job.status) && (
          <button className="text-button" disabled={!!busy} onClick={() => void stop(id)}>
            <StopCircle size={16} />
            {busy ? 'Stopping…' : 'Stop job'}
          </button>
        )}
      </div>
    </section>
  );
}
export default function ComputerJobs() {
  const { jobs, error, busy, stop } = useJobs();
  if (!jobs.length && !error) return null;
  return (
    <section className="computer-job-list" aria-label="Background computer jobs">
      <h3>Background work</h3>
      <p className="muted">
        Jobs can keep running when Relay closes. Stop the computer to stop all work.
      </p>
      {error && <p role="alert">{error}</p>}
      {jobs.map((job) => (
        <div className="computer-job-row" key={job.id}>
          <details>
            <summary>
              <strong>{job.title}</strong>
              <span>{labels[job.status] || job.status}</span>
            </summary>
            <Result job={job} />
          </details>
          {active.has(job.status) && (
            <button
              className="text-button"
              disabled={!!busy}
              aria-label={`Stop ${job.title}`}
              onClick={() => void stop(job.id)}
            >
              {busy === job.id ? 'Stopping…' : 'Stop'}
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
