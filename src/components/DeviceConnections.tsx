import { useEffect, useState } from 'react';
import { Devices, Copy, Check } from '@phosphor-icons/react';
import { api } from '../api';
import { copyText } from '../copy-text';
type Device = { id: string; name: string; current: boolean; created: number; expires: number };
type Status = {
  available: boolean;
  server: string;
  pending: { id: string; expires: number } | null;
  devices: Device[];
};
export default function DeviceConnections() {
  const [status, setStatus] = useState<Status | null>(null);
  const [link, setLink] = useState<{ id: string; url: string; expires: number } | null>(null);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(false);
  useEffect(() => {
    let alive = true,
      timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await api.request('/device-links');
        if (!alive) return;
        setStatus(next);
        setLink((previous) =>
          previous && previous.id === next.pending?.id && previous.expires > Date.now()
            ? previous
            : null,
        );
      } catch (e: any) {
        if (alive) setError(e.message);
      }
      if (alive) timer = setTimeout(refresh, 2500);
    }
    void refresh();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
  async function action(path: string, create = false) {
    setBusy(true);
    setError('');
    setCopied(false);
    try {
      const result = await api.request(path, { method: 'POST', body: '{}' });
      if (create) setLink(result);
      else if (path.endsWith('/cancel')) setLink(null);
      setStatus(await api.request('/device-links'));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="settings-card" aria-label="Connected devices">
      <div className="settings-title">
        <Devices size={23} />
        <div>
          <h2>Connect another device</h2>
          <p>Your conversations, wherever you are.</p>
        </div>
      </div>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {!status ? (
        <p role="status">Checking your connection…</p>
      ) : status.available ? (
        <>
          <p className="form-note">
            Open the link in a browser, or paste it into Connect your devices in the Relay app. It
            grants full access to your chats, files and computer. Keep it for your own devices.
          </p>
          {link ? (
            <div className="device-link-result">
              <label className="field">
                <span>Connection link</span>
                <input value={link.url} readOnly autoComplete="off" spellCheck={false} />
              </label>
              <p className="form-note">
                One use · expires at{' '}
                {new Date(link.expires).toLocaleTimeString([], {
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </p>
              <div className="settings-actions">
                <button
                  className="primary-button"
                  onClick={() => {
                    setError('');
                    void copyText(link.url)
                      .then(() => setCopied(true))
                      .catch(() =>
                        setError(
                          'Select the link and copy it, then paste it on your other device.',
                        ),
                      );
                  }}
                >
                  {copied ? <Check size={17} /> : <Copy size={17} />}{' '}
                  {copied ? 'Copied' : 'Copy connection link'}
                </button>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => void action(`/device-links/${link.id}/cancel`)}
                >
                  Cancel link
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                className="primary-button"
                disabled={busy}
                onClick={() => void action('/device-links', true)}
              >
                {busy ? 'Creating…' : 'Create connection link'}
              </button>
              <p className="form-note">
                Expires in five minutes. A new link replaces any unused link.
              </p>
            </>
          )}
        </>
      ) : (
        <p className="form-note">
          Your Relay server needs a public HTTPS address and an owner access key before it can
          connect another device. Existing server-address sign-in remains available.
        </p>
      )}
      {!!status?.devices.length && (
        <div className="device-list">
          <h3>Connected with a link</h3>
          {status.devices.map((device) => (
            <div className="device-row" key={device.id}>
              <div>
                <strong>{device.name}</strong>
                <p>
                  {device.current
                    ? 'This device'
                    : `Connected ${new Date(device.created).toLocaleDateString()}`}
                </p>
              </div>
              {!device.current && (
                <button
                  className="text-button"
                  disabled={busy}
                  aria-label={`Disconnect ${device.name}`}
                  onClick={() => void action(`/devices/${device.id}/disconnect`)}
                >
                  Disconnect
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </article>
  );
}
