import { useEffect, useRef, useState } from 'react';
import { ArrowClockwise } from '@phosphor-icons/react';
import { api } from '../api';

type Maintenance = {
  available: boolean;
  canUpdate: boolean;
  phase: string;
  busy: boolean;
  error: string;
  review: { id: string; kind: 'recover' | 'update' } | null;
};
export default function ComputerMaintenance({
  unavailable,
  onChanged,
}: {
  unavailable: boolean;
  onChanged: () => Promise<void>;
}) {
  const [state, setState] = useState<Maintenance | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (open && state?.review) panel.current?.scrollIntoView({ block: 'nearest' });
  }, [open, state?.review?.id]);
  useEffect(() => {
    if (unavailable) setOpen(true);
  }, [unavailable]);
  useEffect(() => {
    let closed = false,
      last = '';
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await api.request('/computer/maintenance');
        if (closed) return;
        setState(next);
        const changed = last !== next.phase;
        last = next.phase;
        if (['done', 'error'].includes(next.phase) && changed) await onChanged();
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
    // The page callback reads mutable refs; do not restart polling on every frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function action(kind: 'prepare' | 'apply' | 'cancel', body: object = {}) {
    if (working) return;
    setWorking(true);
    setError('');
    try {
      setState(
        await api.request(`/computer/maintenance/${kind}`, {
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
    <details className="computer-care" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <ArrowClockwise size={17} />
        {unavailable ? 'Computer recovery' : 'Computer care'}
      </summary>
      <section ref={panel} aria-label="Computer care">
        {(error || state.error) && <p role="alert">{error || state.error}</p>}
        {state.busy ? (
          <>
            <p role="status">
              {state.phase === 'applying'
                ? 'Refreshing your computer…'
                : 'Preparing the latest workspace…'}
            </p>
            <p>
              {state.phase === 'applying'
                ? 'Relay stays paused. Your saved files are kept.'
                : 'You can keep using the computer while this finishes.'}
            </p>
            {state.phase !== 'applying' && (
              <button
                className="text-button"
                disabled={working}
                onClick={() => void action('cancel')}
              >
                Cancel preparation
              </button>
            )}
          </>
        ) : state.review ? (
          <>
            <h3>
              {state.review.kind === 'update' ? 'Your update is ready' : 'Recover your computer?'}
            </h3>
            <p>
              Open apps and running jobs will close. Save any unfinished work first. Your saved
              files and browser profile stay in place.
            </p>
            <p>Relay will stay paused until you give control back.</p>
            <div className="computer-care-actions">
              <button
                className="primary-button"
                disabled={working}
                onClick={() => void action('apply', { id: state.review!.id })}
              >
                {state.review.kind === 'update' ? 'Restart & update' : 'Recover computer'}
              </button>
              <button
                className="text-button"
                disabled={working}
                onClick={() => void action('cancel')}
              >
                Not now
              </button>
            </div>
          </>
        ) : (
          <>
            {state.phase === 'current' && (
              <p role="status">
                Your computer has the latest workspace included with this Relay app.
              </p>
            )}
            {state.phase === 'done' && (
              <p role="status">
                Your computer is ready. Check your work, then give control back to Relay.
              </p>
            )}
            <div className="computer-care-actions">
              {state.canUpdate && (
                <button
                  className="secondary-button"
                  disabled={working}
                  onClick={() => void action('prepare', { kind: 'update' })}
                >
                  Check for updates
                </button>
              )}
              {(unavailable || state.phase === 'error') && (
                <button
                  className="secondary-button"
                  disabled={working}
                  onClick={() => void action('prepare', { kind: 'recover' })}
                >
                  Review recovery
                </button>
              )}
            </div>
            {!state.canUpdate && !unavailable && (
              <p>This computer’s software is managed by its server owner.</p>
            )}
          </>
        )}
      </section>
    </details>
  );
}
