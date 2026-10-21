import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowRight, Cursor, Globe, Stop, Trash } from '@phosphor-icons/react';
import { api } from '../api';
import { useWorkspace } from '../context';
import './private-browser.css';

type Control = {
  target: string;
  name: string;
  role: string;
  private?: boolean;
  concealed?: boolean;
  editable?: boolean;
  value?: string;
  checked?: boolean | string;
  bounds: { x: number; y: number; width: number; height: number };
};
type Review = {
  id: string;
  fingerprint: string;
  phase: string;
  method: string;
  url: string;
  destination: string;
  body?: string;
  bodyBytes: number;
  contentType?: string;
  bodyTruncated?: boolean;
  headers: Record<string, string>;
  pageLoad?: { origin: string; requests: number; milliseconds: number };
  reviewRequired?: boolean;
};
type View = {
  controller?: string;
  connected?: boolean;
  generation?: number;
  screenshot?: string;
  url?: string;
  controls?: Control[];
  requests?: Review[];
  action?: { id: string; phase: string };
  downloads?: { id: string; name: string; size: number }[];
};
const post = (path: string, body = {}) =>
  api.request(path, { method: 'POST', body: JSON.stringify(body) });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default function PrivateBrowser() {
  const { openFile, go } = useWorkspace();
  const [view, setView] = useState<View>({});
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [clearing, setClearing] = useState(false);
  const [zoom, setZoom] = useState(() => matchMedia('(max-width: 650px)').matches);
  const [switching, setSwitching] = useState(false);
  const intentEpoch = useRef(0);
  const mounted = useRef(false);
  const pending = useRef(0);
  const version = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const addressEdited = useRef(false);
  const owner = view.controller === 'owner';
  const reviews = (view.requests || []).filter(
    (r) => r.phase === 'pending' && r.reviewRequired !== false,
  );
  const pageLoad = reviews.length === 1 ? reviews[0].pageLoad : undefined;
  async function refresh() {
    const current = ++version.current;
    const next: View = await api.request('/private-browser/view');
    if (!mounted.current || current !== version.current) return;
    setView(next);
    if (!addressEdited.current && next.url && next.url !== 'about:blank') setAddress(next.url);
  }
  useEffect(() => {
    mounted.current = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!document.hidden && !pending.current) {
        try {
          await refresh();
        } catch (e: any) {
          if (!stopped) setError(e.message);
        }
      }
      if (!stopped) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => {
      stopped = true;
      mounted.current = false;
      version.current++;
      clearTimeout(timer);
    };
  }, []);
  // Blur edits and the following click share one queue, preserving native form order.
  function perform(work: () => Promise<unknown>) {
    pending.current++;
    version.current++;
    setBusy(true);
    setError('');
    const epoch = intentEpoch.current;
    const task = queue.current.then(async () => {
      if (!mounted.current || epoch !== intentEpoch.current) return;
      return work();
    });
    queue.current = task.catch(() => {});
    void task
      .catch((e) => {
        if (mounted.current) setError(e.message);
      })
      .finally(async () => {
        pending.current--;
        if (mounted.current && !pending.current) {
          try {
            await refresh();
          } catch (e: any) {
            if (mounted.current) setError(e.message);
          }
          if (mounted.current) setBusy(false);
        }
      });
    return task;
  }
  async function act(input: Record<string, unknown>) {
    const operationId = crypto.randomUUID();
    let receipt = await post('/private-browser/actions', { ...input, operationId });
    if (mounted.current) setView((previous) => ({ ...previous, action: receipt }));
    // Poll the receipt after acceptance; never repeat an input following a lost response.
    for (let i = 0; receipt.phase === 'running' && i < 1500; i++) {
      if (!mounted.current) return;
      await sleep(200);
      receipt = await api.request(`/private-browser/actions/${operationId}`);
    }
    if (receipt.phase !== 'completed')
      throw new Error('This action did not finish. Check the page before trying again.');
  }
  function input(action: Record<string, unknown>) {
    void perform(() => act(action));
  }
  async function changeControl() {
    if (switching) return;
    intentEpoch.current++;
    version.current++;
    setSwitching(true);
    setView((previous) => ({ ...previous, controls: [], screenshot: undefined }));
    try {
      await post(`/computer/${owner ? 'release' : 'takeControl'}`);
      if (mounted.current) setClearing(false);
      await api.refresh();
      await refresh();
    } catch (e: any) {
      if (mounted.current) setError(e.message);
    } finally {
      if (mounted.current) setSwitching(false);
    }
  }
  async function decide(allow: boolean, includePageResources = false) {
    const snapshot = reviews.map(({ id, fingerprint }) => ({ id, fingerprint }));
    await perform(async () => {
      const results = await Promise.allSettled(
        snapshot.map(({ id, fingerprint }) =>
          post(`/private-browser/requests/${id}`, { fingerprint, allow, includePageResources }),
        ),
      );
      const failed = results.find((r) => r.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    });
  }
  return (
    <section className="private-browser" aria-label="Private browser">
      <div className="private-browser-heading">
        <p>
          {owner
            ? 'You’re in control. Relay is paused.'
            : view.action
              ? 'Relay is using the browser.'
              : 'Ready for Relay.'}
        </p>
        <button
          className={owner ? 'secondary-button' : 'primary-button'}
          disabled={switching}
          onClick={() => void changeControl()}
        >
          <Cursor size={16} /> {owner ? 'Give back to Relay' : 'Take control'}
        </button>
      </div>
      {error && (
        <p className="computer-error" role="alert">
          {error}
          <button
            className="text-button"
            onClick={() => {
              setError('');
              void refresh().catch((e) => setError(e.message));
            }}
          >
            Refresh page view
          </button>
        </p>
      )}
      {!!view.downloads?.length && (
        <section className="private-browser-downloads" aria-label="Browser downloads">
          <span>Saved to Files</span>
          {view.downloads.slice(0, 1).map((file) => (
            <button className="secondary-button" key={file.id} onClick={() => openFile(file.id)}>
              {file.name}
            </button>
          ))}
          <button className="text-button" onClick={() => go('files')}>
            All files
          </button>
        </section>
      )}
      {reviews.length > 0 && (
        <section className="private-browser-review" aria-label="Website request review">
          <div>
            <strong>
              {reviews.length === 1
                ? 'A website request needs your review'
                : `${reviews.length} website requests need your review`}
            </strong>
            <p>
              {pageLoad
                ? 'Load this page with its images, styles, fonts and scripts from the same site. Forms, other pages and API calls still ask.'
                : 'Only the requests listed here will be allowed.'}
            </p>
            {pageLoad && (
              <details>
                <summary>Page loading limits</summary>
                <p>
                  Up to {pageLoad.requests} resource requests from {pageLoad.origin} for{' '}
                  {pageLoad.milliseconds / 1000} seconds, ending when this action finishes or you
                  take control. Website requests can have side effects.
                </p>
              </details>
            )}
          </div>
          <ul>
            {reviews.map((r) => (
              <li key={r.id}>
                <RequestPreview request={r} />
              </li>
            ))}
          </ul>
          <div className="private-browser-review-actions">
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => void decide(true, !!pageLoad).catch(() => {})}
            >
              Allow & continue
            </button>
            {pageLoad && (
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => void decide(true).catch(() => {})}
              >
                Only this request
              </button>
            )}
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => void decide(false).catch(() => {})}
            >
              Decline
            </button>
          </div>
        </section>
      )}
      <div className="computer-window">
        <form
          className="private-browser-address"
          onSubmit={(e) => {
            e.preventDefault();
            addressEdited.current = false;
            if (owner && address.trim())
              input({
                action: 'open',
                url: /^https?:\/\//i.test(address.trim())
                  ? address.trim()
                  : `https://${address.trim()}`,
              });
          }}
        >
          <Globe size={18} aria-hidden="true" />
          <input
            aria-label="Website address"
            placeholder="Enter a website"
            value={address}
            onChange={(e) => {
              addressEdited.current = true;
              setAddress(e.target.value);
            }}
            disabled={!owner || busy}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="url"
          />
          <button
            className="icon-button"
            aria-label="Open website"
            disabled={!owner || busy || !address.trim()}
          >
            <ArrowRight size={19} />
          </button>
        </form>
        {view.screenshot ? (
          <div className={`private-browser-viewport ${zoom ? 'is-zoomed' : ''}`}>
            <div className="private-browser-page">
              <img
                src={`data:image/jpeg;base64,${view.screenshot}`}
                alt="Current private browser page"
                draggable={false}
              />
              {owner &&
                (view.controls || []).map((c) => (
                  <PageControl
                    key={`${view.generation}:${c.target}`}
                    control={c}
                    onAction={input}
                  />
                ))}
            </div>
          </div>
        ) : (
          <div className="computer-rest">
            <Globe size={40} weight="duotone" />
            <h3>
              {busy || view.action
                ? 'Opening your page…'
                : owner
                  ? 'Where would you like to go?'
                  : 'A browser you can share with Relay'}
            </h3>
            <p>
              {owner
                ? 'Open a website above. You can sign in and use its page here.'
                : 'Ask Relay to work on a website, or take control to open one yourself.'}
            </p>
          </div>
        )}
        <div className="private-browser-footer">
          <span role="status">
            {busy
              ? 'Updating page…'
              : !view.connected && address
                ? 'Reopen the page after switching control. Saved sign-ins stay.'
                : owner
                  ? 'Click a field to type. Tab or click outside to apply.'
                  : 'You can take control at any time.'}
          </span>
          <div>
            {view.screenshot && (
              <button className="text-button" onClick={() => setZoom(!zoom)}>
                {zoom ? 'Fit page' : 'Zoom in'}
              </button>
            )}
            {owner && view.screenshot && (
              <>
                <button
                  className="icon-button"
                  aria-label="Scroll page up"
                  disabled={busy}
                  onClick={() => input({ action: 'scroll', direction: 'up' })}
                >
                  <ArrowUp size={18} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Scroll page down"
                  disabled={busy}
                  onClick={() => input({ action: 'scroll', direction: 'down' })}
                >
                  <ArrowDown size={18} />
                </button>
              </>
            )}
            {view.action && (
              <button
                className="text-button"
                onClick={() => {
                  void post(`/private-browser/actions/${view.action!.id}/cancel`)
                    .then(refresh)
                    .catch((e) => setError(e.message));
                }}
              >
                <Stop size={16} /> Stop
              </button>
            )}
          </div>
        </div>
      </div>
      <details className="private-browser-data">
        <summary>Saved sign-ins & browser data</summary>
        <p>
          Sign-ins are stored on your Relay server. Clearing them signs out this browser. Switching
          control currently closes the page, so unfinished forms are lost. Downloaded files stay in
          Files.
        </p>
        {owner ? (
          clearing ? (
            <div>
              <p>Clear all saved sign-ins and browser data?</p>
              <button
                className="secondary-button danger-text"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await post('/private-browser/clear');
                    setClearing(false);
                    setAddress('');
                    addressEdited.current = false;
                  })
                }
              >
                Clear browser data
              </button>
              <button className="text-button" onClick={() => setClearing(false)}>
                Keep data
              </button>
            </div>
          ) : (
            <button className="text-button" disabled={busy} onClick={() => setClearing(true)}>
              <Trash size={16} /> Clear browser data…
            </button>
          )
        ) : (
          <p>Take control to clear browser data.</p>
        )}
      </details>
    </section>
  );
}

