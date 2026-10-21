import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { Capacitor } from '@capacitor/core';
function takeLink() {
  if (!location.hash.startsWith('#connect=')) return null;
  const token = /^#connect=([A-Za-z0-9_-]{43})$/.exec(location.hash)?.[1] || '';
  history.replaceState(null, '', location.pathname + location.search + '#chat');
  return { token };
}
// Capture once outside React's StrictMode initializer: erase the fragment before
// mounting workspace listeners. The grant lives only in this document's memory.
let incoming = takeLink();
export default function DeviceLinkGate({ children }: { children: ReactNode }) {
  const [link, setLink] = useState(incoming);
  const [name, setName] = useState(
    Capacitor.isNativePlatform()
      ? Capacitor.getPlatform() === 'ios'
        ? 'My iPhone'
        : 'My Android'
      : 'My browser',
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    incoming = null;
    const changed = () => {
      const next = takeLink();
      if (next) {
        setLink(next);
        setError('');
      }
    };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  useEffect(() => {
    if (!link) void api.init();
  }, [link]);
  if (!link) return children;
  return (
    <main className="login-page">
      <section className="login-card" aria-label="Connect this device">
        <h1>Take your space with you.</h1>
        <p>
          Connect this browser to <strong>{location.origin}</strong>. This gives it full access to
          the workspace’s chats, files and computer.
        </p>
        {link.token ? (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              try {
                const res = await fetch('/api/device-links/redeem', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ token: link.token, name }),
                  redirect: 'error',
                  signal: AbortSignal.timeout(15000),
                });
                const body = await res.json().catch(() => ({}));
                if (!res.ok)
                  throw Error(
                    body.error ||
                      'This link could not connect. Create a new link on your connected device.',
                  );
                if (!(await api.init()))
                  throw Error('Reconnect to your workspace to finish signing in.');
                setLink(null);
              } catch (e: any) {
                setError(
                  e.name === 'TypeError' || e.name === 'TimeoutError'
                    ? 'Your server could not be reached. Try again when connected.'
                    : e.message,
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className="field">
              <span>Device name</span>
              <input
                required
                maxLength={60}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="off"
              />
            </label>
            {error && (
              <p className="inline-error" role="alert">
                {error}
              </p>
            )}
            <button className="primary-button" disabled={busy || !name.trim()}>
              {busy ? 'Connecting…' : 'Connect this device'}
            </button>
          </form>
        ) : (
          <p role="alert">
            This connection link is not valid. Create a new link on your connected device.
          </p>
        )}
        <button className="text-button" disabled={busy} onClick={() => setLink(null)}>
          Use normal sign-in
        </button>
      </section>
    </main>
  );
}
