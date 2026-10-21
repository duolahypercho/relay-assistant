import { useEffect, useRef, useState } from 'react';
import {
  Desktop,
  Play,
  Pause,
  Cursor,
  Folder,
  ArrowUp,
  PaperPlaneTilt,
  ArrowLeft,
  Globe,
  Terminal,
  UploadSimple,
  Copy,
  HandGrabbing,
  Keyboard,
} from '@phosphor-icons/react';
import { api } from '../api';
import { useWorkspace } from '../context';
import LegacyComputer from './LegacyComputer';
import PrivateBrowser from '../components/PrivateBrowser';
import ComputerWebsites, { type ComputerWeb } from '../components/ComputerWebsites';
import './computer.css';
import ComputerJobs from '../components/ComputerJobs';
import ComputerSetup from '../components/ComputerSetup';
import ComputerEngineRecovery from '../components/ComputerEngineRecovery';
import ComputerMaintenance from '../components/ComputerMaintenance';
import ComputerSnapshots from '../components/ComputerSnapshots';
import ComputerTeaching from '../components/ComputerTeaching';
import ComputerDisplay, { type ComputerDisplayHandle } from '../components/ComputerDisplay';
import { copyText, copyTransferredText } from '../copy-text';
import FileDrop, {
  useFileDrop,
  validateFileBatch,
  availableFilename,
} from '../components/FileDrop';
import { fileToPayload } from './Files';

