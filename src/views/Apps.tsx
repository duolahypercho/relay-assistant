import { useEffect, useRef, useState } from 'react';
import { isNativeMobile, mobileConnection } from '../native-mobile';
import { Plug, Plus, ArrowRight, Envelope, CheckCircle, X } from '@phosphor-icons/react';
import { useWorkspace } from '../context';
import { api } from '../api';
import LocalToolFields, { type LocalLaunch } from '../components/LocalToolFields';
import AppDirectory, { type DirectoryApp } from '../components/AppDirectory';
import AppDocuments from '../components/AppDocuments';
import AppTemplates from '../components/AppTemplates';
import { threadAssistantId } from '../../shared/assistant-scope.mjs';
import './apps.css';
type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: any;
  readOnly: boolean;
  kind?: 'resource' | 'resource-template' | 'prompt';
  ownerChoice?: boolean;
  mode: 'off' | 'ask' | 'auto';
};
type Connection = {
  id: string;
  revision: number;
  name: string;
  endpoint: string;
  transport?: 'http' | 'stdio';
  launch?: LocalLaunch;
  enabled: boolean;
  hasToken: boolean;
  authentication?: string;
  signInNeeded?: boolean;
  assistantIds: string[] | null;
  tools: Tool[];
};
type Draft = Partial<Connection> & {
  name: string;
  endpoint: string;
  token: string;
  tools: Tool[];
  discoveryId?: string;
  needsDiscovery?: boolean;
  signInRequired?: boolean;
  clientId?: string;
  clientSecret?: string;
};
export default function Apps() {
  const { s, go, toast, threadId } = useWorkspace();
  const pending = useRef(false);
  const preparation = useRef<AbortController | null>(null);
  useEffect(() => () => preparation.current?.abort(), []);
  const [connections, setConnections] = useState<Connection[]>([]),
    [documents, setDocuments] = useState<Connection | null>(null),
    [templates, setTemplates] = useState<Connection | null>(null),
    [directory, setDirectory] = useState<DirectoryApp[]>([]),
    [query, setQuery] = useState(''),
    [editAddress, setEditAddress] = useState(false),
    [draft, setDraft] = useState<Draft | null>(null),
    [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [loaded, setLoaded] = useState(false),
    [removing, setRemoving] = useState(''),
    [signIn, setSignIn] = useState<{
      id: string;
      phase: 'waiting' | 'ready';
      host?: string;
      openUrl?: string;
    } | null>(() => {
      try {
        const id = sessionStorage.getItem('relay-app-sign-in');
        return id ? { id, phase: 'waiting' } : null;
      } catch {
        return null;
      }
    });
  function rememberSignIn(id?: string) {
    try {
      if (id) sessionStorage.setItem('relay-app-sign-in', id);
      else sessionStorage.removeItem('relay-app-sign-in');
    } catch {}
  }
  function cancelSignIn() {
    if (signIn)
      void api
        .request('/connectors/oauth/cancel', {
          method: 'POST',
          body: JSON.stringify({ id: signIn.id }),
        })
        .catch(() => {});
    rememberSignIn();
    setSignIn(null);
  }
  useEffect(() => {
    if (!signIn || signIn.phase !== 'waiting') return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await api.request(
          `/connectors/oauth/result?id=${encodeURIComponent(signIn!.id)}`,
        );
        if (!alive) return;
        if (result.phase === 'failed')
          throw Object.assign(Error(result.error || 'Sign-in could not be completed. Try again.'), {
            status: 400,
          });
        if (result.connection)
          setDraft((d) =>
            result.phase === 'ready' || !d
              ? {
                  ...result.connection,
                  id: result.existing ? result.connection.id : undefined,
                  revision: result.existing ? result.connection.revision - 1 : undefined,
                  tools: result.connection.tools || [],
                  token: '',
                  discoveryId: result.discoveryId,
                  needsDiscovery: result.phase !== 'ready',
                }
              : d,
          );
        if (result.phase === 'ready') {
          setSignIn((s) => (s ? { ...s, phase: 'ready', openUrl: undefined } : null));
          setError('');
          return;
        }
        timer = setTimeout(poll, 1200);
      } catch (error) {
        if (!alive) return;
        setError(
          error instanceof Error ? error.message : 'App sign-in could not finish. Try again.',
        );
        if ((error as any)?.status >= 400 && (error as any)?.status < 500) {
          rememberSignIn();
          setSignIn(null);
        } else {
          timer = setTimeout(poll, 4000);
        }
      }
    }
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [signIn?.id, signIn?.phase]);
  async function beginSignIn() {
    if (pending.current) return;
    if (!draft || !draft.name.trim() || !draft.endpoint.trim()) {
      setError('Enter the app name and address first.');
      return;
    }
    cancelSignIn();
    const native = (window as any).relayNative;
    const tab = !native && !isNativeMobile ? window.open('about:blank', '_blank') : null;
    if (tab) tab.opener = null;
    const result = await request('oauth/begin', {
      id: draft.id,
      revision: draft.revision,
      name: draft.name,
      endpoint: draft.endpoint,
      clientId: draft.clientId,
      clientSecret: draft.clientSecret,
    });
    if (!result) {
      tab?.close();
      return;
    }
    rememberSignIn(result.id);
    setSignIn({
      ...result,
      openUrl: !native && !isNativeMobile && !tab ? result.openUrl : undefined,
      phase: 'waiting',
    });
    try {
      if (native?.openAppSignIn) await native.openAppSignIn(result.openUrl);
      else if (isNativeMobile) await mobileConnection.openAppSignIn({ url: result.openUrl });
      else if (tab) tab.location.href = result.openUrl;
    } catch {
      setError('The browser could not open. Cancel and try signing in again.');
    }
  }
  const server = api.mode() === 'server';
  const assistants = [
    { id: 'relay', name: s.profile.assistantName || 'Relay' },
    ...(s.assistants || []).filter((a) => !a.archived),
  ];
  useEffect(() => {
    if (!server) return;
    let alive = true;
    api
      .request('/connectors')
      .then((data) => {
        if (alive) {
          setConnections(data.connections);
          setDirectory(data.directory || []);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [server]);
  async function request(action: string, payload: any) {
    if (pending.current) return null;
    pending.current = true;
    const controller = action === 'prepare' ? new AbortController() : null;
    preparation.current = controller;
    setBusy(action);
    setError('');
    try {
      return await api.request(`/connectors/${action}`, {
        method: 'POST',
        body: JSON.stringify(payload),
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (e) {
      setError(
        controller?.signal.aborted
          ? 'Connection check cancelled.'
          : e instanceof Error
            ? e.message
            : 'This app could not be updated.',
      );
      return null;
    } finally {
      pending.current = false;
      preparation.current = null;
      setBusy('');
    }
  }
  function open(value?: Connection) {
    cancelSignIn();
    setEditAddress(false);
    setDraft(
      value
        ? {
            ...structuredClone(value),
            token: '',
            ...(value.launch
              ? {
                  launch: {
                    ...value.launch,
                    env: Object.fromEntries((value.launch.envKeys || []).map((key) => [key, null])),
                  },
                }
              : {}),
          }
        : {
            name: '',
            endpoint: '',
            token: '',
            tools: [],
            assistantIds: null,
            needsDiscovery: true,
          },
    );
    setError('');
    setRemoving('');
  }
  function metadata(value: Partial<Draft>) {
    cancelSignIn();
    if (value.endpoint !== undefined) setEditAddress(true);
    setDraft((d) =>
      d
        ? { ...d, ...value, discoveryId: undefined, needsDiscovery: true, signInRequired: false }
        : d,
    );
    setError('');
  }
  function policy(name: string, mode: Tool['mode']) {
    setDraft((d) =>
      d ? { ...d, tools: d.tools.map((t) => (t.name === name ? { ...t, mode } : t)) } : d,
    );
  }
  async function discover(target = draft) {
    if (!target) return;
    const result = await request('prepare', {
      id: target.id,
      revision: target.revision,
      name: target.name,
      endpoint: target.endpoint,
      token: target.token || (target.hasToken ? undefined : ''),
      transport: target.transport,
      launch: target.launch,
      launchApproved: target.transport === 'stdio',
    });
    if (result?.signInRequired) {
      setDraft((d) =>
        d ? { ...d, name: result.name, signInRequired: true, needsDiscovery: true } : d,
      );
      return;
    }
    if (result)
      setDraft((d) =>
        d
          ? {
              ...d,
              name: result.connection.name,
              tools: result.connection.tools,
              discoveryId: result.discoveryId,
              needsDiscovery: false,
              signInRequired: false,
            }
          : d,
      );
  }
  function chooseApp(app: DirectoryApp) {
    if (pending.current) return;
    const existing = connections.find((c) => c.endpoint === app.endpoint);
    if (existing) return open(existing);
    cancelSignIn();
    const next: Draft = {
      name: app.name,
      endpoint: app.endpoint,
      token: '',
      tools: [],
      assistantIds: null,
      needsDiscovery: true,
    };
    setEditAddress(false);
    setDraft(next);
    setRemoving('');
    void discover(next);
  }
  const directoryApp = draft && directory.find((a) => a.endpoint === draft.endpoint);
  async function save() {
    if (!draft) return;
    const permissions = Object.fromEntries(draft.tools.map((t) => [t.name, t.mode]));
    const result = await request(draft.discoveryId ? 'save' : 'update', {
      id: draft.id,
      revision: draft.revision,
      name: draft.name,
      discoveryId: draft.discoveryId,
      permissions,
      assistantIds: draft.assistantIds,
    });
    if (result) {
      setConnections(result.connections);
      rememberSignIn();
      setSignIn(null);
      setDraft(null);
      await api.refresh();
      toast('App connected. Its tools are ready in chat.');
    }
  }
  async function toggle(connection: Connection) {
    const result = await request('update', {
      id: connection.id,
      revision: connection.revision,
      enabled: !connection.enabled,
    });
    if (result) {
      setConnections(result.connections);
      await api.refresh();
    }
  }
  if (templates)
    return (
      <div className="apps-page">
        <AppTemplates
          key={templates.id}
          connection={templates}
          onClose={() => setTemplates(null)}
        />
      </div>
    );
  if (documents)
    return (
      <div className="apps-page">
        <AppDocuments
          key={documents.id}
          connection={documents}
          onClose={() => setDocuments(null)}
        />
      </div>
    );
  return (
    <div className="apps-page">
      <p className="apps-intro">
        Bring the apps you use into your conversation. You choose what your assistant can do.
      </p>
      {!server ? (
        <p className="setup-note">Open the Relay app or connect your Relay server to add apps.</p>
      ) : (
        <>
          {!draft && (
            <>
              <div className="apps-list">
                {connections.map((connection) => (
                  <article className="app-connection" key={connection.id}>
                    <span className="app-mark">
                      <Plug size={23} />
                    </span>
                    <div className="app-summary">
                      <h2>{connection.name}</h2>
                      <p>
                        {connection.transport === 'stdio'
                          ? 'Relay’s computer'
                          : new URL(connection.endpoint).host}{' '}
                        · {connection.tools.filter((t) => t.mode !== 'off').length}{' '}
                        {connection.tools.some((t) => t.kind) ? 'available' : 'tools'}
                      </p>
                      <span className="app-state">
                        {connection.signInNeeded ? (
                          'Sign in again'
                        ) : connection.enabled ? (
                          <>
                            <CheckCircle size={15} /> Connected
                          </>
                        ) : (
                          'Paused'
                        )}
                      </span>
                    </div>
                    <div className="app-actions">
                      {connection.enabled &&
                        (!connection.assistantIds ||
                          connection.assistantIds.includes(threadAssistantId(s, threadId))) &&
                        connection.tools.some((t) => t.mode !== 'off' && t.kind === 'prompt') && (
                          <button
                            className="secondary-button"
                            disabled={!!busy || connection.signInNeeded}
                            aria-label={`Templates in ${connection.name}`}
                            onClick={() => setTemplates(connection)}
                          >
                            Templates
                          </button>
                        )}

                      {connection.enabled &&
                        (!connection.assistantIds ||
                          connection.assistantIds.includes(threadAssistantId(s, threadId))) &&
                        connection.tools.some(
                          (t) =>
                            t.mode !== 'off' &&
                            (t.kind === 'resource' || t.kind === 'resource-template'),
                        ) && (
                          <button
                            className="secondary-button"
                            disabled={!!busy || connection.signInNeeded}
                            aria-label={`Documents in ${connection.name}`}
                            onClick={() => setDocuments(connection)}
                          >
                            Documents
                          </button>
                        )}
                      <button
                        className="text-button"
                        disabled={!!busy}
                        onClick={() => void toggle(connection)}
                      >
                        {connection.enabled ? 'Pause' : 'Enable'}
                      </button>
                      <button
                        className="secondary-button"
                        disabled={!!busy}
                        onClick={() => open(connection)}
                        aria-label={`Manage ${connection.name}`}
                      >
                        Manage
                      </button>
                    </div>
                  </article>
                ))}
                <article className="app-connection">
                  <span className="app-mark">
                    <Envelope size={23} />
                  </span>
                  <div className="app-summary">
                    <h2>Google Mail & Calendar</h2>
                    <p>
                      {s.connections.google.connected
                        ? s.connections.google.email
                        : 'Find mail and dates. Review changes before they happen.'}
                    </p>
                  </div>
                  <button
                    className="secondary-button"
                    onClick={() => go('settings', 'connections')}
                  >
                    {s.connections.google.connected ? 'Manage' : 'Set up'} <ArrowRight size={16} />
                  </button>
                </article>
              </div>
              {server && !loaded && !error && <p role="status">Loading your apps…</p>}
              {!!directory.length && (
                <AppDirectory
                  apps={directory}
                  query={query}
                  onQuery={setQuery}
                  connected={(app) => connections.some((c) => c.endpoint === app.endpoint)}
                  disabled={!loaded || !!busy}
                  onSelect={chooseApp}
                />
              )}
              <button
                className="primary-button add-app"
                disabled={!loaded || !!busy}
                onClick={() => open()}
              >
                <Plus size={18} /> Add an app
              </button>
              <p className="apps-footnote">
                Connect apps that support MCP. Credentials stay on your Relay server. Apps receive
                only the arguments of the tools you use; returned content can enter your AI
                conversation.
              </p>
            </>
          )}
          {draft && (
            <form
              className="app-editor"
              onSubmit={(e) => {
                e.preventDefault();
                if (busy || signIn?.phase === 'waiting') return;
                void (draft.needsDiscovery || draft.signInNeeded
                  ? draft.signInRequired || draft.signInNeeded
                    ? beginSignIn()
                    : discover()
                  : save());
              }}
            >
              <div className="app-editor-heading">
                <h2>
                  {draft.id
                    ? `Manage ${draft.name}`
                    : directoryApp
                      ? `Connect ${directoryApp.name}`
                      : 'Connect an app'}
                </h2>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Close app editor"
                  disabled={!!busy}
                  onClick={() => {
                    cancelSignIn();
                    setDraft(null);
                    setError('');
                  }}
                >
                  <X size={19} />
                </button>
              </div>
              {signIn?.phase === 'waiting' && (
                <div className="app-sign-in-status" role="status">
                  <strong>Finish signing in in your browser</strong>
                  <p>Then return here to choose what Relay can use.</p>
                  {signIn.openUrl && (
                    <a href={signIn.openUrl} target="_blank" rel="noreferrer">
                      Continue sign-in
                    </a>
                  )}
                  <button type="button" className="text-button" onClick={cancelSignIn}>
                    Cancel sign-in
                  </button>
                </div>
              )}
              {busy === 'prepare' && (
                <button
                  className="text-button"
                  type="button"
                  onClick={() => preparation.current?.abort()}
                >
                  Cancel connection check
                </button>
              )}
              <fieldset disabled={!!busy || signIn?.phase === 'waiting'} className="app-fields">
                {(!draft.needsDiscovery || draft.id) && (
                  <label>
                    App name
                    <input
                      autoComplete="off"
                      value={draft.name}
                      maxLength={80}
                      onChange={(e) => setDraft((d) => (d ? { ...d, name: e.target.value } : d))}
                      required
                      placeholder="My notebook"
                    />
                  </label>
                )}
                {draft.transport === 'stdio' ? (
                  <LocalToolFields
                    launch={draft.launch!}
                    onChange={(launch) => metadata({ launch })}
                    openComputer={() => go('computer')}
                  />
                ) : directoryApp && !editAddress ? (
                  <div className="app-directory-detail">
                    <p>{directoryApp.description}</p>
                    <details>
                      <summary>Connection details</summary>
                      <p>{directoryApp.endpoint}</p>
                      <a href={directoryApp.guide} target="_blank" rel="noreferrer">
                        Official setup guide
                      </a>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => setEditAddress(true)}
                      >
                        Edit connection address
                      </button>
                    </details>
                  </div>
                ) : (
                  <>
                    <label>
                      App address
                      <input
                        type="url"
                        autoComplete="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        value={draft.endpoint}
                        onChange={(e) => metadata({ endpoint: e.target.value })}
                        required
                        placeholder="https://your-app.example/mcp"
                      />
                    </label>
                    <p className="field-help">
                      Paste the connection link from your app. We’ll find its tools, then you choose
                      what Relay can use.
                    </p>
                  </>
                )}
                {draft.authentication === 'oauth' && !draft.needsDiscovery && (
                  <p className="field-help">
                    Signed in through your browser.{' '}
                    {draft.signInNeeded
                      ? 'Please sign in again to reconnect.'
                      : 'Relay will keep this connection up to date.'}
                  </p>
                )}
                {(draft.needsDiscovery || !draft.tools.length || draft.signInNeeded) && (
                  <>
                    {draft.signInRequired && (
                      <p className="field-help" role="status">
                        This app needs you to sign in. If it uses a token, enter it in Other
                        connection options.
                      </p>
                    )}
                    <button
                      className="primary-button"
                      type="button"
                      disabled={
                        draft.transport === 'stdio'
                          ? !draft.launch?.command.trim()
                          : !draft.endpoint.trim()
                      }
                      onClick={() =>
                        void (draft.signInRequired || draft.signInNeeded
                          ? beginSignIn()
                          : discover())
                      }
                    >
                      {busy === 'oauth/begin'
                        ? 'Opening sign-in…'
                        : busy === 'prepare'
                          ? 'Checking app…'
                          : draft.signInRequired || draft.signInNeeded
                            ? 'Sign in with browser'
                            : draft.transport === 'stdio'
                              ? 'Run and find tools'
                              : 'Continue'}
                    </button>
                  </>
                )}
                {draft.transport !== 'stdio' && (
                  <details
                    className="app-advanced"
                    open={draft.authentication === 'token' ? true : undefined}
                  >
                    <summary>Other connection options</summary>
                    {!draft.id && (
                      <button
                        className="text-button"
                        type="button"
                        onClick={() => {
                          cancelSignIn();
                          setError('');
                          setDraft({
                            name: '',
                            endpoint: '',
                            token: '',
                            transport: 'stdio',
                            launch: { command: '', args: [], cwd: '/workspace', env: {} },
                            tools: [],
                            assistantIds: null,
                            needsDiscovery: true,
                          });
                        }}
                      >
                        Use a program in Relay’s computer
                      </button>
                    )}
                    <label>
                      Bearer token{' '}
                      <span className="muted">
                        {draft.hasToken ? '· leave blank to keep the saved token' : '· optional'}
                      </span>
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={draft.token}
                        onChange={(e) => metadata({ token: e.target.value })}
                      />
                    </label>
                    <p className="field-help">
                      Use a Streamable HTTP MCP address. Localhost means the computer running Relay,
                      even when you’re on your phone.
                    </p>
                    {(draft.needsDiscovery || !draft.tools.length) && (
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => void discover()}
                      >
                        {busy === 'prepare' ? 'Finding tools…' : 'Find tools'}
                      </button>
                    )}
                    {draft.needsDiscovery && !draft.signInRequired && draft.name && (
                      <button
                        className="text-button"
                        type="button"
                        onClick={() => void beginSignIn()}
                      >
                        Sign in with browser
                      </button>
                    )}
                    <details>
                      <summary>Registered OAuth client</summary>
                      <p className="field-help">
                        Only needed if your app requires its own client registration.
                      </p>
                      <label>
                        Client ID
                        <input
                          autoComplete="off"
                          value={draft.clientId || ''}
                          onChange={(e) => metadata({ clientId: e.target.value })}
                        />
                      </label>
                      <label>
                        Client secret · optional
                        <input
                          type="password"
                          autoComplete="new-password"
                          value={draft.clientSecret || ''}
                          onChange={(e) => metadata({ clientSecret: e.target.value })}
                        />
                      </label>
                    </details>
                  </details>
                )}
                {!!draft.tools.length && !draft.needsDiscovery && (
                  <>
                    <div className="app-tools-heading">
                      <h3>What can Relay use?</h3>
                      <button className="text-button" type="button" onClick={() => void discover()}>
                        {draft.tools.some((t) => t.kind) ? 'Refresh' : 'Refresh tools'}
                      </button>
                    </div>
                    <p className="field-help">
                      {draft.tools.some((t) => t.kind)
                        ? 'Choose what Relay can use. Documents are reads; app templates always ask you first. Only allow automatic reads from an app you trust.'
                        : 'Tools ask before use by default. Only allow a read tool without review if you trust this app’s description of what it does.'}
                    </p>
                    <label className="app-choice">
                      <input
                        type="checkbox"
                        checked={
                          draft.tools.filter((t) => t.readOnly && !t.ownerChoice).length > 0 &&
                          draft.tools
                            .filter((t) => t.readOnly && !t.ownerChoice)
                            .every((t) => t.mode === 'auto')
                        }
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setDraft((d) =>
                            d
                              ? {
                                  ...d,
                                  tools: d.tools.map((t) =>
                                    t.readOnly && !t.ownerChoice
                                      ? { ...t, mode: checked ? 'auto' : 'ask' }
                                      : t,
                                  ),
                                }
                              : d,
                          );
                        }}
                      />
                      Allow trusted read tools without review
                    </label>
                    <div className="app-tool-list">
                      {draft.tools.map((tool) => (
                        <div className="app-tool" key={tool.name}>
                          <div>
                            <strong>{tool.title}</strong>
                            <p>{tool.description}</p>
                            <details>
                              <summary>
                                {tool.kind === 'prompt'
                                  ? 'Template details'
                                  : tool.kind
                                    ? 'Document details'
                                    : 'Tool details'}
                              </summary>
                              <code>{tool.name}</code>
                              <p>
                                {tool.ownerChoice
                                  ? 'App templates always ask you before use.'
                                  : tool.kind
                                    ? 'Reads content supplied by this app. Resource addresses are never opened on your computer.'
                                    : tool.readOnly
                                      ? 'Reported read-only by this app.'
                                      : 'May change data or have other effects.'}
                              </p>
                              <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                            </details>
                          </div>
                          <label>
                            <span className="sr-only">Permission for {tool.title}</span>
                            <select
                              aria-label={`Permission for ${tool.title}`}
                              value={tool.mode}
                              onChange={(e) => policy(tool.name, e.target.value as Tool['mode'])}
                            >
                              <option value="ask">Ask each time</option>
                              {tool.readOnly && !tool.ownerChoice && (
                                <option value="auto">Allow reads</option>
                              )}
                              <option value="off">Off</option>
                            </select>
                          </label>
                        </div>
                      ))}
                    </div>
                    <details className="app-scope">
                      <summary>Who can use this app?</summary>
                      <label className="app-choice">
                        <input
                          type="checkbox"
                          checked={draft.assistantIds === null}
                          onChange={(e) => {
                            const all = e.target.checked;
                            setDraft((d) =>
                              d ? { ...d, assistantIds: all ? null : ['relay'] } : d,
                            );
                          }}
                        />
                        Main and all assistants
                      </label>
                      {draft.assistantIds !== null &&
                        assistants.map((a) => (
                          <label className="app-choice" key={a.id}>
                            <input
                              type="checkbox"
                              checked={draft.assistantIds?.includes(a.id) || false}
                              onChange={(e) => {
                                const checked = e.target.checked;
                                setDraft((d) =>
                                  d
                                    ? {
                                        ...d,
                                        assistantIds: checked
                                          ? [...(d.assistantIds || []), a.id]
                                          : (d.assistantIds || []).filter((id) => id !== a.id),
                                      }
                                    : d,
                                );
                              }}
                            />
                            {a.name}
                          </label>
                        ))}
                    </details>
                    <button
                      className="primary-button"
                      type="submit"
                      disabled={draft.assistantIds?.length === 0}
                    >
                      {busy
                        ? 'Saving…'
                        : draft.id
                          ? 'Save changes'
                          : draft.tools.some((t) => t.kind)
                            ? 'Connect app'
                            : 'Connect selected tools'}
                    </button>
                  </>
                )}
              </fieldset>
              {draft.id && (
                <div className="app-disconnect">
                  {removing === draft.id ? (
                    <>
                      <p>
                        Disconnect this app? Waiting reviews will be cancelled. Your chats and saved
                        files stay.
                      </p>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={!!busy}
                        onClick={() => setRemoving('')}
                      >
                        Keep app
                      </button>
                      <button
                        type="button"
                        className="danger-button"
                        disabled={!!busy}
                        onClick={() => {
                          void request('remove', { id: draft.id }).then(async (result) => {
                            if (result) {
                              setConnections(result.connections);
                              setDraft(null);
                              setRemoving('');
                              await api.refresh();
                              toast('App disconnected.');
                            }
                          });
                        }}
                      >
                        Disconnect app
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="text-button danger-text"
                      disabled={!!busy}
                      onClick={() => setRemoving(draft.id!)}
                    >
                      Disconnect…
                    </button>
                  )}
                </div>
              )}
            </form>
          )}
        </>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
