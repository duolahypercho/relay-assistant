import ComputerBackupForm from './ComputerBackupForm';
import { useEffect, useRef, useState } from 'react';
import { ClockCounterClockwise } from '@phosphor-icons/react';
import { api } from '../api';
type Point = {
  id: string;
  created: string;
  label: string;
  bytes: number | null;
  files: number | null;
};
type SnapshotState = {
  available: boolean;
  busy: boolean;
  phase: string;
  error: string;
  canRetry: boolean;
  points: Point[];
  review: { id: string; kind: 'restore' | 'remove' | 'fresh'; point: Point | null } | null;
};
const date = (point: Point) =>
  new Date(point.created).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export default function ComputerSnapshots({
  onChanged,
  missing = false,
}: {
  onChanged: () => Promise<void>;
  missing?: boolean;
}) {
  const [state, setState] = useState<SnapshotState | null>(null),
    [error, setError] = useState(''),
    [working, setWorking] = useState(false);
  const [open, setOpen] = useState(false),
    [done, setDone] = useState('');
  const review = useRef<HTMLElement>(null);
  const [backup, setBackup] = useState<{ kind: 'export' | 'import'; pointId?: string } | null>(
    null,
  );
  useEffect(() => {
    if (state?.canRetry || missing) setOpen(true);
  }, [state?.canRetry, missing]);
  useEffect(() => {
    if (open && (state?.review || state?.canRetry))
      review.current?.scrollIntoView({ block: 'nearest' });
  }, [open, state?.review?.id, state?.canRetry]);
  useEffect(() => {
    let closed = false,
      last = '',
      timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await api.request('/computer/snapshots');
        if (closed) return;
        setState(next);
        if (next.phase !== last && ['done', 'error'].includes(next.phase)) await onChanged();
        last = next.phase;
      } catch (e: any) {
        if (!closed) setError(e.message);
      }
      if (!closed) timer = setTimeout(() => void poll(), 1500);
    }
    void poll();
    return () => {
      closed = true;
      clearTimeout(timer);
    };
  }, []);
  async function act(action: string, body: object = {}) {
    if (working) return;
    setWorking(true);
    setError('');
    if (action === 'save') setDone('Restore point saved. Your computer is ready to use.');
    if (action === 'apply')
      setDone(
        state?.review?.kind === 'remove'
          ? 'Restore point removed.'
          : state?.review?.kind === 'fresh'
            ? 'Your new empty workspace is ready. Relay stays paused until you give control back.'
            : 'Your workspace is restored. Check your work, then give control back to Relay.',
      );
    try {
      setState(
        await api.request(`/computer/snapshots/${action}`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  }
  if (!state?.available) return null;
  return (
    <details
      className="computer-care computer-snapshots"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        <ClockCounterClockwise size={17} />
        {missing ? 'Recover your workspace' : 'Restore points'}
      </summary>
      <section ref={review} aria-label="Restore points">
        {!backup && (error || state.error) && <p role="alert">{error || state.error}</p>}
        {backup ? (
          <ComputerBackupForm
            kind={backup.kind}
            pointId={backup.pointId}
            onClose={() => {
              setBackup(null);
              setError('');
              if (!state.busy) void act('cancel');
            }}
            onImported={(pointId) => {
              setBackup(null);
              setDone('');
              void act('prepare', { kind: 'restore', pointId });
            }}
          />
        ) : state.busy ? (
          <p role="status">
            {state.phase === 'saving'
              ? 'Saving your restore point…'
              : state.phase === 'restoring'
                ? 'Restoring your workspace…'
                : state.phase === 'removing'
                  ? 'Removing restore point…'
                  : state.phase === 'exporting'
                    ? 'Preparing your computer backup…'
                    : state.phase === 'importing'
                      ? 'Importing your computer backup…'
                      : 'Finishing the interrupted operation…'}
          </p>
        ) : state.review ? (
          <>
            <h3>
              {state.review.kind === 'remove'
                ? 'Remove this restore point?'
                : state.review.kind === 'fresh'
                  ? 'Start a new empty workspace?'
                  : 'Return to this restore point?'}
            </h3>
            {state.review.point && (
              <p>
                <strong>{date(state.review.point)}</strong> · {state.review.point.label}
              </p>
            )}
            <p>
              {state.review.kind === 'remove'
                ? 'This saved copy will be removed permanently. Your current workspace stays as it is.'
                : state.review.kind === 'fresh'
                  ? 'This opens an empty computer. It does not recover the missing files. Your chats and saved restore points stay, and Relay remains paused.'
                  : 'Open apps and jobs will close. Saved files and the browser profile return to this point. Unsaved work will be lost.'}
            </p>
            {state.review.kind === 'restore' && (
              <p>
                Any current saved files will be kept in a “Before restore” point. Chat history stays
                as it is. Relay stays paused until you give control back.
              </p>
            )}
            <div className="computer-care-actions">
              <button
                className="primary-button"
                disabled={working}
                onClick={() => void act('apply', { id: state.review!.id })}
              >
                {state.review.kind === 'remove'
                  ? 'Remove restore point'
                  : state.review.kind === 'fresh'
                    ? 'Start empty workspace'
                    : 'Restore workspace'}
              </button>
              <button className="text-button" disabled={working} onClick={() => void act('cancel')}>
                Not now
              </button>
            </div>
          </>
        ) : state.canRetry ? (
          <button className="secondary-button" disabled={working} onClick={() => void act('retry')}>
            Finish interrupted operation
          </button>
        ) : (
          <>
            {state.phase === 'done' && done && <p role="status">{done}</p>}
            {!missing && (
              <p>
                Save your files and browser profile so you can return to them later. The desktop
                briefly pauses; open apps stay open. Unsaved work is not included.
              </p>
            )}
            {!missing && (
              <button
                className="secondary-button"
                disabled={working}
                onClick={() => void act('save')}
              >
                Save restore point
              </button>
            )}
            <div className="computer-care-actions computer-backup-actions">
              {!missing && (
                <button
                  className="text-button"
                  disabled={working}
                  onClick={() => {
                    setDone('');
                    setBackup({ kind: 'export' });
                  }}
                >
                  Save backup to a file
                </button>
              )}
              <button
                className="text-button"
                disabled={working}
                onClick={() => {
                  setDone('');
                  setBackup({ kind: 'import' });
                }}
              >
                Import backup
              </button>
              {missing && (
                <button
                  className="secondary-button"
                  disabled={working}
                  onClick={() => void act('prepare', { kind: 'fresh' })}
                >
                  Start a new empty workspace
                </button>
              )}
            </div>
            {state.points.length ? (
              <ul className="computer-snapshot-list">
                {state.points.map((point) => (
                  <li key={point.id}>
                    <div>
                      <strong>{date(point)}</strong>
                      <span>
                        {point.label}
                        {point.bytes !== null
                          ? ` · ${(point.bytes / 1024 / 1024).toFixed(1)} MB`
                          : ''}
                      </span>
                    </div>
                    <div className="computer-care-actions">
                      <button
                        className="text-button"
                        disabled={working}
                        aria-label={`Back up restore point ${point.label}, ${date(point)}`}
                        onClick={() => setBackup({ kind: 'export', pointId: point.id })}
                      >
                        Back up
                      </button>
                      <button
                        className="text-button"
                        disabled={working}
                        aria-label={`Review restore point ${point.label}, ${date(point)}`}
                        onClick={() => void act('prepare', { kind: 'restore', pointId: point.id })}
                      >
                        Restore
                      </button>
                      <button
                        className="text-button"
                        disabled={working}
                        aria-label={`Review removal of restore point ${point.label}, ${date(point)}`}
                        onClick={() => void act('prepare', { kind: 'remove', pointId: point.id })}
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No restore points yet.</p>
            )}
            <small>
              Stored on this computer’s Docker engine. Keep a separate portable backup to recover a
              lost disk or engine.
            </small>
          </>
        )}
      </section>
    </details>
  );
}
