import { useEffect, useState } from 'react';
import { ArrowClockwise, ChartDonut } from '@phosphor-icons/react';
import { api } from '../api';
import './model-usage.css';

type Counts = {
  requests: number;
  completed: number;
  failed: number;
  cancelled: number;
  running: number;
  interrupted: number;
  unreported: number;
  connectionTests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  totalTokensReports: number;
};
type Usage = {
  period: string;
  since: string;
  until: string;
  trackingSince: number | null;
  totals: Counts;
  models: (Counts & { connectionId: string; name: string; model: string; protocol: string })[];
  modelCount: number;
};
const number = (value: number | null) => (value === null ? 'Not reported' : value.toLocaleString());
export default function ModelUsage({ active }: { active: boolean }) {
  const [period, setPeriod] = useState('7d');
  const [data, setData] = useState<Usage | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const server = api.mode() === 'server';
  useEffect(() => {
    if (!active || !server) return;
    let live = true,
      loading = false;
    const controller = new AbortController();
    async function load() {
      if (loading || document.hidden) return;
      loading = true;
      setBusy(true);
      try {
        const value = await api.request(`/usage?period=${period}`, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        });
        if (live) {
          setData(value);
          setError('');
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : 'Usage could not be loaded.');
      } finally {
        loading = false;
        if (live) setBusy(false);
      }
    }
    void load();
    const timer = setInterval(() => void load(), 15000);
    const visible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      live = false;
      controller.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [active, server, period, refresh]);
  const totals = data?.period === period ? data.totals : null;
  return (
    <article className="settings-card usage-page" aria-label="Model usage">
      <div className="settings-title">
        <ChartDonut size={23} />
        <div>
          <h2>Your usage</h2>
          <p>Model activity from this Relay server.</p>
        </div>
      </div>
      {!server ? (
        <p className="setup-note">
          Sample mode doesn’t use a model. Connect your Relay server to see usage.
        </p>
      ) : (
        <>
          <div className="usage-toolbar">
            <label>
              Period
              <select
                aria-label="Usage period"
                value={period}
                onChange={(e) => {
                  setPeriod(e.target.value);
                  setError('');
                }}
              >
                <option value="24h">Last 24 hours</option>
                <option value="7d">Last 7 days</option>
                <option value="30d">Last 30 days</option>
              </select>
            </label>
            <button
              className="icon-button"
              aria-label="Refresh usage"
              disabled={busy}
              onClick={() => setRefresh((n) => n + 1)}
            >
              <ArrowClockwise size={20} />
            </button>
          </div>
          {error && (
            <p className="usage-error" role="alert">
              {error}{' '}
              <button
                className="text-button"
                onClick={() => setRefresh((n) => n + 1)}
                disabled={busy}
              >
                Try again
              </button>
            </p>
          )}
          {!totals && !error && <p role="status">Loading usage…</p>}
          {totals && (
            <>
              {error && <p className="usage-note">Showing the last loaded figures.</p>}
              {!totals.requests ? (
                <div className="usage-empty">
                  <h3>No model requests in this period</h3>
                  <p>
                    Usage appears here when Relay calls a connected model. Earlier activity cannot
                    be reconstructed.
                  </p>
                </div>
              ) : (
                <>
                  <dl className="usage-totals">
                    <div>
                      <dt>Model requests</dt>
                      <dd>{number(totals.requests)}</dd>
                    </div>
                    <div>
                      <dt>Reported tokens</dt>
                      <dd>{number(totals.totalTokens)}</dd>
                    </div>
                  </dl>
                  <p className="usage-note">
                    {number(totals.completed)} completed
                    {totals.running > 0 && ` · ${number(totals.running)} in progress`}
                    {totals.failed > 0 && ` · ${number(totals.failed)} failed`}
                    {totals.cancelled > 0 && ` · ${number(totals.cancelled)} cancelled`}
                    {totals.interrupted > 0 &&
                      ` · ${number(totals.interrupted)} interrupted by restart`}
                  </p>
                  {totals.unreported > 0 && (
                    <p className="usage-note">
                      {number(totals.unreported)}{' '}
                      {totals.unreported === 1 ? 'request has' : 'requests have'} no reported total.
                      Tokens shown may be incomplete, including for interrupted requests.
                    </p>
                  )}
                  {totals.failed + totals.cancelled + totals.interrupted > 0 && (
                    <p className="usage-note">
                      Failed or stopped requests may have consumed more tokens than were reported.
                    </p>
                  )}
                  <section className="usage-models" aria-label="Usage by model">
                    <h3>By model</h3>
                    {data!.models.map((model) => (
                      <details
                        key={`${model.connectionId}:${model.name}:${model.model}:${model.protocol}`}
                      >
                        <summary>
                          <span>
                            <strong>{model.name}</strong>
                            <small>{model.model}</small>
                          </span>
                          <span className="usage-model-total">
                            {number(model.totalTokens)}
                            {model.totalTokens !== null && ' tokens'}
                            <small>
                              {number(model.requests)}{' '}
                              {model.requests === 1 ? 'request' : 'requests'}
                            </small>
                          </span>
                        </summary>
                        <dl className="usage-breakdown">
                          <div>
                            <dt>Input tokens</dt>
                            <dd>{number(model.inputTokens)}</dd>
                          </div>
                          <div>
                            <dt>Output tokens</dt>
                            <dd>{number(model.outputTokens)}</dd>
                          </div>
                          <div>
                            <dt>Cached input</dt>
                            <dd>{number(model.cachedTokens)}</dd>
                          </div>
                          <div>
                            <dt>Cache writes</dt>
                            <dd>{number(model.cacheWriteTokens)}</dd>
                          </div>
                          <div>
                            <dt>Reasoning tokens</dt>
                            <dd>{number(model.reasoningTokens)}</dd>
                          </div>
                        </dl>
                        {model.unreported > 0 && (
                          <p className="usage-note">
                            {number(model.unreported)} without a reported total.
                          </p>
                        )}
                        {model.connectionTests > 0 && (
                          <p className="usage-note">
                            Includes {number(model.connectionTests)} connection{' '}
                            {model.connectionTests === 1 ? 'check' : 'checks'}.
                          </p>
                        )}
                      </details>
                    ))}
                    {data!.modelCount > data!.models.length && (
                      <p className="usage-note">
                        Showing the 100 most-used model connections. Totals include all{' '}
                        {number(data!.modelCount)}.
                      </p>
                    )}
                  </section>
                </>
              )}
              <p className="usage-updated">
                Updated{' '}
                {new Date(data!.until).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                {data!.trackingSince !== null &&
                  ` · Recording since ${new Date(data!.trackingSince).toLocaleDateString()}`}
              </p>
            </>
          )}
          <details className="usage-explainer">
            <summary>What’s included?</summary>
            <p>
              Each model call counts once, including tool follow-ups, backups and connection checks.
              Cached input and reasoning are included in the main token totals when reported; they
              aren’t added twice.
            </p>
            <p>
              Figures come from model responses. Speech services, image generation and activity
              outside this Relay server are not included. No prompts or replies are stored in usage
              history.
            </p>
          </details>
          <p className="usage-note">
            Plan allowances, reset times and charges aren’t supplied by these model connections.
            Check your provider account for billing.
          </p>
        </>
      )}
    </article>
  );
}
