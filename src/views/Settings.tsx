import { tr, useUiLanguage } from '../i18n';
import { modelSetupChat } from '../../shared/model-setup-navigation.mjs';
import { uiLanguages } from '../../shared/ui-language.mjs';
import NotificationSettings from '../components/NotificationSettings';
import '../components/notifications.css';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { settingsSections } from '../navigation';
import './settings.css';
import {
  SlidersHorizontal,
  Check,
  Envelope,
  Plug,
  DownloadSimple,
  Archive,
  Database,
  ShieldCheck,
  CaretRight,
} from '@phosphor-icons/react';
import { useWorkspace } from '../context';
import { api } from '../api';
import { MemoryList } from '../components/Assistant';
import NativeConnection from '../components/NativeConnection';
import DeviceConnections from '../components/DeviceConnections';
import ModelConnections from '../components/ModelConnections';
import VoiceConnections from '../components/VoiceConnections';
import ModelUsage from '../components/ModelUsage';
import { Field, Modal, dateTime } from '../components/ui';
const tones = [
  'Clear and friendly',
  'Concise and direct',
  'Warm and thoughtful',
  'Detailed and analytical',
];
export default function Settings() {
  const language = useUiLanguage();
  const { s, act, run, toast, selectThread, go, settingsSection } = useWorkspace();
  const [name, setName] = useState(s.profile.name);
  const [assistant, setAssistant] = useState(s.profile.assistantName || 'Relay');
  const [tone, setTone] = useState(s.profile.tone);
  const [timeZone, setTimeZone] = useState(
    s.profile.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [busy, setBusy] = useState(false);
  const [disconnect, setDisconnect] = useState(false);
  const [reset, setReset] = useState(false);
  const server = api.mode() === 'server';
  const google = s.connections.google;
  const runtime = s.connections.runtime || {};
  const setupChat = modelSetupChat(location.hash);
  function returnToDraft() {
    // Only an explicit activation in this setup flow returns to its original chat.
    // A passive refresh or a response arriving after navigation must not move the user.
    if (!setupChat || modelSetupChat(location.hash) !== setupChat) return;
    const state = api.snapshot();
    if (!state.connections.model?.configured) return;
    selectThread(state.threads.some((thread) => thread.id === setupChat) ? setupChat : 'main');
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>('[data-chat-composer="true"]')?.focus(),
    );
  }
  async function connect(write: boolean) {
    setBusy(true);
    await run(async () => {
      const r = await api.request('/google/start', {
        method: 'POST',
        body: JSON.stringify({ write }),
      });
      window.location.assign(r.url);
    });
    setBusy(false);
  }
  function exportWorkspace() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'relay-workspace.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('Workspace exported. Server secrets are excluded.');
  }
  return (
    <section>
      {!settingsSection && (
        <div className="settings-index">
          <p className="settings-intro">{tr('A few simple choices. Make Relay yours.')}</p>
          <nav className="settings-sections" aria-label={tr('Settings categories')}>
            {settingsSections.map(({ id, title, hint, Icon }) => (
              <button key={id} onClick={() => go('settings', id)} aria-label={tr(title)}>
                <Icon size={22} aria-hidden="true" />
                <span>
                  <strong>{tr(title)}</strong>
                  <small>{tr(hint)}</small>
                </span>
                <CaretRight size={17} aria-hidden="true" />
              </button>
            ))}
          </nav>
        </div>
      )}
      <div className="settings-detail">
        <SettingsPanel active={settingsSection === 'personal'}>
          <article className="settings-card">
            <div className="settings-title">
              <SlidersHorizontal size={23} />
              <div>
                <h2>{tr('A personal touch')}</h2>
                <p>{tr('Choose how your workspace feels and how your assistant responds.')}</p>
              </div>
            </div>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (await act('profile.update', { name, assistantName: assistant, tone, timeZone }))
                  toast(tr('Your preferences are saved.'));
              }}
            >
              <div className="form-grid">
                <Field label={tr('Your name')}>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={80}
                    placeholder={tr('What should I call you?')}
                  />
                </Field>
                <Field label={tr('Assistant name')}>
                  <input
                    value={assistant}
                    onChange={(e) => setAssistant(e.target.value)}
                    maxLength={40}
                    required
                  />
                </Field>
              </div>
              <Field label={tr('Response style')}>
                <select value={tone} onChange={(e) => setTone(e.target.value)}>
                  {tones.map((t) => (
                    <option key={t} value={t}>
                      {tr(t)}
                    </option>
                  ))}
                  {!tones.includes(tone) && <option>{tone}</option>}
                </select>
              </Field>
              <Field
                label={tr('Your time zone')}
                hint={tr(
                  'Used as context when your assistant interprets dates. Calendar forms show the time zone of this device.',
                )}
              >
                <input
                  required
                  maxLength={100}
                  value={timeZone}
                  onChange={(e) => setTimeZone(e.target.value)}
                  placeholder={tr('For example, America/New_York')}
                />
              </Field>
              <button className="primary-button" type="submit">
                {tr('Save preferences')}{' '}
              </button>
            </form>
            <div className="settings-row">
              <div>
                <h3>{tr('Assistant accent')}</h3>
                <button
                  className="text-button"
                  onClick={() => {
                    location.hash = 'assistants?edit=relay';
                  }}
                >
                  {tr('Change character')}{' '}
                </button>
                <p>{tr('Give your conversation a small signature.')}</p>
              </div>
              <div className="color-options">
                {['#173dca', '#167b63', '#8d4fc0', '#b35c27'].map((color) => (
                  <button
                    style={{ background: color }}
                    key={color}
                    aria-label={tr('Assistant color {color}', { color })}
                    aria-pressed={(s.profile.avatarColor || '#173dca') === color}
                    onClick={() => void act('profile.update', { avatarColor: color })}
                  >
                    {(s.profile.avatarColor || '#173dca') === color && <Check size={17} />}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-row">
              <div>
                <h3>{tr('Appearance')}</h3>
                <p>{tr('Light, dark, or follow your device.')}</p>
              </div>
              <select
                aria-label={tr('Appearance')}
                value={s.profile.theme}
                onChange={(e) => void act('profile.update', { theme: e.target.value })}
              >
                <option value="light">{tr('Light')}</option>
                <option value="dark">{tr('Dark')}</option>
                <option value="system">{tr('System')}</option>
              </select>
            </div>
            <div className="settings-row language-setting">
              <div>
                <h3>{tr('App language')}</h3>
                <p>
                  {tr('Choose the language for this device. Your conversations stay as they are.')}
                </p>
                <p>
                  {tr(
                    'Chat, navigation and personal settings are translated. Some tools still use English.',
                  )}
                </p>
              </div>
              <select
                aria-label={tr('App language')}
                value={language.preference}
                onChange={(event) => {
                  try {
                    language.setLanguage(event.target.value);
                    toast(tr('Your app language is saved.'));
                  } catch {
                    toast(tr('Could not save the app language on this device.'));
                  }
                }}
              >
                {uiLanguages.map(({ id, name }) => (
                  <option key={id} value={id}>
                    {id === 'system' ? tr(name) : name}
                  </option>
                ))}
              </select>
            </div>
          </article>
        </SettingsPanel>
        <SettingsPanel active={settingsSection === 'notifications'}>
          <article className="settings-card">
            <div className="settings-row">
              <div>
                <h2 className="notification-workspace-heading">Workspace notifications</h2>
                <p>Results, questions, reviews and meaningful tracking alerts.</p>
              </div>
              <button
                className={`switch ${s.profile.notifications ? 'on' : ''}`}
                role="switch"
                aria-checked={s.profile.notifications}
                aria-label="Workspace notifications"
                onClick={() =>
                  void act('profile.update', { notifications: !s.profile.notifications })
                }
              >
                <span />
              </button>
            </div>
          </article>
          <NotificationSettings />
        </SettingsPanel>
        <SettingsPanel active={settingsSection === 'models'}>
          <ModelConnections onActivated={returnToDraft} returnToChat={!!setupChat} />
        </SettingsPanel>
        <SettingsPanel active={settingsSection === 'voice'}>
          <VoiceConnections />
        </SettingsPanel>
        <SettingsPanel active={settingsSection === 'usage'}>
          <ModelUsage active={settingsSection === 'usage'} />
        </SettingsPanel>
        <SettingsPanel active={settingsSection === 'memory'}>
          <article className="settings-card">
            <div className="settings-title">
              <Database size={23} />
              <div>
                <h2>A little context goes a long way</h2>
                <p>Your assistant reads these memories. You can edit what it knows.</p>
              </div>
            </div>
            <MemoryList assistantId="relay" />
          </article>
        </SettingsPanel>
        <SettingsPanel active={settingsSection === 'archive'}>
          <article className="settings-card">
            <div className="settings-title">
              <Archive size={23} />
              <div>
                <h2>Archived conversations</h2>
                <p>Keep a conversation out of the way, and bring it back later.</p>
              </div>
            </div>
            {s.threads.filter((t) => t.archived && !t.replyTo).length ? (
              s.threads
                .filter((t) => t.archived && !t.replyTo)
                .map((t) => (
                  <div className="settings-row" key={t.id}>
                    <div>
                      <h3>{t.title}</h3>
                      <p>{dateTime(t.createdAt)}</p>
                    </div>
                    <button
                      className="secondary-button"
                      onClick={async () => {
                        if (await act('thread.update', { id: t.id, archived: false }))
                          selectThread(t.id);
                      }}
                    >
                      Restore
                    </button>
                  </div>
                ))
            ) : (
              <p className="muted">No archived conversations.</p>
            )}
          </article>
        </SettingsPanel>
        <SettingsPanel active={settingsSection === 'connections'}>
          <article className="settings-card">
            <div className="settings-title">
              <Plug size={23} />
              <div>
                <h2>Your connections</h2>
                <p>Credentials stay on your server.</p>
              </div>
            </div>
            <button className="secondary-button" onClick={() => go('apps')}>
              <Plug size={18} /> Manage your apps
            </button>
            <div className="connection-card">
              <span className="connection-icon">
                <Envelope size={22} />
              </span>
              <h3>Google Mail & Calendar</h3>
              <p>
                {google.connected
                  ? google.email
                  : 'Read your mail and calendar. Prepare writes for your approval.'}
              </p>
              {google.connected ? (
                <>
                  <span className="connection-status">
                    <span className="status-dot" />
                    Connected · {google.write ? 'Read and reviewed writes' : 'Read only'}
                  </span>
                  <button className="text-button danger-text" onClick={() => setDisconnect(true)}>
                    Disconnect
                  </button>
                  {!google.write && server && runtime.googleConfigured && (
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => void connect(true)}
                    >
                      Enable reviewed writes
                    </button>
                  )}
                </>
              ) : server && runtime.googleConfigured ? (
                <div className="connection-actions">
                  <button
                    className="primary-button"
                    disabled={busy}
                    onClick={() => void connect(false)}
                  >
                    Connect read only
                  </button>
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => void connect(true)}
                  >
                    Enable reviewed writes
                  </button>
                </div>
              ) : (
                <div className="setup-note">
                  {server
                    ? 'Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and RELAY_TOKEN_ENCRYPTION_KEY in your server environment.'
                    : 'Run the supplied server and configure Google OAuth to connect a real account.'}
                </div>
              )}
            </div>
          </article>
        </SettingsPanel>
        <SettingsPanel active={settingsSection === 'data'}>
          <NativeConnection />
          {server && <DeviceConnections />}
          <article className="settings-card storage-card">
            <ShieldCheck size={27} />
            <h2>A space you own</h2>
            <p>
              {server
                ? 'SQLite saves your workspace. The worker keeps going while the server runs. Back up the data directory with the server stopped.'
                : 'This preview saves a sample workspace in this browser’s IndexedDB. Tasks and tracking run while the app is open.'}
            </p>
            <button className="secondary-button" onClick={exportWorkspace}>
              <DownloadSimple size={18} />
              Export workspace
            </button>
            {!server && (
              <button className="text-button danger-text" onClick={() => setReset(true)}>
                Reset sample workspace
              </button>
            )}
            {server && (
              <button
                className="text-button"
                onClick={() =>
                  void run(async () => {
                    await api.request('/logout', { method: 'POST' });
                    window.location.reload();
                  })
                }
              >
                Sign out
              </button>
            )}
          </article>
          <p className="settings-credit">
            Relay 0.1 · Independently implemented
            <br />
            MIT source included with this workspace.
          </p>
        </SettingsPanel>
      </div>
      {disconnect && (
        <Modal title="Disconnect Google" onClose={() => setDisconnect(false)}>
          <p>
            Remove the stored tokens and invalidate pending actions for this account. Downloaded
            files stay in your workspace.
          </p>
          <div className="modal-footer">
            <button className="secondary-button" onClick={() => setDisconnect(false)}>
              Keep connection
            </button>
            <button
              className="danger-button"
              onClick={() =>
                void run(async () => {
                  await api.request('/google/disconnect', { method: 'POST' });
                  await api.refresh();
                  setDisconnect(false);
                  toast('Google disconnected.');
                })
              }
            >
              Disconnect
            </button>
          </div>
        </Modal>
      )}
      {reset && (
        <Modal title="Start the sample again" onClose={() => setReset(false)}>
          <p>
            This removes the sample workspace in this browser, including uploaded files and notes.
            Export anything you want to keep first.
          </p>
          <div className="modal-footer">
            <button className="secondary-button" onClick={() => setReset(false)}>
              Keep workspace
            </button>
            <button
              className="danger-button"
              onClick={() =>
                void run(async () => {
                  await api.reset();
                  setReset(false);
                  toast('A fresh sample workspace is ready.');
                })
              }
            >
              Reset sample
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

// Keep unfinished settings forms when moving between categories, without loading
// connections or asking for device permissions before the owner opens that category.
function SettingsPanel({ active, children }: { active: boolean; children: ReactNode }) {
  const [visited, setVisited] = useState(active);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) setVisited(true);
    else
      panel.current
        ?.querySelectorAll('audio, video')
        .forEach((media) => (media as HTMLMediaElement).pause());
  }, [active]);
  if (!active && !visited) return null;
  return (
    <div ref={panel} hidden={!active} inert={!active}>
      {children}
    </div>
  );
}
