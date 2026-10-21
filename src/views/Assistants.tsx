import AppearanceEditor from '../components/AppearanceEditor';
import type { Appearance } from '../components/CharacterLook';
import AssistantTemplates from '../components/AssistantTemplates';
import { useEffect, useState } from 'react';
import {
  Plus,
  ArrowRight,
  PencilSimple,
  Copy,
  PushPin,
  EyeSlash,
  Eye,
  ArrowLeft,
} from '@phosphor-icons/react';
import { useWorkspace } from '../context';
import {
  assistantProfile,
  assistantMemories,
  threadAssistantId,
} from '../../shared/assistant-scope.mjs';
import { MemoryList, AssistantAvatar, assistantStatus } from '../components/Assistant';
import { Field } from '../components/ui';
type Draft = {
  notificationMode?: 'all' | 'attention' | 'off';
  id?: string;
  revision?: number;
  name: string;
  description: string;
  tone: string;
  avatarColor: string;
  appearance?: Appearance;
  enabledSkillIds?: string[] | null;
};
const blank: Draft = {
  name: '',
  description: '',
  tone: 'Clear and friendly',
  avatarColor: '#e7b281',
};
const draftKey = 'relay-assistant-profile-draft';
function profileDraft(profile: any): Draft {
  return {
    id: profile.id,
    revision: profile.revision,
    name: profile.name,
    description: profile.description,
    tone: profile.tone,
    avatarColor: profile.avatarColor,
    appearance: profile.appearance,
    notificationMode: profile.notificationMode || 'all',
    enabledSkillIds: profile.enabledSkillIds ?? null,
  };
}
export default function Assistants() {
  const { s, act, selectThread, go } = useWorkspace();
  const [draft, setDraft] = useState<Draft | null>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(draftKey) || 'null');
      const editing = new URLSearchParams(location.hash.split('?')[1] || '').get('edit');
      if (!saved && editing) {
        const profile = assistantProfile(s, editing);
        return {
          id: profile.id,
          revision: profile.revision,
          name: profile.name,
          description: profile.description,
          tone: profile.tone,
          avatarColor: profile.avatarColor,
          appearance: profile.appearance,
          notificationMode: profile.notificationMode || 'all',
          enabledSkillIds: profile.enabledSkillIds ?? null,
        };
      }
      return saved &&
        typeof saved.name === 'string' &&
        typeof saved.description === 'string' &&
        typeof saved.tone === 'string' &&
        /^#[0-9a-f]{6}$/i.test(saved.avatarColor)
        ? saved
        : null;
    } catch {
      return null;
    }
  });
  const [templateMode, setTemplateMode] = useState<string | null>(() =>
    new URLSearchParams(location.hash.split('?')[1] || '').has('import') ? 'import' : null,
  );
  const [templateRoute, setTemplateRoute] = useState(() => ({
    source: new URLSearchParams(location.hash.split('?')[1] || '').get('import') || '',
    receipt: new URLSearchParams(location.hash.split('?')[1] || '').get('native') || '',
  }));
  const [hidden, setHidden] = useState(false),
    [busy, setBusy] = useState(false),
    [pictureBusy, setPictureBusy] = useState(false),
    [notice, setNotice] = useState('');
  useEffect(() => {
    const openRequestedProfile = () => {
      const parameters = new URLSearchParams(location.hash.split('?')[1] || '');
      if (location.hash.startsWith('#assistants') && parameters.has('import')) {
        setTemplateMode('import');
        setTemplateRoute({
          source: parameters.get('import') || '',
          receipt: parameters.get('native') || '',
        });
        return;
      }
      const id = parameters.get('edit');
      if (!location.hash.startsWith('#assistants') || !id) return;
      try {
        const requested = profileDraft(assistantProfile(s, id));
        setTemplateMode(null);
        setDraft((current) => current || requested);
      } catch {
        setNotice('This assistant is no longer available.');
      }
    };
    window.addEventListener('hashchange', openRequestedProfile);
    return () => window.removeEventListener('hashchange', openRequestedProfile);
  }, [s]);
  const assistants = [assistantProfile(s), ...(s.assistants || [])]
    .filter((a) => !!a.hidden === hidden)
    .sort(
      (a, b) =>
        Number(b.id === 'relay') - Number(a.id === 'relay') || Number(b.pinned) - Number(a.pinned),
    );
  useEffect(() => {
    try {
      if (draft) sessionStorage.setItem(draftKey, JSON.stringify(draft));
      else sessionStorage.removeItem(draftKey);
    } catch {}
  }, [draft]);
  function clearDraft() {
    try {
      sessionStorage.removeItem(draftKey);
    } catch {}
    setDraft(null);
    setPictureBusy(false);
    history.replaceState(null, '', '#assistants');
  }
  function edit(profile: any) {
    setDraft({
      id: profile.id,
      revision: profile.revision,
      name: profile.name,
      description: profile.description,
      tone: profile.tone,
      avatarColor: profile.avatarColor,
      appearance: profile.appearance,
      notificationMode: profile.notificationMode || 'all',
      enabledSkillIds: profile.enabledSkillIds ?? null,
    });
    setNotice('');
  }
  async function change(action: string, payload: object, message: string) {
    setBusy(true);
    const result = await act(action, payload);
    setBusy(false);
    if (result) setNotice(message);
    return result;
  }
  if (templateMode)
    return (
      <AssistantTemplates
        key={templateMode + ':' + templateRoute.source + ':' + templateRoute.receipt}
        assistantId={templateMode === 'import' ? null : templateMode}
        initialSource={templateMode === 'import' ? templateRoute.source : ''}
        nativeReceipt={templateMode === 'import' ? templateRoute.receipt : ''}
        onClose={() => {
          setTemplateMode(null);
          setTemplateRoute({ source: '', receipt: '' });
          history.replaceState(null, '', '#assistants');
        }}
      />
    );
  return (
    <div className="assistants-page">
      <p className="assistant-page-intro">
        Main is your everyday conversation. Add a specialist when a job needs its own instructions,
        chats and memories.
      </p>
      {draft ? (
        <section className="assistant-editor" aria-label="Assistant profile">
          <button
            className="text-button"
            onClick={() => {
              clearDraft();
              setNotice('');
            }}
            disabled={busy}
          >
            <ArrowLeft size={16} /> All assistants
          </button>
          <h2>{draft.id ? `Edit ${draft.name || 'assistant'}` : 'Give your assistant a role'}</h2>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const result = await change(
                draft.id ? 'assistant.update' : 'assistant.create',
                draft,
                'Assistant saved. New requests use these instructions.',
              );
              if (result) {
                clearDraft();
                if (!draft.id) selectThread(result.threadId);
              }
            }}
          >
            <fieldset disabled={busy || pictureBusy} className="model-fields">
              <AppearanceEditor
                value={draft.appearance}
                color={draft.avatarColor}
                onChange={(appearance) => setDraft({ ...draft, appearance })}
                onColor={(avatarColor) => setDraft({ ...draft, avatarColor })}
                onBusy={setPictureBusy}
              />
              <div className="assistant-name-field">
                <Field label="Assistant name">
                  <input
                    required
                    maxLength={40}
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    placeholder="For example, Aster"
                  />
                </Field>
              </div>
              <Field
                label="Role and instructions"
                hint="What should this assistant own? Include preferences and boundaries that should last beyond one chat."
              >
                <textarea
                  rows={7}
                  maxLength={6000}
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  placeholder="Help plan my week. Keep plans realistic, protect quiet time, and ask before changing my calendar."
                />
              </Field>
              <Field
                label="Notifications"
                hint="Choose which updates this assistant sends to your enabled devices."
              >
                <select
                  value={draft.notificationMode || 'all'}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      notificationMode: e.target.value as 'all' | 'attention' | 'off',
                    })
                  }
                >
                  <option value="all">Results and requests</option>
                  <option value="attention">Only when I’m needed</option>
                  <option value="off">Off</option>
                </select>
              </Field>
              <Field label="Working style">
                <input
                  required
                  maxLength={300}
                  value={draft.tone}
                  onChange={(e) => setDraft({ ...draft, tone: e.target.value })}
                />
              </Field>
              <details className="assistant-skill-selection">
                <summary>Skills this assistant can use</summary>
                <label className="assistant-skill-option">
                  <input
                    type="checkbox"
                    checked={draft.enabledSkillIds == null}
                    onChange={(e) =>
                      setDraft({ ...draft, enabledSkillIds: e.target.checked ? null : [] })
                    }
                  />
                  All shared skills
                </label>
                {draft.enabledSkillIds != null &&
                  (s.skills || [])
                    .filter((skill) => !skill.archived)
                    .map((skill) => (
                      <label className="assistant-skill-option" key={skill.id}>
                        <input
                          type="checkbox"
                          checked={draft.enabledSkillIds!.includes(skill.id)}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              enabledSkillIds: e.target.checked
                                ? [...draft.enabledSkillIds!, skill.id]
                                : draft.enabledSkillIds!.filter((id) => id !== skill.id),
                            })
                          }
                        />
                        {skill.title}
                      </label>
                    ))}
                {draft.enabledSkillIds != null &&
                  !(s.skills || []).some((skill) => !skill.archived) && (
                    <p className="form-note">
                      Save a skill in Your skills first. This assistant can still handle ordinary
                      requests.
                    </p>
                  )}
              </details>
              <p className="form-note">
                Chats and memories stay with this assistant. Files, skills, connected apps and the
                computer are shared. External actions still need their usual review.
              </p>
              <div className="assistant-profile-actions">
                <button className="primary-button" type="submit">
                  {busy ? 'Saving…' : draft.id ? 'Save profile' : 'Create & chat'}
                </button>
                <button className="text-button" type="button" onClick={clearDraft}>
                  Cancel
                </button>
              </div>
            </fieldset>
          </form>
          {draft.id && (
            <details className="assistant-profile-memory">
              <summary>Memories for {assistantProfile(s, draft.id).name}</summary>
              <MemoryList key={draft.id} assistantId={draft.id} />
            </details>
          )}
        </section>
      ) : (
        <>
          <div className="assistant-page-actions">
            <button
              className="text-button"
              onClick={() => {
                setTemplateRoute({ source: '', receipt: '' });
                setTemplateMode('import');
              }}
            >
              Import template
            </button>
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => {
                setDraft({ ...blank });
                setNotice('');
              }}
            >
              <Plus size={18} /> New assistant
            </button>
            <button
              className="text-button"
              aria-pressed={hidden}
              onClick={() => setHidden(!hidden)}
            >
              {hidden ? 'Show active assistants' : 'Hidden assistants'}
            </button>
          </div>
          {hidden && (
            <p className="form-note">
              Hidden assistants keep working. Their conversations and routines stay saved.
            </p>
          )}
          <div className="assistant-profile-list">
            {assistants.map((a) => {
              const memoryCount = assistantMemories(s, a.id).filter(
                (m: any) => m.type === 'note',
              ).length;
              const routineCount = (s.routines || []).filter(
                (r) => !r.archived && threadAssistantId(s, r.threadId) === a.id,
              ).length;
              return (
                <article
                  className="assistant-profile-row"
                  key={a.id}
                  aria-label={`${a.name} profile`}
                >
                  <div className="assistant-profile-heading">
                    <AssistantAvatar assistantId={a.id} />
                    <div>
                      <h2>
                        {a.name}
                        {a.id === 'relay' && <small>Main</small>}
                        {a.pinned && <PushPin size={15} aria-label="Pinned" />}
                      </h2>
                      <p>{assistantStatus(s, a.id)}</p>
                    </div>
                    <button
                      className="icon-button"
                      aria-label={`Chat with ${a.name}`}
                      title={`Chat with ${a.name}`}
                      onClick={() => selectThread(a.threadId)}
                    >
                      <ArrowRight size={21} />
                    </button>
                  </div>
                  {a.description && <p className="assistant-role-description">{a.description}</p>}
                  <p className="assistant-profile-counts">
                    {memoryCount} {memoryCount === 1 ? 'memory' : 'memories'} · {routineCount}{' '}
                    {routineCount === 1 ? 'routine' : 'routines'}
                  </p>
                  <div className="assistant-profile-actions">
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => edit(a)}
                      aria-label={`Edit ${a.name}`}
                    >
                      <PencilSimple size={15} /> Edit profile
                    </button>
                    <button
                      className="text-button"
                      onClick={() => {
                        selectThread(a.threadId);
                        go('routines');
                      }}
                      aria-label={`Routines for ${a.name}`}
                    >
                      Routines
                    </button>
                    <button
                      className="text-button"
                      aria-label={`Share ${a.name}`}
                      onClick={() => setTemplateMode(a.id)}
                    >
                      Share setup
                    </button>
                    <details className="assistant-more">
                      <summary>More</summary>
                      <div>
                        {a.id !== 'relay' && (
                          <button
                            className="text-button"
                            disabled={busy}
                            aria-label={`${a.pinned ? 'Unpin' : 'Pin'} ${a.name}`}
                            onClick={() =>
                              void change(
                                'assistant.pin',
                                { id: a.id, value: !a.pinned },
                                a.pinned ? 'Assistant unpinned.' : 'Assistant pinned.',
                              )
                            }
                          >
                            <PushPin size={15} />
                            {a.pinned ? 'Unpin' : 'Pin'}
                          </button>
                        )}
                        {a.id !== 'relay' && (
                          <button
                            className="text-button"
                            disabled={busy}
                            aria-label={`${a.hidden ? 'Unhide' : 'Hide'} ${a.name}`}
                            onClick={() =>
                              void change(
                                'assistant.hide',
                                { id: a.id, value: !a.hidden },
                                a.hidden
                                  ? 'Assistant restored to the sidebar.'
                                  : 'Assistant hidden. Its routines keep working.',
                              )
                            }
                          >
                            {a.hidden ? <Eye size={15} /> : <EyeSlash size={15} />}
                            {a.hidden ? 'Unhide' : 'Hide'}
                          </button>
                        )}
                        <button
                          className="text-button"
                          disabled={busy}
                          aria-label={`Duplicate ${a.name}`}
                          onClick={async () => {
                            const copy = await change('assistant.duplicate', { id: a.id }, '');
                            if (copy) {
                              edit(copy);
                              setNotice(
                                'Profile and routines copied. Memories and conversation history stay with the original. Copied routines are paused until you review and enable them.',
                              );
                            }
                          }}
                        >
                          <Copy size={15} /> Duplicate
                        </button>
                      </div>
                    </details>
                  </div>
                </article>
              );
            })}
            {!assistants.length && <p className="empty-state">No hidden assistants.</p>}
          </div>
        </>
      )}
      {notice && (
        <p className="setup-note" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}
