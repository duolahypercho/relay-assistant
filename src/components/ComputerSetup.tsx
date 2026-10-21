import { useEffect, useState } from 'react';
import { api } from '../api';
import ComputerEngineRecovery from './ComputerEngineRecovery';
import ComputerInstallation from './ComputerInstallation';

const labels: Record<string, string> = {
  checking: 'Finding your computer…',
  preparing: 'Preparing your workspace…',
  finishing: 'Checking everything is ready…',
  ready: 'Your computer is ready.',
};
type Setup = { phase: string; available: boolean; busy: boolean; error?: string; code?: string };
export default function ComputerSetup() {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const server = api.mode() === 'server';
  useEffect(() => {
    if (!server) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await api.request('/computer/setup');
        if (stopped) return;
        setSetup(next);
        setError('');
        if (next.phase === 'ready') await api.refresh();
      } catch (e: any) {
        if (!stopped) setError(e.message);
      }
      if (!stopped) timer = setTimeout(() => void poll(), 1500);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [server]);
  async function action(kind: 'start' | 'cancel') {
    if (working) return;
    setWorking(true);
    setError('');
    try {
      setSetup(await api.request(`/computer/setup/${kind}`, { method: 'POST', body: '{}' }));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  }
  return (
    <ComputerEngineRecovery setup>
      <ComputerInstallation>
        <section className="computer-setup-flow" aria-label="Computer setup">
          {!server ? (
            <p>Connect to your Relay server to set up its computer.</p>
          ) : !setup ? (
            <p role="status">{error || 'Checking setup…'}</p>
          ) : !setup.available ? (
            <p>The server’s owner has turned off computer setup.</p>
          ) : setup.busy ? (
            <>
              <p role="status">{labels[setup.phase] || 'Preparing your computer…'}</p>
              <p className="computer-setup-note">
                First setup may take a few minutes. You can keep chatting while it finishes.
              </p>
              <button
                className="text-button"
                disabled={working}
                onClick={() => void action('cancel')}
              >
                Cancel setup
              </button>
            </>
          ) : (
            <>
              {(error || setup.error) && <p role="alert">{error || setup.error}</p>}
              {setup.code === 'install' && (
                <a
                  href="https://docs.docker.com/get-started/get-docker/"
                  target="_blank"
                  rel="noreferrer"
                >
                  Get Docker
                </a>
              )}
              <button
                className="primary-button"
                disabled={working || setup.phase === 'ready'}
                onClick={() => void action('start')}
              >
                {working
                  ? 'Starting setup…'
                  : setup.phase === 'ready'
                    ? 'Ready'
                    : setup.error
                      ? 'Try again'
                      : 'Set up computer'}
              </button>
              {!setup.error && (
                <p className="computer-setup-note">
                  Uses Docker or a running Colima on your Relay server. Setup downloads the
                  workspace once.
                </p>
              )}
              {setup.phase === 'cancelled' && (
                <p role="status">Setup cancelled. You can continue whenever you’re ready.</p>
              )}
            </>
          )}
        </section>
      </ComputerInstallation>
    </ComputerEngineRecovery>
  );
}
