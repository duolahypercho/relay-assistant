import { createWorkspace } from '../shared/seed.mjs';
import { command } from '../shared/domain.mjs';
import type { Workspace } from './types';
import { isNativeMobile, mobileConnection } from './native-mobile';
type Listener = () => void;
let listeners = new Set<Listener>();
let current: Workspace = createWorkspace() as unknown as Workspace;
let mode: 'loading' | 'sample' | 'server' = 'loading';
let authenticated = true;
let status = '';
let startupError = '';
let connection: 'connecting' | 'connected' | 'offline' | 'signin' | 'sample' = 'connecting';
let generation = 0;
let lifecycleInstalled = false;
let initializing: Promise<boolean> | null = null;
let db: IDBDatabase | null = null;
let polling: ReturnType<typeof setInterval> | null = null;
let events: EventSource | null = null;
export const api = {
  snapshot: () => current,
  mode: () => mode,
  authenticated: () => authenticated,
  status: () => status,
  startupError: () => startupError,
  connection: () => connection,
  subscribe(fn: Listener) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  init(): Promise<boolean> {
    if (initializing) return initializing;
    initializing = initialize().finally(() => {
      initializing = null;
    });
    return initializing;
  },
  async act(action: string, payload: Record<string, any> = {}) {
    if (mode === 'server') {
      const version = generation;
      const res = await serverFetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, payload }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'The request failed.');
      if (authenticated && version === generation) acceptSnapshot(data.state);
      return data.result;
    }
    if (mode !== 'sample') throw new Error('Reconnect to your workspace before making changes.');
    const next = structuredClone(current);
    const result = command(next, action, payload);
    current = next;
    await save();
    emit();
    return result;
  },
  async mutate(fn: (state: Workspace) => void) {
    if (mode !== 'sample') return;
    const next = structuredClone(current);
    fn(next);
    current = next;
    await save();
    emit();
  },
  async login(key: string) {
    let res: Response;
    try {
      res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error('Your server could not be reached. Try again when connected.');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'That access key was not accepted.');
    if (!(await api.init()))
      throw new Error('Your workspace could not be opened. Try signing in again.');
  },
  fetch(path: string, options: RequestInit = {}) {
    return serverFetch(`/api${path}`, options);
  },
  async request(path: string, options: RequestInit = {}) {
    const res = await serverFetch(`/api${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
    const body = await res.json();
    if (!res.ok)
      throw Object.assign(new Error(body.error || 'The request failed.'), { status: res.status });
    return body;
  },
  async refresh() {
    if (mode !== 'server' || !authenticated) return;
    const version = generation;
    try {
      const res = await serverFetch('/api/state', { signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const state = await res.json();
        if (authenticated && version === generation) {
          connection = 'connected';
          status = '';
          acceptSnapshot(state);
          emit();
        }
      } else if (version === generation) {
        setOffline('The server could not refresh your workspace.');
      }
    } catch {
      /* serverFetch exposes a single recoverable state. */
    }
  },
  async reset() {
    if (mode === 'sample') {
      current = createWorkspace() as unknown as Workspace;
      await save();
      emit();
    }
  },
};
async function initialize() {
  startupError = '';
  stopPolling();
  connection = 'connecting';
  emit();
  const desktop = !!(window as any).relayNative;
  let knownServer = mode === 'server';
  try {
    knownServer ||= localStorage.getItem('relay:server-origin') === location.origin;
  } catch {}
  try {
    const res = await fetch('/api/state', {
      signal: AbortSignal.timeout(desktop || isNativeMobile || knownServer ? 15000 : 1800),
    });
    if (res.status === 401) {
      mode = 'server';
      rememberServer();
      requireSignIn();
      return false;
    }
    if (res.ok && res.headers.get('content-type')?.includes('json')) {
      current = await res.json();
      mode = 'server';
      authenticated = true;
      connection = 'connected';
      status = '';
      rememberServer();
      emit();
      startPolling();
      return true;
    }
  } catch {
    /* Static preview uses a device-local sample workspace. */
  }
  if (desktop || knownServer) {
    // The native app always owns a server. Falling back here would save edits
    // into an unrelated IndexedDB sample when the host is slow or unavailable.
    mode = 'loading';
    startupError = 'Your workspace could not be reached. Your saved work stays on the server.';
    connection = 'offline';
    emit();
    return false;
  }
  if (isNativeMobile) {
    try {
      const mobile = await mobileConnection.status();
      if (mobile.url) {
        startupError = 'Your server is unreachable. Your work stays saved there.';
        connection = 'offline';
        emit();
        return false;
      }
    } catch {
      startupError = 'The mobile connection could not be checked. Reopen Relay and try again.';
      connection = 'offline';
      emit();
      return false;
    }
  }
  try {
    db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('relay-sample', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('workspace');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const saved = await new Promise<Workspace | undefined>((resolve, reject) => {
      const r = db!.transaction('workspace').objectStore('workspace').get('state');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    if (saved?.schema === 1) current = saved;
  } catch {
    status = 'Your browser is blocking storage. Changes last for this tab.';
  }
  mode = 'sample';
  connection = 'sample';
  authenticated = true;
  emit();
  const { startSampleWorker } = await import('./sample');
  startSampleWorker();
  return true;
}
function rememberServer() {
  try {
    localStorage.setItem('relay:server-origin', location.origin);
  } catch {}
}
function stopPolling() {
  generation++;
  if (polling) clearInterval(polling);
  polling = null;
  events?.close();
  events = null;
}
function requireSignIn() {
  authenticated = false;
  connection = 'signin';
  status = '';
  stopPolling();
  emit();
}
function setOffline(
  message = 'Connection interrupted. Your unfinished message stays on this device.',
) {
  if (!authenticated || mode !== 'server') return;
  connection = 'offline';
  status = message;
  emit();
}
async function serverFetch(path: string, options: RequestInit = {}) {
  if (mode === 'server' && !authenticated)
    throw new Error('Sign in to continue. Your draft is kept.');
  const version = generation;
  let res: Response;
  try {
    res = await fetch(path, options);
  } catch {
    if (options.signal?.aborted) throw options.signal.reason;
    if (version === generation) setOffline();
    throw new Error('Connection interrupted. Reconnect and try again.');
  }
  if (res.status === 401 && mode === 'server') {
    if (version === generation) requireSignIn();
    throw new Error('Sign in to continue. Your draft is kept.');
  }
  return res;
}
function emit() {
  current = { ...current };
  listeners.forEach((fn) => fn());
}
function acceptSnapshot(next: Workspace) {
  if (next.revision >= current.revision) {
    current = next;
    emit();
  }
}
async function save() {
  if (db)
    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction('workspace', 'readwrite');
      tx.objectStore('workspace').put(current, 'state');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
}
function startPolling() {
  stopPolling();
  const version = generation;
  events = new EventSource('/api/events');
  events.onmessage = (e) => {
    try {
      if (authenticated && version === generation) {
        connection = 'connected';
        status = '';
        acceptSnapshot(JSON.parse(e.data));
        emit();
      }
    } catch {}
  };
  events.addEventListener('signin', () => {
    if (version === generation) requireSignIn();
  });
  events.onerror = () => {
    if (version === generation) void api.refresh();
  };
  polling = setInterval(() => {
    if (document.visibilityState === 'visible') void api.refresh();
  }, 5000);
  if (!lifecycleInstalled) {
    lifecycleInstalled = true;
    window.addEventListener('online', () => void api.refresh());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void api.refresh();
    });
  }
}