export default function Computer() {
  const { s, go, toast } = useWorkspace();
  const enabled = api.mode() === 'server' && s.connections.runtime?.desktop;
  const privateBrowser = api.mode() === 'server' && s.connections.runtime?.privateBrowser;
  const [mode, setMode] = useState<'browser' | 'desktop'>('browser');
  const showBrowser = privateBrowser && mode === 'browser';
  const modes = privateBrowser && (
    <nav className="computer-modes" aria-label="Computer view">
      <button aria-pressed={mode === 'browser'} onClick={() => setMode('browser')}>
        <Globe size={17} />
        Browser
      </button>
      <button aria-pressed={mode === 'desktop'} onClick={() => setMode('desktop')}>
        <Desktop size={17} />
        Desktop
      </button>
    </nav>
  );
  const [teachingReview, setTeachingReview] = useState(false);
  const [legacy, setLegacy] = useState(false);
  const [state, setState] = useState<any>({ state: enabled ? 'loading' : 'disabled' });
  const [frame, setFrame] = useState<any>(null);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [engineRecovery, setEngineRecovery] = useState(false);
  const [busy, setBusy] = useState('');
  const [text, setText] = useState('');
  const [directKeyboard, setDirectKeyboard] = useState(false);
  const [command, setCommand] = useState('');
  const [path, setPath] = useState('.');
  const [files, setFiles] = useState<any[]>([]);
  const [filesOpen, setFilesOpen] = useState(false);
  const [fileId, setFileId] = useState('');
  const [zoom, setZoom] = useState(false);
  const [touchDrag, setTouchDrag] = useState(false);
  const [inputPending, setInputPending] = useState(false);
  const [clipboardText, setClipboardText] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  const clipboardBusy = useRef(false);
  const displayInput = useRef<ComputerDisplayHandle>(null);
  const mounted = useRef(true);
  const working = useRef(false);
  const sequence = useRef(0);
  const filesView = useRef({ open: filesOpen, path });
  const folderRequest = useRef(0);
  filesView.current = { open: filesOpen, path };
  const uploadInput = useRef<HTMLInputElement>(null);
  const running = state.state === 'running';
  const starting = state.state === 'starting' || busy === 'Starting…';
  const refreshing = state.state === 'updating';
  const controlling = state.controller === 'owner';
  useEffect(() => {
    if (!controlling || !running || showBrowser) setClipboardText(null);
    if (!controlling || !running || showBrowser || zoom) setTouchDrag(false);
  }, [controlling, running, showBrowser, zoom]);
  async function copyFromComputer(load: () => Promise<string>) {
    if (clipboardBusy.current || !controlling) return;
    clipboardBusy.current = true;
    setCopying(true);
    setClipboardText(null);
    try {
      const result = await copyTransferredText(load);
      if (mounted.current) {
        if (result.copied) toast('Copied to your device.');
        else setClipboardText(result.text);
      }
    } catch (e: any) {
      if (mounted.current && e.name !== 'AbortError') setError(e.message);
    } finally {
      clipboardBusy.current = false;
      if (mounted.current) setCopying(false);
    }
  }
  async function refresh() {
    const version = ++sequence.current;
    const next = await api.request('/computer/screen');
    const screen = next.state === 'running' ? next : null;
    if (!mounted.current || version !== sequence.current) return;
    setState((previous: any) => {
      const web =
        (previous.web?.revision ?? -1) > (next.web?.revision ?? -1) ? previous.web : next.web;
      return {
        ...next,
        web,
        network: web?.sites?.some((site: any) => site.status === 'allowed')
          ? 'approved-sites'
          : 'offline',
      };
    });
    setFrame(screen);
    setPollError(next.workspaceMissing ? '' : next.powerError || next.error || '');
    const listing = filesView.current;
    const folderVersion = folderRequest.current;
    if (screen && listing.open) {
      try {
        const result = await api.request(
          `/computer/files?path=${encodeURIComponent(listing.path)}`,
        );
        if (
          mounted.current &&
          version === sequence.current &&
          folderVersion === folderRequest.current &&
          filesView.current.open &&
          filesView.current.path === listing.path
        )
          setFiles(result.entries);
      } catch {
        // Keep the last folder on a background refresh failure; explicit folder
        // navigation still reports its own error. Never replace a newer folder.
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    async function poll() {
      if (!enabled || legacy || showBrowser || stopped) return;
      try {
        if (!working.current && !document.hidden) await refresh();
      } catch (e: any) {
        if (!stopped) setPollError(e.message);
      }
      if (!stopped) timer = setTimeout(() => void poll(), 1500);
    }
    void poll();
    return () => {
      stopped = true;
      mounted.current = false;
      sequence.current++;
      clearTimeout(timer);
    };
  }, [enabled, legacy, showBrowser]);
  async function action(label: string, endpoint: string, payload?: any) {
    if (working.current) return;
    working.current = true;
    sequence.current++;
    setBusy(label);
    setError('');
    try {
      const result = await api.request(`/computer/${endpoint}`, {
        method: 'POST',
        body: JSON.stringify(payload || {}),
      });
      if (mounted.current) {
        if (endpoint === 'release' || endpoint === 'stop') setZoom(false);
        if (result.controller)
          setState((previous: any) => ({ ...previous, controller: result.controller }));
        if (result.screenshot) setFrame(result);
        await refresh();
      }
      return result;
    } catch (e: any) {
      if (mounted.current) setError(e.message);
      if (endpoint === 'clipboard') throw e;
    } finally {
      working.current = false;
      if (mounted.current) setBusy('');
    }
  }
  const input = (payload: any) =>
    payload.kind === 'clipboard'
      ? action('Updating…', 'clipboard', { action: payload.action })
      : action('Updating…', 'action', {
          kind: 'desktop',
          operationId: crypto.randomUUID(),
          ...payload,
        });
  async function loadFiles(nextPath = path) {
    const version = ++folderRequest.current;
    try {
      const result = await api.request(`/computer/files?path=${encodeURIComponent(nextPath)}`);
      if (!mounted.current || version !== folderRequest.current) return;
      // Invalidate refreshes that began while this navigation was in flight.
      folderRequest.current++;
      setFiles(result.entries);
      setPath(nextPath);
    } catch (e: any) {
      if (mounted.current && version === folderRequest.current) setError(e.message);
    }
  }
  async function openDocument(
    payload: { action: 'open'; path: string } | { action: 'new'; app: string },
  ) {
    const result = await action('Opening…', 'action', {
      kind: 'app',
      operationId: crypto.randomUUID(),
      ...payload,
    });
    if (result?.launched && mounted.current) {
      document
        .querySelector('.computer-viewport')
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
  async function uploadFiles(selected: File[]) {
    if (!selected.length || working.current || inputPending || !running || !controlling) return;
    working.current = true;
    sequence.current++;
    setBusy('Adding files…');
    setError('');
    let copied = 0;
    try {
      validateFileBatch(selected, 8, 8_000_000);
      const existing = await api.request(`/computer/files?path=${encodeURIComponent(path)}`);
      const names = new Set<string>(existing.entries.map((entry: any) => entry.name));
      for (const file of selected) {
        const name = availableFilename(file.name, names);
        const { base64 } = await fileToPayload(file);
        await api.request('/computer/action', {
          method: 'POST',
          body: JSON.stringify({
            kind: 'files',
            action: 'write',
            path: `${path}/${name}`,
            base64,
            operationId: crypto.randomUUID(),
          }),
        });
        copied++;
      }
      if (mounted.current)
        toast(`Added ${copied === 1 ? '1 file' : `${copied} files`} to the computer.`);
    } catch (e: any) {
      if (mounted.current)
        setError(
          `${copied ? `${copied} ${copied === 1 ? 'file was' : 'files were'} added. ` : ''}${e.message}`,
        );
    } finally {
      if (mounted.current) {
        if (copied) {
          setFilesOpen(true);
          await loadFiles();
        }
        setBusy('');
        if (uploadInput.current) uploadInput.current.value = '';
      }
      working.current = false;
    }
  }
  const drop = useFileDrop(uploadFiles, setError, running && controlling && !busy && !inputPending);
  if (showBrowser)
    return (
      <section className="computer-page" aria-label="Private computer">
        <div className="computer-intro">
          <h2>Relay’s computer</h2>
        </div>
        {modes}
        <PrivateBrowser />
      </section>
    );
  if (legacy)
    return (
      <section className="computer-page">
        <button className="text-button" onClick={() => setLegacy(false)}>
          <ArrowLeft size={17} /> Back to desktop
        </button>
        <LegacyComputer />
      </section>
    );
  return (
    <section
      className={`computer-page ${directKeyboard ? 'is-keyboard-open' : ''} ${state.managedEngine && !running ? 'is-managed-rest' : ''}`}
      aria-label="Private computer"
    >
      <div className="computer-intro">
        <div>
          <h2>Relay’s computer</h2>
        </div>
      </div>
      {modes}
      {(error || (pollError && !engineRecovery)) && (
        <div className="computer-error" role="alert">
          {error || pollError}
          <button
            className="text-button"
            onClick={() =>
              error
                ? setError('')
                : state.powerError
                  ? void action('Stopping…', 'stop')
                  : void refresh().catch((e) => setPollError(e.message))
            }
          >
            {error ? 'Dismiss' : 'Try again'}
          </button>
        </div>
      )}
      <div
        hidden={teachingReview}
        className={`computer-window file-drop-target ${controlling ? 'has-control' : ''}`}
        {...drop.dropProps}
      >
        {drop.dragging && (
          <FileDrop
            title={
              !running
                ? 'Start the computer to add files'
                : !controlling
                  ? 'Take control to add files'
                  : busy || inputPending
                    ? 'Finishing the current action…'
                    : 'Drop files onto the computer'
            }
            hint={
              controlling && running
                ? `Add to /workspace/${path === '.' ? '' : path.replace(/^\.\//, '')}. Existing files are kept.`
                : 'Your files stay on your device until you add them.'
            }
          />
        )}
        <div className="computer-window-bar">
          <span className={`computer-status ${running ? 'is-running' : ''}`}>
            <i />
            {state.state === 'loading'
              ? 'Connecting…'
              : state.state === 'stopping'
                ? 'Stopping…'
                : state.state === 'updating'
                  ? 'Refreshing…'
                  : state.state === 'switching'
                    ? 'Switching control…'
                    : starting
                      ? 'Starting…'
                      : running
                        ? controlling
                          ? 'You’re in control'
                          : state.active
                            ? 'Relay is working'
                            : 'Ready for Relay'
                        : state.workspaceMissing
                          ? 'Needs recovery'
                          : 'Resting'}
          </span>
          <div>
            {(running || state.needsUpdate) && (
              <>
                <button
                  className={controlling ? 'primary-button' : 'secondary-button'}
                  disabled={!!busy || inputPending || (state.needsUpdate && !controlling)}
                  onClick={() => void action('Switching…', controlling ? 'release' : 'takeControl')}
                >
                  <Cursor size={16} />
                  {controlling ? 'Give back to Relay' : 'Take control'}
                </button>
                {(running || state.needsUpdate) && (
                  <button
                    className="icon-button"
                    aria-label="Stop computer and keep files"
                    title="Stop computer and keep files"
                    disabled={!!busy || inputPending}
                    onClick={() => void action('Stopping…', 'stop')}
                  >
                    <Pause size={18} />
                  </button>
                )}
              </>
            )}
          </div>
        </div>
        {running && frame?.screenshot ? (
          <>
            <div className={`computer-viewport ${zoom ? 'is-zoomed' : ''}`}>
              <ComputerDisplay
                ref={displayInput}
                frame={frame}
                enabled={controlling && (!busy || busy === 'Updating…')}
                zoom={zoom}
                touchDrag={touchDrag}
                send={input}
                onKeyboardChange={setDirectKeyboard}
                onPending={setInputPending}
                onError={setError}
                onCopy={(load) => void copyFromComputer(load)}
              />
            </div>
            {controlling && (
              <div className="computer-input">
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (directKeyboard || !text) return;
                    const field = e.currentTarget.querySelector('input');
                    if (await input({ action: 'type', text })) {
                      setText('');
                      if (window.matchMedia('(pointer: coarse)').matches) field?.blur();
                    }
                  }}
                >
                  <button
                    className="icon-button computer-touch-keyboard"
                    type="button"
                    aria-label={
                      directKeyboard ? 'Hide computer keyboard' : 'Show computer keyboard'
                    }
                    aria-pressed={directKeyboard}
                    title={
                      directKeyboard ? 'Hide computer keyboard' : 'Type directly on the computer'
                    }
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={(event) => {
                      event.preventDefault();
                      if (directKeyboard) displayInput.current?.hideKeyboard();
                      else displayInput.current?.showKeyboard();
                    }}
                  >
                    <Keyboard size={20} />
                  </button>
                  {directKeyboard ? (
                    <>
                      <span className="computer-keyboard-note" role="status">
                        Typing on the computer
                      </span>
                      <button
                        className="text-button"
                        type="button"
                        onPointerDown={(event) => event.preventDefault()}
                        onClick={(event) => {
                          // Blur replaces this control with the buffered form's
                          // submit button before the browser's default click.
                          event.preventDefault();
                          displayInput.current?.hideKeyboard();
                        }}
                      >
                        Done
                      </button>
                    </>
                  ) : (
                    <>
                      <input
                        aria-label="Type on the computer"
                        autoComplete="off"
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                        placeholder="Type on the computer…"
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        maxLength={4000}
                      />
                      <button
                        className="icon-button"
                        type="submit"
                        aria-label="Type text"
                        disabled={!!busy || inputPending || !text}
                      >
                        <PaperPlaneTilt size={18} />
                      </button>
                    </>
                  )}
                </form>
                <div className="computer-input-actions" aria-label="Desktop controls">
                  <button className="secondary-button" onClick={() => setZoom(!zoom)}>
                    {zoom ? 'Fit screen' : 'Zoom in'}
                  </button>
                  <button
                    className="secondary-button"
                    aria-label="Copy text from computer"
                    disabled={!!busy || inputPending || copying}
                    onClick={() => displayInput.current?.copy()}
                  >
                    <Copy size={16} /> {copying ? 'Copying…' : 'Copy'}
                  </button>
                  <button
                    className="secondary-button computer-touch-drag"
                    aria-label="Drag on the computer"
                    aria-pressed={touchDrag}
                    disabled={zoom || !!busy || inputPending}
                    onClick={() => setTouchDrag(!touchDrag)}
                  >
                    <HandGrabbing size={16} /> Drag
                  </button>
                  <button
                    className="secondary-button"
                    disabled={!!busy || inputPending}
                    onClick={() => void input({ action: 'key', key: 'Return' })}
                  >
                    Enter
                  </button>
                  <button
                    className="secondary-button"
                    disabled={!!busy || inputPending}
                    onClick={() => void input({ action: 'key', key: 'Tab' })}
                  >
                    Tab
                  </button>
                </div>
              </div>
            )}
            {controlling && clipboardText !== null && (
              <section className="computer-clipboard" aria-label="Text from computer">
                <p>Your device blocked clipboard access. Select and copy the text here.</p>
                <textarea
                  aria-label="Copied computer text"
                  value={clipboardText}
                  readOnly
                  onFocus={(event) => event.currentTarget.select()}
                />
                <div>
                  <button
                    className="secondary-button"
                    onClick={async () => {
                      try {
                        await copyText(clipboardText);
                        setClipboardText(null);
                        toast('Copied to your device.');
                      } catch {
                        setError('Select the text above and use your device’s Copy command.');
                      }
                    }}
                  >
                    Copy to device
                  </button>
                  <button className="text-button" onClick={() => setClipboardText(null)}>
                    Dismiss
                  </button>
                </div>
              </section>
            )}
          </>
        ) : (
          <div className={`computer-rest ${state.workspaceMissing ? 'is-missing' : ''}`}>
            <div className="computer-rest-icon">
              <Desktop size={40} weight="duotone" />
            </div>
            <h3>
              {enabled
                ? state.workspaceMissing
                  ? 'Your saved workspace could not be found.'
                  : state.state === 'stopping'
                    ? 'Putting your computer to rest…'
                    : starting
                      ? 'Making room for your ideas…'
                      : 'Ready when you are.'
                : 'Room to get things done'}
            </h3>
            {state.workspaceMissing ? (
              <p>
                Restore a saved copy below, or choose a new empty workspace. If you connected a
                different computer server, reconnect the original one to find its files.
              </p>
            ) : (
              !(enabled && state.managedEngine) && (
                <p>
                  {enabled
                    ? 'Your files stay here when the computer rests. Relay can start it when a task needs it.'
                    : 'Give Relay a workspace to make documents, run code, and work with the files you share.'}
                </p>
              )
            )}
            {state.workspaceMissing ? null : enabled ? (
              <ComputerEngineRecovery onReady={refresh} onAvailable={setEngineRecovery}>
                <button
                  className="primary-button"
                  disabled={!!busy || starting || refreshing || state.state === 'loading'}
                  onClick={() => void action('Starting…', 'start')}
                >
                  <Play size={17} weight="fill" />
                  {refreshing ? 'Refreshing…' : starting ? 'Starting…' : busy || 'Start computer'}
                </button>
              </ComputerEngineRecovery>
            ) : (
              <ComputerSetup />
            )}
          </div>
        )}
        <div className="computer-footer">
          <span>
            {busy ||
              (!running
                ? state.workspaceMissing
                  ? 'Recovery keeps your chat history intact'
                  : 'Saved files stay on your private computer'
                : controlling
                  ? touchDrag
                    ? 'Drag is on. Turn it off to scroll this page.'
                    : 'Click or tap to work here. Your files stay separate.'
                  : state.network === 'approved-sites'
                    ? 'Approved website connections · Your computer stays separate'
                    : 'Offline workspace · Your own files and apps stay separate')}
          </span>
          {running && (
            <button
              className="text-button"
              onClick={() => {
                setFilesOpen(!filesOpen);
                if (!filesOpen) void loadFiles();
              }}
            >
              <Folder size={16} />
              Files
            </button>
          )}
        </div>
      </div>
      {enabled && <ComputerSnapshots onChanged={refresh} missing={!!state.workspaceMissing} />}
      {enabled && !state.workspaceMissing && (
        <ComputerTeaching onChanged={refresh} onReview={setTeachingReview} />
      )}
      {controlling && running && (
        <div className="computer-upload">
          <input
            type="file"
            multiple
            hidden
            ref={uploadInput}
            onChange={(event) => void uploadFiles(Array.from(event.target.files || []))}
          />
          <button
            className="secondary-button"
            disabled={!!busy || inputPending}
            onClick={() => uploadInput.current?.click()}
          >
            <UploadSimple size={18} />
            {busy === 'Adding files…' ? busy : 'Add files from your device'}
          </button>
          <p>Or drop them onto the computer. Up to 8 files, 8 MB each.</p>
        </div>
      )}
      {filesOpen && running && (
        <section className="computer-files" aria-label="Computer files">
          <header>
            <h3>Files on this computer</h3>
            <button className="text-button" onClick={() => go('files')}>
              Saved in Relay
            </button>
          </header>
          {controlling && state.apps?.length > 0 && (
            <div className="computer-create" aria-label="Create on the computer">
              <span>New</span>
              {state.apps
                .filter((app: any) => ['writer', 'calc', 'impress'].includes(app.id))
                .map((app: any) => (
                  <button
                    key={app.id}
                    className="text-button"
                    disabled={!!busy || inputPending}
                    onClick={() => void openDocument({ action: 'new', app: app.id })}
                  >
                    {app.label}
                  </button>
                ))}
            </div>
          )}
          <div className="computer-file-path">
            <button
              className="icon-button"
              aria-label="Parent folder"
              disabled={path === '.'}
              onClick={() => void loadFiles(path.split('/').slice(0, -1).join('/') || '.')}
            >
              <ArrowUp size={17} />
            </button>
            <span>/workspace/{path === '.' ? '' : path.replace(/^\.\//, '')}</span>
          </div>
          {files
            .filter((f) => !f.name.startsWith('.'))
            .map((f) => (
              <div className="computer-file-row" key={f.name}>
                <span>{f.name}</span>
                {f.kind === 'directory' ? (
                  <button
                    className="text-button"
                    onClick={() => void loadFiles(`${path}/${f.name}`)}
                  >
                    Open
                  </button>
                ) : f.kind === 'file' ? (
                  <div className="computer-file-actions">
                    {controlling &&
                      state.apps?.some((app: any) =>
                        app.extensions?.includes(f.name.split('.').pop()?.toLowerCase()),
                      ) && (
                        <button
                          className="text-button"
                          aria-label={`Open ${f.name}`}
                          disabled={!!busy || inputPending}
                          onClick={() =>
                            void openDocument({ action: 'open', path: `${path}/${f.name}` })
                          }
                        >
                          Open
                        </button>
                      )}
                    <button
                      className="text-button"
                      disabled={!!busy || inputPending}
                      onClick={async () => {
                        if (await action('Saving…', 'export', { path: `${path}/${f.name}` }))
                          toast('Saved to your Relay files.');
                      }}
                    >
                      Save to Relay
                    </button>
                  </div>
                ) : (
                  <span>Link</span>
                )}
              </div>
            ))}
          {!files.filter((f) => !f.name.startsWith('.')).length && (
            <p className="muted">Your finished work will appear here.</p>
          )}
          {controlling && s.files.length > 0 && (
            <form
              className="computer-import"
              onSubmit={async (e) => {
                e.preventDefault();
                const f = s.files.find((f) => f.id === fileId);
                if (!f) return;
                if (
                  await action('Copying…', 'import', {
                    fileId,
                    path: `${path}/${f.name}`,
                    operationId: crypto.randomUUID(),
                  })
                ) {
                  await loadFiles();
                  setFileId('');
                }
              }}
            >
              <select
                aria-label="File to copy to computer"
                value={fileId}
                onChange={(e) => setFileId(e.target.value)}
              >
                <option value="">Choose a Relay file…</option>
                {s.files.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
              <button className="secondary-button" disabled={!fileId || !!busy}>
                Copy here
              </button>
            </form>
          )}
        </section>
      )}
      <ComputerWebsites
        web={state.web || {}}
        controlling={controlling}
        onChange={(web: ComputerWeb) => {
          setState((previous: any) =>
            (previous.web?.revision ?? -1) > (web.revision ?? -1)
              ? previous
              : {
                  ...previous,
                  web,
                  network: web.sites?.some((site) => site.status === 'allowed')
                    ? 'approved-sites'
                    : 'offline',
                },
          );
        }}
      />
      <div className="computer-secondary">
        <button className="text-button" onClick={() => setLegacy(true)}>
          <Globe size={17} />
          Public web browser
        </button>
        <span>For online research</span>
      </div>
      {enabled && (
        <details className="computer-tools">
          <summary>
            <Terminal size={17} />
            Commands & activity
          </summary>
          <p className="muted">
            Usually, just ask Relay in chat. Commands run only on this private computer.
          </p>
          <ComputerJobs />
          {controlling && running ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                await action('Running…', 'action', {
                  kind: 'exec',
                  command,
                  operationId: crypto.randomUUID(),
                });
              }}
            >
              <textarea
                aria-label="Private computer command"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="python3 --version"
                maxLength={8000}
                rows={2}
              />
              <button className="secondary-button" disabled={!!busy || !command.trim()}>
                Run command
              </button>
            </form>
          ) : (
            <p className="muted">Take control to run a command yourself.</p>
          )}
          {busy === 'Running…' && (
            <button
              className="text-button danger-text"
              onClick={() =>
                void api
                  .request('/computer/cancel', { method: 'POST', body: '{}' })
                  .catch((e) => setError(e.message))
              }
            >
              Stop command
            </button>
          )}
          <div className="computer-receipts">
            {state.receipts?.map((r: any) => (
              <details key={r.id}>
                <summary>
                  {r.label} <span>{r.status}</span>
                </summary>
                <pre>
                  {r.result.stdout || r.result.error || JSON.stringify(r.result, null, 2)}
                  {r.result.stderr ? '\n' + r.result.stderr : ''}
                </pre>
              </details>
            ))}
          </div>
        </details>
      )}
      {enabled && !state.snapshotBlocked && !state.workspaceMissing && !engineRecovery && (
        <ComputerMaintenance
          unavailable={state.state === 'unavailable' || !!pollError}
          onChanged={refresh}
        />
      )}
    </section>
  );
}
