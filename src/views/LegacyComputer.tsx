import { useEffect, useState } from 'react';
import {
  Desktop,
  Globe,
  Terminal,
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  ArrowsClockwise,
  Stop,
  PaperPlaneTilt,
  Folder,
  ShieldCheck,
} from '@phosphor-icons/react';
import { useWorkspace } from '../context';
import { api } from '../api';
import { PageHeading, Field, Empty, dateTime } from '../components/ui';
export default function Computer() {
  const { s, act, run, go, toast } = useWorkspace();
  const [tab, setTab] = useState('browser');
  const [url, setUrl] = useState('https://example.com');
  const [browser, setBrowser] = useState<any>({ connected: false });
  const [busy, setBusy] = useState(false);
  const [control, setControl] = useState(false);
  const [text, setText] = useState('');
  const [command, setCommand] = useState('pwd');
  const [key, setKey] = useState('Enter');
  const server = api.mode() === 'server';
  const runtime = s.connections.runtime || {};
  const receipts = s.receipts.filter((r) => r.kind === 'terminal');
  useEffect(() => {
    if (server && runtime.browser) void run(async () => setBrowser(await api.request('/browser')));
  }, []);
  async function request(path: string, payload?: any) {
    setBusy(true);
    await run(async () => {
      const next = await api.request(path, { method: 'POST', body: JSON.stringify(payload || {}) });
      setBrowser(next);
      if (next.url) setUrl(next.url);
    });
    setBusy(false);
  }
  const remote = (payload: any) => request('/browser/control', payload);
  return (
    <section>
      <PageHeading
        eyebrow="YOUR WORKSPACE COMPUTER"
        title="See the work as it happens"
        description="A persistent browser and an isolated command workspace on your own server."
      >
        <button className="secondary-button" onClick={() => go('files')}>
          <Folder size={18} />
          Workspace files
        </button>
      </PageHeading>
      <div className="surface-toolbar">
        <div className="tabs">
          <button className={tab === 'browser' ? 'selected' : ''} onClick={() => setTab('browser')}>
            <Globe size={17} />
            Browser
          </button>
          <button
            className={tab === 'terminal' ? 'selected' : ''}
            onClick={() => setTab('terminal')}
          >
            <Terminal size={17} />
            Terminal
          </button>
        </div>
        <span className="muted">{server ? 'Self-hosted computer' : 'Sample workspace'}</span>
      </div>
      {tab === 'browser' ? (
        <>
          <div className="browser-toolbar">
            <button
              className="icon-button"
              aria-label="Browser back"
              disabled={!browser.connected || busy}
              onClick={() => void remote({ action: 'back' })}
            >
              <ArrowLeft size={19} />
            </button>
            <button
              className="icon-button"
              aria-label="Refresh browser page"
              disabled={!browser.connected || busy}
              onClick={() => void remote({ action: 'refresh' })}
            >
              <ArrowsClockwise size={19} />
            </button>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void request('/browser/navigate', { url });
              }}
            >
              <Globe size={17} />
              <input
                aria-label="Computer browser URL"
                type="url"
                required
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={!server}
              />
              <button
                className="primary-button"
                disabled={!server || !runtime.browser || busy}
                type="submit"
              >
                {busy ? 'Opening…' : 'Open'}
              </button>
            </form>
          </div>
          {browser.connected ? (
            <div className="browser-surface">
              <div className="browser-caption">
                <span>{browser.title}</span>
                <button
                  className={control ? 'primary-button' : 'secondary-button'}
                  onClick={() => setControl(!control)}
                >
                  {control ? 'Finish controlling' : 'Take control'}
                </button>
              </div>
              <button
                className={`browser-screen ${control ? 'controlling' : ''}`}
                disabled={!control || busy}
                aria-label={
                  control
                    ? 'Click to control the workspace browser'
                    : 'Workspace browser screenshot'
                }
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  void remote({
                    action: 'click',
                    x: Math.round(((e.clientX - rect.left) / rect.width) * browser.width),
                    y: Math.round(((e.clientY - rect.top) / rect.height) * browser.height),
                  });
                }}
              >
                <img
                  alt={`Browser view: ${browser.title}`}
                  src={`data:image/jpeg;base64,${browser.screenshot}`}
                />
              </button>
              {control && (
                <div className="browser-controls">
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => void remote({ action: 'scroll', direction: 'up' })}
                  >
                    <ArrowUp size={16} />
                    Scroll up
                  </button>
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => void remote({ action: 'scroll', direction: 'down' })}
                  >
                    <ArrowDown size={16} />
                    Scroll down
                  </button>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void remote({ action: 'type', text });
                      setText('');
                    }}
                  >
                    <input
                      aria-label="Type into computer browser"
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      placeholder="Text to type into the focused field"
                      maxLength={2000}
                    />
                    <button className="secondary-button" type="submit" disabled={busy || !text}>
                      Type text
                    </button>
                  </form>
                  <select
                    aria-label="Browser key"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                  >
                    {[
                      'Enter',
                      'Tab',
                      'Backspace',
                      'Escape',
                      'ArrowDown',
                      'ArrowUp',
                      'Control+A',
                      'Meta+A',
                    ].map((k) => (
                      <option key={k}>{k}</option>
                    ))}
                  </select>
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => void remote({ action: 'key', key })}
                  >
                    Press key
                  </button>
                </div>
              )}
              <details className="browser-text">
                <summary>Page text</summary>
                <p>{browser.text}</p>
              </details>
              <button
                className="text-button danger-text"
                disabled={busy}
                onClick={() => void request('/browser/stop')}
              >
                <Stop size={16} />
                Close browser session
              </button>
            </div>
          ) : (
            <Empty
              icon={Desktop}
              title={
                server ? 'Open a page in your workspace browser' : 'A computer on your own server'
              }
            >
              {server
                ? runtime.browser
                  ? 'Enter a public URL to open the persistent browser. Click Take control to use it.'
                  : 'Enable the browser in your server configuration.'
                : 'The hosted sample stores your workspace on this device. Run the supplied Node server to use a real browser and background worker.'}
            </Empty>
          )}
          <p className="computer-note">
            The browser reads public pages. Network requests use public-address checks; outbound
            writes are blocked. Email and calendar writes use the reviewed connectors.
          </p>
        </>
      ) : (
        <>
          <div className="terminal-intro">
            <ShieldCheck size={24} />
            <div>
              <h2>A workspace with its own walls</h2>
              <p>
                {server
                  ? runtime.terminal
                    ? 'Commands run in a persistent Docker volume, with no host filesystem mounts or network.'
                    : 'Enable the Docker workspace in your server configuration to run real commands.'
                  : 'Sample commands support pwd, ls, and help. Other commands return an explicit sample error.'}
              </p>
            </div>
          </div>
          <form
            className="command-composer"
            onSubmit={async (e) => {
              e.preventDefault();
              const a = await act('terminal.prepare', { command });
              if (a) {
                toast('Your command is ready for review.');
              }
            }}
          >
            <Field label="Workspace command">
              <textarea
                className="terminal-input"
                rows={3}
                required
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                maxLength={2000}
                spellCheck={false}
              />
            </Field>
            <button className="primary-button" type="submit">
              <PaperPlaneTilt size={17} />
              Prepare command for review
            </button>
          </form>
          <div className="terminal-results">
            <h2>Command receipts</h2>
            {receipts.length ? (
              receipts.map((r) => (
                <article key={r.id}>
                  <div>
                    <strong>{r.command || 'Workspace command'}</strong>
                    <span>
                      Exit {r.exitCode} · {dateTime(r.createdAt)}
                    </span>
                  </div>
                  <pre>
                    {r.stdout || r.output || ''}
                    {r.stderr ? `\n${r.stderr}` : ''}
                  </pre>
                  <p>{r.detail}</p>
                </article>
              ))
            ) : (
              <p className="muted">Approved commands leave their output and exit status here.</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
