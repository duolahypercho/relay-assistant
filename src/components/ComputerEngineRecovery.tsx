import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';

type Engine = {
  running?: boolean;
  canStart?: boolean;
  busy?: boolean;
  phase?: string;
  cancellable?: boolean;
  error?: string;
  profile?: string;
  managed?: boolean;
  intent?: string;
};
const progress: Record<string, string> = {
  checking: 'Checking your computer…',
  waking: 'Waking your computer…',
  preparing: 'Preparing your workspace…',
  opening: 'Opening your computer…',
  stopping: 'Closing apps and jobs…',
  sleeping: 'Putting your computer to sleep…',
};
export default function ComputerEngineRecovery({
  children,
  setup = false,
  onReady,
  onAvailable,
}: {
  children: ReactNode;
  setup?: boolean;
  onReady?: () => Promise<void>;
  onAvailable?: (available: boolean) => void;
}) {
  const [engine, setEngine] = useState<Engine | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const callbacks = useRef({ onReady, onAvailable });
  callbacks.current = { onReady, onAvailable };
  useEffect(() => {
    if (api.mode() !== 'server') return;
    // Runtime discovery owns the offline state while it resolves. Avoid
    // flashing a raw Docker error above the recovery control.
    callbacks.current.onAvailable?.(true);
    let alive = true,
      finished = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await api.request('/computer/engine');
        if (!alive) return;
        setEngine(next);
        callbacks.current.onAvailable?.(
          !!next.canStart || !!next.busy || (next.intent === 'stop' && !!next.error),
        );
        if (next.phase === 'ready' && !finished) {
          finished = true;
          await api.refresh();
          await callbacks.current.onReady?.();
        }
        if (next.busy) finished = false;
      } catch {
        // Keep the normal start/setup controls if this server has no recovery API.
        if (alive) {
          setEngine({});
          callbacks.current.onAvailable?.(false);
        }
      }
      if (alive) timer = setTimeout(poll, 1500);
    }
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
      callbacks.current.onAvailable?.(false);
    };
  }, []);
  async function action(kind: 'start' | 'cancel' | 'stop') {
    if (working) return;
    setWorking(true);
    setError('');
    try {
      const result = await api.request(
        kind === 'stop' ? '/computer/stop' : `/computer/engine/${kind}`,
        { method: 'POST', body: '{}' },
      );
      setEngine(kind === 'stop' ? await api.request('/computer/engine') : result);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  }
  if (!engine && api.mode() === 'server')
    return (
      <section className="computer-setup-flow" aria-label="Computer startup">
        <p role="status">Checking your computer…</p>
      </section>
    );
  if (!engine?.canStart && !engine?.busy && !engine?.error && engine?.phase !== 'cancelled')
    return children;
  return (
    <section className="computer-setup-flow" aria-label="Computer startup">
      {engine?.busy ? (
        <>
          <p role="status">{progress[engine.phase || ''] || 'Preparing your computer…'}</p>
          <p className="computer-setup-note">
            You can keep chatting. Progress will be here when you return.
          </p>
          {engine.cancellable && (
            <button
              className="text-button"
              disabled={working}
              onClick={() => void action('cancel')}
            >
              Cancel startup
            </button>
          )}
        </>
      ) : (
        <>
          <p className="computer-setup-note">
            {engine?.intent === 'stop' && engine.error
              ? 'Keep your files and finish putting this computer to sleep.'
              : engine?.running
                ? 'Your runtime is ready. Continue opening your workspace.'
                : engine?.canStart
                  ? engine.managed
                    ? 'Your private computer is asleep. Start it to pick up where you left off.'
                    : `Colima is asleep on your Relay server. Start its existing ${engine.profile} profile and keep your workspace.`
                  : 'Open the computer runtime on your Relay server, then try again.'}
          </p>
          {(error || engine?.error) && <p role="alert">{error || engine?.error}</p>}
          <button
            className="primary-button"
            disabled={working}
            onClick={() =>
              void action(engine?.intent === 'stop' && engine.error ? 'stop' : 'start')
            }
          >
            {working
              ? 'Working…'
              : engine?.intent === 'stop' && engine.error
                ? 'Try stopping again'
                : setup
                  ? 'Set up computer'
                  : 'Start computer'}
          </button>
          {engine?.intent === 'stop' && engine.error && (
            <button className="text-button" disabled={working} onClick={() => void action('start')}>
              Start computer instead
            </button>
          )}
          {engine?.phase === 'cancelled' && (
            <p role="status">
              {engine.managed
                ? 'Startup cancelled. Your private computer may still be running. Start it when you’re ready.'
                : 'Startup cancelled. Colima may still be running; Relay won’t stop a shared runtime.'}
            </p>
          )}
        </>
      )}
    </section>
  );
}
