import { useEffect, useRef, useState } from 'react';
import { Globe, ArrowRight } from '@phosphor-icons/react';
import { api } from '../api';
import { useWorkspace } from '../context';
import './computer-websites.css';

type Site = { host: string; url: string; status: string; reason: string; expires: number };
export type ComputerWeb = {
  enabled?: boolean;
  connected?: boolean;
  error?: string;
  sites?: Site[];
  revision?: number;
};
export function WebsitePermission({ host, runId }: { host: string; runId?: string }) {
  const { go, s } = useWorkspace();
  const [site, setSite] = useState<Site>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [resumed, setResumed] = useState(false);
  const [resumeStatus, setResumeStatus] = useState('');
  const latestRevision = useRef(-1);
  const applySite = (result: ComputerWeb) => {
    const revision = result.revision ?? 0;
    if (revision < latestRevision.current) return;
    latestRevision.current = revision;
    setSite(result.sites?.find((s: Site) => s.host === host));
  };
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      if (document.hidden) return;
      void api
        .request(
          '/computer/websites' +
            (runId ? `?runId=${encodeURIComponent(runId)}&host=${encodeURIComponent(host)}` : ''),
        )
        .then((result) => {
          if (alive) {
            applySite(result);
            if (result.request?.resumed) {
              setResumed(true);
              setResumeStatus(result.request.status || 'queued');
            }
          }
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
    };
    refresh();
    const timer = setInterval(refresh, 15000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [host, runId]);
  async function decide(decision: string) {
    setBusy(true);
    setError('');
    try {
      const result = await api.request('/computer/websites/decide', {
        method: 'POST',
        body: JSON.stringify({ host, decision, ...(decision === 'allow' ? { runId } : {}) }),
      });
      applySite(result);
      if (result.resumed) {
        setResumed(true);
        setResumeStatus('queued');
      }
      await api.refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="website-permission"
      aria-label={`Website access for ${host}`}
      data-run-id={runId}
    >
      <div className="website-heading">
        <Globe size={21} />
        <strong>{host}</strong>
      </div>
      <p>
        {resumed
          ? ['completed', 'failed', 'cancelled'].includes(resumeStatus)
            ? `You allowed this request. Its continuation is ${resumeStatus}.`
            : s.connections.runtime?.assistantPaused
              ? 'Allowed. Waiting for you to give control back.'
              : 'Allowed. Relay is continuing your request.'
          : site?.status === 'allowed'
            ? 'Website connection allowed for this session.'
            : site?.status === 'denied'
              ? 'You declined this connection.'
              : 'Relay needs this website to continue.'}
      </p>
      {site?.reason && <p className="muted">{site.reason}</p>}
      {!resumed && site?.status !== 'allowed' && (
        <p className="muted">One hour of access, including forms and uploads.</p>
      )}
      <details>
        <summary>What this allows</summary>
        <p>
          Network connections to this server for up to one hour, or until the computer stops. This
          includes forms and uploads; it is not an exact-action or payment review. Take control for
          sign-ins and consequential actions.
        </p>
      </details>
      {error && <p role="alert">{error}</p>}
      <div className="website-actions">
        {site?.status === 'allowed' || resumed ? (
          <>
            <button className="secondary-button" onClick={() => go('computer')}>
              Open computer <ArrowRight size={15} />
            </button>
            {site?.status === 'allowed' && (
              <button className="text-button" disabled={busy} onClick={() => void decide('revoke')}>
                Revoke
              </button>
            )}
          </>
        ) : (
          <>
            <button
              className="primary-button"
              disabled={busy || !site}
              onClick={() => void decide('allow')}
            >
              {runId ? 'Allow & continue' : 'Allow for 1 hour'}
            </button>
            <button
              className="text-button"
              disabled={busy || !site}
              onClick={() => void decide('deny')}
            >
              Decline
            </button>
          </>
        )}
      </div>
    </section>
  );
}

export default function ComputerWebsites({
  web,
  controlling,
  onChange,
}: {
  web: ComputerWeb;
  controlling: boolean;
  onChange: (web: ComputerWeb) => void;
}) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!web.enabled) return null;
  const sites = web.sites || [];
  const pending = sites.filter((s) => s.status === 'pending').length;
  async function request(endpoint: string, payload: object) {
    setBusy(true);
    setError('');
    try {
      const result = await api.request(`/computer/websites/${endpoint}`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      // Decisions already return a confirmed snapshot. Other actions fetch the
      // lightweight website state, without waiting for a Docker screenshot.
      onChange(result.sites ? result : await api.request('/computer/websites'));
      return true;
    } catch (e: any) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="computer-websites" open={pending ? true : undefined}>
      <summary>
        <Globe size={16} /> Websites {pending > 0 && <span>{pending} waiting</span>}
      </summary>
      <p>
        Choose which website connections this computer can use. Access ends after one hour, a stop,
        or a server restart.
      </p>
      <p className="muted">
        Connections can send forms and files. Use reviewed app actions, or take control for
        consequential steps.
      </p>
      {(error || web.error) && <p role="alert">{error || web.error}</p>}
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (await request('request', { url })) setUrl('');
        }}
      >
        <input
          type="url"
          aria-label="Website address"
          placeholder="https://example.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          maxLength={3000}
          required
        />
        <button className="secondary-button" disabled={busy || !url.trim()}>
          Add website
        </button>
      </form>
      {sites.map((site) => (
        <div className="website-row" key={site.host}>
          <div>
            <strong>{site.host}</strong>
            <span>
              {site.status === 'allowed'
                ? `Allowed until ${new Date(site.expires).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                : site.status === 'pending'
                  ? 'Waiting for your choice'
                  : site.status}
            </span>
          </div>
          <div className="website-actions">
            {site.status === 'allowed' ? (
              <>
                {controlling && (
                  <button
                    className="text-button"
                    disabled={busy || !web.connected}
                    onClick={() => void request('open', { url: site.url })}
                  >
                    Open
                  </button>
                )}
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => void request('decide', { host: site.host, decision: 'revoke' })}
                >
                  Revoke
                </button>
              </>
            ) : (
              <>
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void request('decide', { host: site.host, decision: 'allow' })}
                >
                  Allow for 1 hour
                </button>
                {site.status === 'pending' && (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => void request('decide', { host: site.host, decision: 'deny' })}
                  >
                    Decline
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      ))}
    </details>
  );
}