function PageControl({
  control: c,
  onAction,
}: {
  control: Control;
  onAction: (action: Record<string, unknown>) => void;
}) {
  const [value, setValue] = useState(c.private ? '' : c.value || '');
  const dirty = useRef(false);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current && !dirty.current) setValue(c.private ? '' : c.value || '');
  }, [c.value, c.private]);
  function commit() {
    if (!dirty.current) return;
    dirty.current = false;
    onAction({ action: 'type', target: c.target, text: value });
    if (c.private) setValue('');
  }
  const style = {
    left: `${c.bounds.x / 12.8}%`,
    top: `${c.bounds.y / 8}%`,
    width: `${c.bounds.width / 12.8}%`,
    height: `${c.bounds.height / 8}%`,
  };
  const label = c.name || c.role;
  return c.editable ? (
    <input
      className="private-browser-field"
      style={style}
      aria-label={label}
      type={c.concealed ? 'password' : 'text'}
      value={value}
      maxLength={4096}
      autoComplete="off"
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(e) => {
        dirty.current = true;
        setValue(e.target.value);
      }}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
          onAction({ action: 'key', target: c.target, key: 'Enter' });
        }
      }}
    />
  ) : (
    <button
      type="button"
      className="private-browser-target"
      style={style}
      aria-label={label}
      title={label}
      onClick={() => onAction({ action: 'click', target: c.target })}
      onKeyDown={(e) => {
        if (
          ['ArrowDown', 'ArrowUp'].includes(e.key) &&
          ['combobox', 'spinbutton'].includes(c.role)
        ) {
          e.preventDefault();
          onAction({ action: 'key', target: c.target, key: e.key });
        }
      }}
    />
  );
}

function RequestPreview({ request: r }: { request: Review }) {
  const fields =
    r.body && r.contentType?.includes('application/x-www-form-urlencoded')
      ? [...new URLSearchParams(r.body).entries()]
      : null;
  return (
    <div className="private-browser-request">
      <strong>{r.bodyBytes > 0 ? 'Send information' : 'Connect to website'}</strong>
      <p className="private-browser-destination">{r.url}</p>
      {fields ? (
        <dl>
          {fields.map(([name, value], i) => (
            <div key={i}>
              <dt>{name.replaceAll('_', ' ')}</dt>
              <dd>{value || '(empty)'}</dd>
            </div>
          ))}
        </dl>
      ) : r.body ? (
        <pre>{r.body}</pre>
      ) : r.bodyBytes > 0 ? (
        <p>{r.bodyBytes.toLocaleString()} bytes of binary data. Contents cannot be previewed.</p>
      ) : null}
      {r.bodyTruncated && <p>More data is included than this preview can show.</p>}
      <details>
        <summary>Request details</summary>
        <p>
          {r.method} · {r.destination}
        </p>
        <pre>{r.body}</pre>
        <pre>
          {Object.entries(r.headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\n')}
        </pre>
      </details>
    </div>
  );
}
