import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
type Installation = {
  available?: boolean;
  busy?: boolean;
  cancellable?: boolean;
  bytes?: number;
  installation?: { id: string; phase: string; stage: string; completed: number; error: string };
};
const labels: Record<string, string> = {
  checking: 'Checking your Mac…',
  downloading: 'Downloading computer tools…',
  creating: 'Starting your private computer…',
  preparing: 'Preparing your workspace…',
  opening: 'Opening your computer…',
  cancelling: 'Finishing cancellation…',
};
export default function ComputerInstallation({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Installation | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (api.mode() !== 'server') {
      setStatus({});
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await api.request('/computer/installation');
        if (!alive) return;
        setStatus(next);
        if (next.installation?.phase === 'ready') await api.refresh();
      } catch {
        if (alive) setStatus({});
      }
      if (alive) timer = setTimeout(poll, 1500);
    }
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
  async function action(kind: 'start' | 'cancel') {
    if (working) return;
    setWorking(true);
    setError('');
    try {
      setStatus(
        await api.request(`/computer/installation/${kind}`, {
          method: 'POST',
          body: JSON.stringify({
            id: kind === 'start' ? crypto.randomUUID() : status?.installation?.id,
          }),
        }),
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  }
  if (!status) return <p role="status">Checking setup…</p>;
  if (!status.available && !status.busy) return children;
  const state = status.installation;
  return (
    <section className="computer-setup-flow" aria-label="Private computer setup">
      {status.busy ? (
        <>
          <p role="status">{labels[state?.stage || ''] || 'Preparing your computer…'}</p>
          {state?.stage === 'downloading' && (
            <progress
              aria-label="Computer tools download"
              value={state.completed}
              max={status.bytes}
            />
          )}
          <p className="computer-setup-note">
            First setup takes a few minutes. You can keep chatting and come back here.
          </p>
          {status.cancellable && (
            <button
              className="text-button"
              disabled={working}
              onClick={() => void action('cancel')}
            >
              Cancel setup
            </button>
          )}
        </>
      ) : (
        <>
          <p className="computer-setup-note">
            Give Relay its own computer for browsing, files and apps. We’ll set it up on your Mac.
          </p>
          {(error || state?.error) && <p role="alert">{error || state?.error}</p>}
          <button
            className="primary-button"
            disabled={working}
            onClick={() => void action('start')}
          >
            {working
              ? 'Starting setup…'
              : state && state.phase !== 'ready'
                ? 'Continue setup'
                : 'Set up computer'}
          </button>
          <p className="computer-setup-note">
            Needs 40 GB free. Uses 4 GB of memory while running.
          </p>
          <details className="computer-setup-note">
            <summary>About this setup</summary>
            <p>
              Downloads Colima, Lima and Docker tools, a Linux system and Relay’s workspace. The
              virtual disks can grow to 35 GB, plus downloads. Your Mac folders stay private. No
              administrator password is needed.
            </p>
            <p>
              Your workspace stays available when you close Relay. Setup and installation details
              stay on this page.
            </p>
          </details>
          {state?.phase === 'cancelled' && (
            <p role="status">Setup cancelled. Continue whenever you’re ready.</p>
          )}
        </>
      )}
    </section>
  );
}
