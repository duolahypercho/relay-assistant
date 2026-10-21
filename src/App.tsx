import { filePreviewHash, filePreviewRoute } from '../shared/file-navigation.mjs';
import ConversationActions from './components/ConversationActions';
import { modelSetupHash } from '../shared/model-setup-navigation.mjs';
import { requestFileDraft } from './chat-file-draft';
import { conversationUnread, pinnedFirst } from '../shared/chat-list.mjs';
import { tr, useDocumentLanguage } from './i18n';
import { shortcutCommand } from '../shared/shortcuts.mjs';
import DeviceAttention from './components/DeviceAttention';
import { attentionEvents, attentionTarget } from '../shared/attention.mjs';
import './components/notifications.css';
import MobileShares from './components/MobileShares';
import NativeTemplateLinks from './components/NativeTemplateLinks';
import GroupEditor from './components/GroupEditor';
import './views/assistants.css';
import { assistantForThread, threadAssistantId } from '../shared/assistant-scope.mjs';
import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useState,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  Bell,
  SidebarSimple,
  X,
  Spinner,
  Lock,
  MagnifyingGlass,
  Brain,
  Desktop,
  GearSix,
  NotePencil,
  UsersThree,
  Archive,
  ArrowLeft,
  ArrowCounterClockwise,
  PushPin,
} from '@phosphor-icons/react';
import { api } from './api';
import { Context } from './context';
import type { Page, Entity } from './types';
import { settingsRoute, type SettingsSection } from './navigation';
import Chat from './views/Chat';
import { surfaces } from '../shared/surfaces.mjs';
import { registerWorkspaceTools } from './webmcp';
import AssistantDetails, { assistantStatus, AssistantAvatar } from './components/Assistant';
import Search from './components/Search';
import Companion from './components/Companion';
import { usePreventFileNavigation } from './components/FileDrop';
import { NativeServerButton } from './components/NativeConnection';
const WorkspacePage = lazy(() => import('./components/WorkspacePage'));
function routePage(): Page {
  const value = location.hash.slice(1).split(/[/?]/)[0];
  return Object.hasOwn(surfaces, value) || value === 'settings' || value === 'more'
    ? (value as Page)
    : 'chat';
}
function chatRoute() {
  const match = /^#chat\/([a-zA-Z0-9_-]+)(?:\/([a-zA-Z0-9_-]+))?$/.exec(location.hash);
  return match ? { id: match[1], messageId: match[2] || '' } : null;
}
function chatHash(id: string, messageId = '') {
  return id === 'main' && !messageId ? '#chat' : `#chat/${id}${messageId ? `/${messageId}` : ''}`;
}
function artifactRoute() {
  const match = /^#files\/([a-zA-Z0-9_-]+)(?:\/(\d+))?$/.exec(location.hash);
  return match
    ? { id: match[1], version: match[2] ? Number(match[2]) : undefined }
    : { id: '', version: undefined };
}
class PageBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(e: Error) {
    return { error: e.message };
  }
  render() {
    return this.state.error ? (
      <div className="empty-state" role="alert">
        <h2>This view could not open</h2>
        <p>{this.state.error}</p>
        <button className="primary-button" onClick={() => location.reload()}>
          Reload workspace
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
function Login() {
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="login-page">
      <div className="login-card">
        <span className="brand-mark">
          r<span>↗</span>
        </span>
        <h1>{tr('Welcome to your space.')}</h1>
        <p>
          {api.snapshot().connections.runtime
            ? tr('Sign in to continue. Your unfinished message is kept on this device.')
            : tr('Enter the access key configured on your Relay server.')}
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setError('');
            setBusy(true);
            try {
              await api.login(key);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="field">
            <span>{tr('Server access key')}</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoFocus
            />
          </label>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary-button" type="submit" disabled={busy}>
            <Lock size={18} />
            {busy ? tr('Signing in…') : tr('Open workspace')}
          </button>
        </form>
        <NativeServerButton />
      </div>
    </div>
  );
}
export default function App() {
  useDocumentLanguage();
  usePreventFileNavigation();
  const s = useSyncExternalStore(api.subscribe, api.snapshot);
  const [page, setPage] = useState<Page>(routePage);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | undefined>(
    settingsRoute,
  );
  const [taskId, setTaskId] = useState('');
  const [reviewId, setReviewId] = useState('');
  const [threadId, setThreadId] = useState(() => {
    if (chatRoute()) return chatRoute()!.id;
    if (filePreviewRoute(location.hash)) return filePreviewRoute(location.hash)!.threadId;
    try {
      return sessionStorage.getItem('relay-selected-thread') || 'main';
    } catch {
      return 'main';
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem('relay-selected-thread', threadId);
    } catch {}
  }, [threadId]);
  const identity = assistantForThread(s, threadId);
  const [focusMessageId, setFocusMessageId] = useState(chatRoute()?.messageId || '');
  const [focusSerial, setFocusSerial] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchScope, setSearchScope] = useState<'workspace' | 'chat' | 'chats'>('workspace');
  const commandRef = useRef<(name: string, event?: KeyboardEvent) => boolean>(() => false);
  const searchToggle = useRef<HTMLButtonElement>(null);
  const [assistantTab, setAssistantTab] = useState<'activity' | 'memory' | 'access' | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarToggle = useRef<HTMLButtonElement>(null);
  const sidebarClose = useRef<HTMLButtonElement>(null);
  const [narrow, setNarrow] = useState(matchMedia('(max-width: 720px)').matches);
  const [notice, setNotice] = useState('');
  const [noticeError, setNoticeError] = useState(false);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const notices = attentionEvents(s);
  const hasUnread = (id: string) => conversationUnread(s, id, notices);
  const [creatingThread, setCreatingThread] = useState(false);
  const creatingThreadRef = useRef(false);
  const newConversationRef = useRef<() => Promise<void>>(async () => {});
  const [groupEditor, setGroupEditor] = useState(false);
  const [editingGroup, setEditingGroup] = useState<Entity | undefined>();
  const selectedConversationId =
    s.threads.find((t) => t.id === threadId)?.replyTo?.threadId || threadId;
  const activeGroup = s.threads.find((t) => t.id === selectedConversationId && t.participantIds);
  const [archivedChats, setArchivedChats] = useState(false);
  const [fileId, setFileId] = useState(() => filePreviewRoute(location.hash)?.id || '');
  const [artifactRef, setArtifactRef] = useState(artifactRoute);
  const fileTrigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (page !== 'chat' || fileId || !fileTrigger.current) return;
    const trigger = fileTrigger.current;
    fileTrigger.current = null;
    if (trigger.isConnected && !trigger.closest('[inert]')) trigger.focus({ preventScroll: true });
  }, [page, fileId]);
  const closeSidebar = () => {
    setSidebarOpen(false);
    requestAnimationFrame(() => sidebarToggle.current?.focus());
  };
  const go = (p: Page, section?: SettingsSection, targetHash?: string) => {
    setFileId('');
    setSettingsSection(p === 'settings' ? section : undefined);
    setArtifactRef({ id: '', version: undefined });
    setSidebarOpen(false);
    setAssistantTab(null);
    setTaskId('');
    setReviewId('');
    setPage(p);
    const hash =
      targetHash ||
      (p === 'chat'
        ? chatHash(threadId)
        : `#${p}${p === 'settings' && section ? `?section=${section}` : ''}`);
    if (location.hash !== hash) history.pushState(null, '', hash);
  };
  const openArtifact = (id: string, version?: number) => {
    go('files');
    setArtifactRef({ id, version });
    history.replaceState(null, '', `#files/${id}${version ? `/${version}` : ''}`);
  };
  const connectAI = () => {
    go('settings', 'models');
    history.replaceState(null, '', modelSetupHash(threadId));
  };
  const toast = (message: string) => {
    setNoticeError(false);
    setNotice(message);
  };
  async function run(fn: () => Promise<any>) {
    try {
      return await fn();
    } catch (e) {
      setNoticeError(true);
      setNotice(e instanceof Error ? e.message : 'Something went wrong. Try again.');
      return undefined;
    }
  }
  async function present(payload: Record<string, any>) {
    const message = await run(() => api.act('chat.present', { threadId, ...payload }));
    if (message) {
      go('chat');
      setFocusMessageId(message.id);
      setFocusSerial((value) => value + 1);
      setSidebarOpen(false);
      setAssistantTab(null);
    }
    return message;
  }
  const act = async (action: string, payload: Record<string, any> = {}) => {
    const result = await run(() => api.act(action, payload));
    if (result && ['mail.prepare', 'calendar.prepare', 'terminal.prepare'].includes(action)) {
      if (page === 'chat') await present({ reviewId: result.id });
      else {
        go('activity');
        setReviewId(result.id);
      }
    }
    if (result && action === 'skill.run') go('chat');
    return result;
  };
  const selectThread = (id: string, messageId = '') => {
    setFileId('');
    setThreadId(id);
    setFocusMessageId(messageId);
    setFocusSerial((value) => value + 1);
    setAssistantTab(null);
    setPage('chat');
    setSidebarOpen(false);
    setTaskId('');
    setReviewId('');
    const hash = chatHash(id, messageId);
    if (location.hash !== hash) history.pushState(null, '', hash);
  };
  const openAttention = (target: any) => {
    if (target.threadId) selectThread(target.threadId, target.messageId);
    else if (target.taskId) {
      go('activity');
      setTaskId(target.taskId);
    } else if (target.reviewId) {
      go('activity');
      setReviewId(target.reviewId);
    } else go(target.page || 'chat');
    setNotificationOpen(false);
  };
  useEffect(() => {
    if (
      api.mode() !== 'loading' &&
      api.authenticated() &&
      !s.threads.some((t) => t.id === threadId)
    )
      setThreadId('main');
  }, [s.threads, threadId]);
  const newConversation = async () => {
    if (creatingThreadRef.current) return;
    creatingThreadRef.current = true;
    setCreatingThread(true);
    try {
      const t = await act('thread.create', { assistantId: identity.id });
      if (t) {
        selectThread(t.id);
        requestAnimationFrame(() =>
          document.querySelector<HTMLTextAreaElement>('.chat-pane:not([hidden]) textarea')?.focus(),
        );
      }
    } finally {
      creatingThreadRef.current = false;
      setCreatingThread(false);
    }
  };
  newConversationRef.current = newConversation;
  useEffect(() => {
    if (sidebarOpen) sidebarClose.current?.focus();
  }, [sidebarOpen]);
  useEffect(() => {
    const media = matchMedia('(max-width: 720px)');
    const update = () => setNarrow(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const navigate = () => {
      setPage(routePage());
      setSettingsSection(settingsRoute());
      if (routePage() === 'chat') {
        const route = chatRoute();
        setThreadId(route?.id || 'main');
        setFocusMessageId(route?.messageId || '');
        setFocusSerial((value) => value + 1);
      }
      const preview = filePreviewRoute(location.hash);
      setFileId(preview?.id || '');
      if (preview) setThreadId(preview.threadId);
      setArtifactRef(artifactRoute());
      setTaskId('');
      setReviewId('');
      setAssistantTab(null);
    };
    window.addEventListener('hashchange', navigate);
    window.addEventListener('popstate', navigate);
    return () => {
      window.removeEventListener('hashchange', navigate);
      window.removeEventListener('popstate', navigate);
    };
  }, []);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () =>
      (document.documentElement.dataset.theme =
        s.profile.theme === 'system' ? (media.matches ? 'dark' : 'light') : s.profile.theme);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [s.profile.theme]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), noticeError ? 9000 : 5000);
    return () => clearTimeout(timer);
  }, [notice, noticeError]);
  function openSearch(scope: 'workspace' | 'chat' | 'chats' = 'workspace') {
    setSearchScope(scope);
    setSidebarOpen(false);
    setSearchOpen(true);
  }
  // Read the latest page/thread on every command, including native menu actions.
  commandRef.current = (name, event) => {
    const target = document.activeElement as HTMLElement | null;
    if (
      !api.authenticated() ||
      api.mode() === 'loading' ||
      target?.closest('.computer-screen-input, .private-browser-field, .private-browser-target') ||
      document.querySelector('dialog[open]')
    )
      return false;
    const editing = target?.matches('input, textarea, select, [contenteditable="true"]');
    if (
      editing &&
      (name === 'sidebar' || (event?.altKey && ['next-chat', 'previous-chat'].includes(name)))
    )
      return false;
    if (name === 'new') void newConversationRef.current();
    else if (name === 'search') openSearch();
    else if (name === 'search-chats') openSearch('chats');
    else if (name === 'find-chat') {
      if (page !== 'chat') return false;
      openSearch('chat');
    } else if (name === 'settings') go('settings');
    else if (name === 'apps') go('apps');
    else if (name === 'sidebar') sidebarOpen ? closeSidebar() : setSidebarOpen(true);
    else if (name === 'details') {
      if (activeGroup) {
        setEditingGroup(activeGroup);
        setGroupEditor(true);
      } else setAssistantTab((tab) => (tab ? null : 'activity'));
    } else if (name === 'focus-prompt') {
      go('chat');
      requestAnimationFrame(() =>
        document.querySelector<HTMLTextAreaElement>('[data-chat-composer]')?.focus(),
      );
    } else if (name === 'send') {
      if (page !== 'chat' || (narrow && sidebarOpen)) return false;
      window.dispatchEvent(new Event('relay:send-draft'));
    } else if (name === 'back') history.back();
    else if (name === 'forward') history.forward();
    else if (/^chat-[1-9]$/.test(name) || ['next-chat', 'previous-chat'].includes(name)) {
      // Match the active sidebar order, excluding archived and reply-only threads.
      const ids = [
        ...new Set([
          'main',
          ...s.threads
            .filter(
              (t) =>
                t.id !== 'main' &&
                !t.archived &&
                !t.replyTo &&
                !t.assistantHome &&
                (t.participantIds || threadAssistantId(s, t.id) === identity.id),
            )
            .sort(pinnedFirst)
            .map((t) => t.id),
          ...(s.assistants || [])
            .filter((a) => !a.hidden)
            .sort((a, b) => Number(b.pinned) - Number(a.pinned))
            .map((a) => a.threadId),
        ]),
      ];
      const current = ids.indexOf(selectedConversationId);
      const index = name.startsWith('chat-')
        ? Number(name.slice(5)) - 1
        : (Math.max(0, current) + (name === 'next-chat' ? 1 : -1) + ids.length) % ids.length;
      if (!ids[index]) return false;
      setArchivedChats(false);
      selectThread(ids[index]);
    } else return false;
    return true;
  };
  useEffect(() => {
    const mac =
      (window as any).relayNative?.platform === 'darwin' ||
      /Mac|iPhone|iPad/.test(navigator.platform);
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const name = shortcutCommand(e, mac);
      if (name && commandRef.current(name, e)) e.preventDefault();
      if (e.key === 'Escape' && !document.querySelector('dialog[open]')) {
        if (document.getElementById('chat-sidebar')?.classList.contains('is-open')) closeSidebar();
        setNotificationOpen(false);
      }
    };
    const native = (window as any).relayNative;
    const unsubscribe = native?.onCommand((name: string) => commandRef.current(name));
    // Electron menu accelerators must also yield while typing on the guest desktop.
    const syncKeyboardOwner = () =>
      native?.setGuestKeyboard?.(
        !!document.activeElement?.closest(
          '.computer-screen-input, .private-browser-field, .private-browser-target',
        ),
      );
    window.addEventListener('keydown', key);
    document.addEventListener('focusin', syncKeyboardOwner);
    document.addEventListener('focusout', syncKeyboardOwner);
    return () => {
      window.removeEventListener('keydown', key);
      document.removeEventListener('focusin', syncKeyboardOwner);
      document.removeEventListener('focusout', syncKeyboardOwner);
      native?.setGuestKeyboard?.(false);
      unsubscribe?.();
    };
  }, []);
  useEffect(() => registerWorkspaceTools(), []);
  useEffect(() => {
    if (api.mode() !== 'loading') (window as any).relayNative?.ready();
  }, [api.mode()]);
  if (api.mode() === 'loading')
    return (
      <div className="boot-page">
        <span className="brand-mark">
          r<span>↗</span>
        </span>
        {api.startupError() ? (
          <>
            <p role="alert">{api.startupError()}</p>
            <button className="primary-button" onClick={() => void api.init()}>
              {tr('Try again')}{' '}
            </button>
            <NativeServerButton />
          </>
        ) : (
          <p>
            <Spinner size={20} />
            {tr('Opening your workspace…')}{' '}
          </p>
        )}
      </div>
    );
  if (!api.authenticated()) return <Login />;
  return (
    <Context.Provider
      value={{
        s,
        page,
        settingsSection,
        connectAI,
        threadId,
        focusMessageId,
        focusSerial,
        clearFocus: () => setFocusMessageId(''),
        go,
        selectThread,
        openMemories: () => setAssistantTab('memory'),
        openConnections: () => go('apps'),
        act,
        run,
        toast,
        openTask: (id) => {
          go('activity');
          setTaskId(id);
        },
        openArtifact,
        composeFile: (id) => {
          requestFileDraft(threadId, id);
          setFileId('');
          setFocusMessageId('');
          go('chat');
          requestAnimationFrame(() =>
            document.querySelector<HTMLTextAreaElement>('[data-chat-composer]')?.focus(),
          );
        },
        openFile: (id) => {
          const file = s.files.find((f) => f.id === id);
          if (file?.artifactId) openArtifact(file.artifactId, file.artifactVersion);
          else {
            fileTrigger.current = page === 'chat' ? (document.activeElement as HTMLElement) : null;
            const hash = filePreviewHash(id, threadId);
            go('files', undefined, hash);
            setFileId(id);
          }
        },
      }}
    >
      <DeviceAttention open={openAttention} />
      <MobileShares />
      <NativeTemplateLinks />
      {groupEditor && <GroupEditor thread={editingGroup} onClose={() => setGroupEditor(false)} />}
      <div className={`app-shell ${sidebarOpen ? 'sidebar-visible' : ''}`}>
        <a
          className="skip-link"
          href="#main"
          onClick={(e) => {
            e.preventDefault();
            document.getElementById('main')?.focus();
          }}
        >
          {tr('Skip to workspace')}{' '}
        </a>
        <aside
          id="chat-sidebar"
          className={`sidebar ${sidebarOpen ? 'is-open' : ''}`}
          aria-label={tr('Your chats')}
          inert={!sidebarOpen}
          aria-hidden={!sidebarOpen}
          onKeyDown={(event) => {
            if (!narrow || event.key !== 'Tab') return;
            const controls = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
            );
            const first = controls[0];
            const last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }}
        >
          <div className="conversation-toolbar">
            <span className="sidebar-wordmark">
              relay<span>.</span>
            </span>
            <button
              ref={sidebarClose}
              className="icon-button"
              aria-label={tr('Hide chats')}
              title={tr('Hide chats')}
              onClick={closeSidebar}
            >
              <SidebarSimple size={21} />
            </button>
          </div>
          <ConversationActions
            visible={sidebarOpen}
            thread={s.threads.find((t) => t.id === 'main')!}
          >
            <button
              className={`thread-link main-chat-link ${selectedConversationId === 'main' && page === 'chat' ? 'selected' : ''}`}
              aria-label={tr('Main chat')}
              aria-current={
                selectedConversationId === 'main' && page === 'chat' ? 'page' : undefined
              }
              onClick={() => selectThread('main')}
            >
              <span className="thread-summary">
                {tr('Main chat')}{' '}
                {s.voiceCalls?.some((c) => c.threadId === 'main' && c.status === 'active') && (
                  <small>{tr('Voice chat in progress')}</small>
                )}
              </span>
              {hasUnread('main') && (
                <span className="thread-unread" role="img" aria-label={tr('Unread updates')} />
              )}
            </button>
          </ConversationActions>
          <div className="side-chats-heading">
            <h2>{archivedChats ? tr('Archived side chats') : tr('Side chats')}</h2>
            <button
              className="icon-button"
              aria-label={
                archivedChats ? tr('Show active side chats') : tr('Show archived side chats')
              }
              aria-pressed={archivedChats}
              title={archivedChats ? tr('Show active side chats') : tr('Archived side chats')}
              onClick={() => setArchivedChats(!archivedChats)}
            >
              <Archive size={17} />
            </button>
          </div>
          {!archivedChats && (
            <button
              className="thread-link new-side-chat"
              aria-label={tr('New side chat')}
              title={tr('New side chat · ⌘/Ctrl N')}
              onClick={() => void newConversation()}
              disabled={creatingThread}
            >
              <NotePencil size={18} aria-hidden="true" />
              {tr('New side chat')}{' '}
            </button>
          )}
          <div className="conversation-list">
            {s.threads
              .filter(
                (t) =>
                  t.id !== 'main' &&
                  !t.replyTo &&
                  !t.assistantHome &&
                  (t.participantIds || threadAssistantId(s, t.id) === identity.id) &&
                  Boolean(t.archived) === archivedChats,
              )
              .sort(pinnedFirst)
              .map((t) => (
                <ConversationActions visible={sidebarOpen} key={t.id} thread={t}>
                  <button
                    title={t.title}
                    aria-label={archivedChats ? tr('Restore {name}', { name: t.title }) : t.title}
                    aria-current={
                      selectedConversationId === t.id && page === 'chat' ? 'page' : undefined
                    }
                    className={`thread-link ${selectedConversationId === t.id && page === 'chat' ? 'selected' : ''}`}
                    onClick={async () => {
                      if (
                        t.archived &&
                        !(await act('thread.update', { id: t.id, archived: false }))
                      )
                        return;
                      setArchivedChats(false);
                      selectThread(t.id);
                    }}
                  >
                    <span className="thread-summary">
                      <strong>
                        {t.pinned && (
                          <PushPin
                            size={13}
                            className="thread-pin"
                            aria-label={tr('Pinned conversation')}
                          />
                        )}
                        {t.participantIds && <UsersThree size={14} aria-hidden="true" />} {t.title}
                      </strong>
                      <small>
                        {s.voiceCalls?.some((c) => c.threadId === t.id && c.status === 'active')
                          ? tr('Voice chat in progress')
                          : s.messages
                              .filter((m) => m.threadId === t.id && m.id !== 'welcome')
                              .at(-1)
                              ?.text.replace(/[#*`\n]/g, ' ')
                              .replace(/\s+/g, ' ') || tr('What can I help you with?')}
                      </small>
                    </span>
                    {hasUnread(t.id) && (
                      <span
                        className="thread-unread"
                        role="img"
                        aria-label={tr('Unread updates')}
                      />
                    )}
                    {t.archived && <ArrowCounterClockwise size={16} aria-hidden="true" />}
                  </button>
                </ConversationActions>
              ))}
            {!s.threads.some(
              (t) =>
                t.id !== 'main' &&
                !t.replyTo &&
                !t.assistantHome &&
                (t.participantIds || threadAssistantId(s, t.id) === identity.id) &&
                Boolean(t.archived) === archivedChats,
            ) && (
              <p className="side-chat-empty">
                {archivedChats
                  ? tr('No archived side chats.')
                  : tr('A space for another topic, whenever you need it.')}
              </p>
            )}
          </div>
          <button
            className="text-button group-new-button"
            onClick={() => {
              setSidebarOpen(false);
              setGroupEditor(true);
            }}
          >
            <UsersThree size={17} /> {tr('New group chat')}{' '}
          </button>
          {!!s.assistants?.length && (
            <>
              <div className="side-chats-heading assistant-roster-heading">
                <h2>{tr('Assistants')}</h2>
                <button
                  className="text-button"
                  onClick={() => go('assistants')}
                  aria-label={tr('Manage assistants')}
                >
                  {tr('Manage')}{' '}
                </button>
              </div>
              <div className="assistant-roster">
                {(s.assistants || [])
                  .filter((a) => !a.hidden)
                  .sort((a, b) => Number(b.pinned) - Number(a.pinned))
                  .map((a) => (
                    <ConversationActions
                      visible={sidebarOpen}
                      key={a.id}
                      thread={s.threads.find((t) => t.id === a.threadId)!}
                    >
                      <button
                        className={`thread-link ${identity.id === a.id ? 'selected' : ''}`}
                        aria-label={tr('Chat with {name}', { name: a.name })}
                        onClick={() => selectThread(a.threadId)}
                      >
                        <AssistantAvatar assistantId={a.id} />
                        <span className="thread-summary">
                          <strong>
                            {a.name}
                            {a.pinned && (
                              <PushPin
                                size={13}
                                className="thread-pin"
                                aria-label={tr('Pinned conversation')}
                              />
                            )}
                          </strong>
                          <small>{assistantStatus(s, a.id)}</small>
                        </span>
                        {hasUnread(a.threadId) && (
                          <span
                            className="thread-unread"
                            role="img"
                            aria-label={tr('Unread updates')}
                          />
                        )}
                      </button>
                    </ConversationActions>
                  ))}
                {!(s.assistants || []).some((a) => !a.hidden) && (
                  <button
                    className="text-button assistant-roster-add"
                    onClick={() => go('assistants')}
                  >
                    {tr('Add a specialist')}{' '}
                  </button>
                )}
                {!!(s.assistants || []).some((a) => a.hidden) && (
                  <button
                    className="text-button assistant-roster-add"
                    onClick={() => go('assistants')}
                  >
                    {tr('Hidden assistants')}{' '}
                  </button>
                )}
              </div>
            </>
          )}
          <div className="sidebar-bottom">
            <button
              className="icon-button"
              aria-label={tr('Your profile')}
              title={tr('Your profile and preferences')}
              onClick={() => go('settings')}
            >
              <GearSix size={19} />
            </button>
            <button
              className="sidebar-search"
              aria-label={tr('Find in your space')}
              onClick={() => {
                setSidebarOpen(false);
                openSearch();
              }}
            >
              <MagnifyingGlass size={17} /> {tr('Search')}{' '}
            </button>
          </div>
        </aside>
        {sidebarOpen && narrow && (
          <button className="sidebar-scrim" aria-label={tr('Close chats')} onClick={closeSidebar} />
        )}
        <div
          className="workspace"
          inert={narrow && sidebarOpen}
          aria-hidden={narrow && sidebarOpen}
        >
          <header className="topbar">
            <button
              ref={sidebarToggle}
              className="icon-button sidebar-toggle"
              aria-label={sidebarOpen ? tr('Hide chats') : tr('Show chats')}
              aria-controls="chat-sidebar"
              aria-expanded={sidebarOpen}
              onClick={() => (sidebarOpen ? closeSidebar() : setSidebarOpen(true))}
            >
              <SidebarSimple size={22} />
            </button>
            <button
              className="icon-button global-search"
              ref={searchToggle}
              aria-label={tr('Search')}
              title={tr('Search anything · ⌘/Ctrl K')}
              onClick={() => openSearch()}
            >
              <MagnifyingGlass size={21} />
            </button>
            <div className="breadcrumbs">
              <div className="assistant-presence">
                {activeGroup ? (
                  <div className="group-presence-avatars">
                    {activeGroup.participantIds.slice(0, 3).map((id: string) => (
                      <AssistantAvatar key={id} assistantId={id} />
                    ))}
                  </div>
                ) : (
                  <Companion />
                )}
                <button
                  className="assistant-details-button"
                  aria-label={activeGroup ? tr('Open group details') : tr('Open assistant details')}
                  aria-describedby="assistant-current-status"
                  onClick={() => {
                    if (activeGroup) {
                      setEditingGroup(activeGroup);
                      setGroupEditor(true);
                    } else setAssistantTab('activity');
                  }}
                >
                  <strong>{activeGroup?.title || identity.name}</strong>
                  <small id="assistant-current-status">
                    {activeGroup
                      ? `${activeGroup.participantIds.length} assistants`
                      : assistantStatus(s, identity.id)}
                  </small>
                </button>
              </div>
            </div>
            <div className="top-actions">
              <button
                className="icon-button workspace-shortcut"
                data-shortcut={s.connections.runtime?.desktop ? 'computer' : 'memory'}
                aria-label={
                  s.connections.runtime?.desktop ? tr('Open computer') : tr('My memories')
                }
                title={s.connections.runtime?.desktop ? tr('Your computer') : tr('Your memories')}
                onClick={() =>
                  s.connections.runtime?.desktop ? go('computer') : setAssistantTab('memory')
                }
              >
                {s.connections.runtime?.desktop ? <Desktop size={21} /> : <Brain size={21} />}
              </button>
              <button
                className="sample-badge"
                aria-label={
                  api.mode() === 'server'
                    ? s.connections.model.configured
                      ? tr('Model connected')
                      : tr('Self-hosted sample')
                    : tr('Sample mode')
                }
                onClick={() => go('settings', 'models')}
                title={tr('Choose your AI model')}
              >
                <span className="mode-label">
                  {api.mode() === 'server'
                    ? s.connections.model.configured
                      ? tr('Model connected')
                      : tr('Self-hosted sample')
                    : tr('Sample mode')}
                </span>
                <span className="mode-short" aria-hidden="true">
                  {s.connections.model.configured ? tr('AI on') : tr('Sample')}
                </span>
              </button>
              <button
                className="icon-button notification-button"
                aria-label={tr('Notifications')}
                aria-expanded={notificationOpen}
                onClick={() => setNotificationOpen(!notificationOpen)}
              >
                <Bell size={21} />
                {notices.some((n: any) => !n.read) && <span className="notification-dot" />}
              </button>
            </div>
          </header>
          {api.status() && (
            <div className="storage-warning" role="status">
              {api.status()}
              {api.connection() === 'offline' && (
                <button className="text-button" onClick={() => void api.refresh()}>
                  Reconnect
                </button>
              )}
            </div>
          )}
          <main id="main" tabIndex={-1} className="chat-layout">
            <PageBoundary>
              <Suspense
                fallback={
                  <div className="loading-block">
                    <Spinner size={23} />
                    {tr('Opening your conversation…')}{' '}
                  </div>
                }
              >
                {creatingThread ? (
                  <div className="loading-block">
                    <Spinner size={23} />
                    {tr('Opening a side chat…')}{' '}
                  </div>
                ) : (
                  <>
                    <div className="chat-pane" hidden={page !== 'chat'} inert={page !== 'chat'}>
                      <Chat
                        key={`${threadId}:${s.threads.find((t) => t.id === threadId)?.createdAt || ''}`}
                      />
                    </div>
                    {page !== 'chat' && (
                      <Suspense
                        fallback={
                          <section
                            className="workspace-page"
                            aria-label={tr('Opening your workspace…')}
                          >
                            <div className="workspace-page-toolbar">
                              <button className="text-button" onClick={() => go('chat')}>
                                <ArrowLeft size={18} /> {tr('Back to chat')}
                              </button>
                            </div>
                            <div className="loading-block" role="status">
                              <Spinner size={23} />
                              {tr('Opening your workspace…')}
                            </div>
                          </section>
                        }
                      >
                        <WorkspacePage
                          artifactRef={artifactRef}
                          fileId={fileId}
                          key={`${page}-${taskId}-${reviewId}`}
                          taskId={taskId}
                          reviewId={reviewId}
                        />
                      </Suspense>
                    )}
                  </>
                )}
              </Suspense>
            </PageBoundary>
          </main>
          {searchOpen && (
            <Search
              scope={searchScope}
              onScope={setSearchScope}
              onClose={(restoreFocus = true) => {
                setSearchOpen(false);
                if (restoreFocus) requestAnimationFrame(() => searchToggle.current?.focus());
              }}
            />
          )}
          {assistantTab && (
            <AssistantDetails initialTab={assistantTab} onClose={() => setAssistantTab(null)} />
          )}
          {notificationOpen && (
            <section className="notification-popover" aria-label={tr('Notifications')}>
              <div className="section-line">
                <h2>{tr('Notifications')}</h2>
                <button
                  className="icon-button"
                  aria-label="Close notifications"
                  onClick={() => setNotificationOpen(false)}
                >
                  <X size={18} />
                </button>
              </div>
              {notices.length ? (
                <>
                  <button className="text-button" onClick={() => void act('attention.read')}>
                    Mark all as read
                  </button>
                  {notices.slice(0, 30).map((n: any) => (
                    <button
                      className={`notification-row ${!n.read ? 'unread' : ''}`}
                      key={n.id}
                      onClick={() => {
                        try {
                          const target = attentionTarget(s, n.id);
                          void act('attention.read', { id: n.id });
                          openAttention(target);
                        } catch (e) {
                          toast(e instanceof Error ? e.message : 'This update could not open.');
                        }
                      }}
                    >
                      <strong>{n.title}</strong>
                      <span>{n.body}</span>
                    </button>
                  ))}
                </>
              ) : (
                <p>You’re all caught up. Task updates and tracking alerts will appear here.</p>
              )}
            </section>
          )}
          {notice && (
            <div className="toast" role={noticeError ? 'alert' : 'status'}>
              {notice}
              <button aria-label="Dismiss notification" onClick={() => setNotice('')}>
                <X size={18} />
              </button>
            </div>
          )}
        </div>
      </div>
    </Context.Provider>
  );
}
