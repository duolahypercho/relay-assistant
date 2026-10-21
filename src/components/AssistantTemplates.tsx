import { CharacterSprite } from './CharacterLook';
import { copyText } from '../copy-text';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Copy, UploadSimple } from '@phosphor-icons/react';
import { useWorkspace } from '../context';
import { api } from '../api';
import { Field } from './ui';
import FileDownload from './FileDownload';
import {
  prepareTemplate,
  validateTemplate,
  templateWarnings,
  TEMPLATE_LIMIT,
} from '../../shared/assistant-templates.mjs';
import { scheduleLabel } from '../../shared/routines.mjs';
import './assistant-templates.css';
import { templateSourceUrl } from '../../shared/assistant-template-links.mjs';
import { acknowledgeTemplateLink } from '../template-links';
type Template = ReturnType<typeof validateTemplate>;
type Link = {
  token: string;
  revision: number;
  access: 'public' | 'workspace';
  url: string;
  revoked: boolean;
  template: Template;
};
const request = (path: string, body?: object) =>
  api.request(
    path.replace(/^\/api/, ''),
    body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {},
  );
function validTemplate(value: unknown): Template {
  const t = validateTemplate(value);
  const issues = templateWarnings(t);
  if (issues.length)
    throw new Error(
      `Remove possible credentials or private links from ${issues.join(', ')} before continuing.`,
    );
  return t;
}
function templateUrl(value: string) {
  const url = new URL(templateSourceUrl(value));
  const match = /^\/share\/assistant\/([a-zA-Z0-9_-]{43})$/.exec(url.pathname);
  if (
    !match ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
  )
    throw new Error('Use a Relay template link with HTTPS, or a loopback development link.');
  return `${url.origin}/api/shared-assistants/${match[1]}`;
}
async function loadTemplate(value: string, signal: AbortSignal) {
  const url = templateUrl(value);
  let response: Response;
  try {
    response = await fetch(url, {
      credentials: new URL(url).origin === location.origin ? 'same-origin' : 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal,
    });
  } catch {
    throw new Error(
      'This template is unavailable or could not be reached. Check the link and workspace access.',
    );
  }
  if (!response.ok)
    throw new Error('This template is unavailable, revoked, or needs workspace sign-in.');
  if (!response.headers.get('content-type')?.includes('application/json'))
    throw new Error('This link did not return a Relay template.');
  if (Number(response.headers.get('content-length')) > TEMPLATE_LIMIT + 1000)
    throw new Error('This template is too large.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The template could not be read.');
  const decoder = new TextDecoder();
  let text = '',
    bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > TEMPLATE_LIMIT + 1000) throw new Error('This template is too large.');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel();
  }
  return validTemplate(JSON.parse(text).template);
}
function Method({
  method,
  change,
  readOnly,
}: {
  method: any;
  change: (next: any) => void;
  readOnly: boolean;
}) {
  return (
    <div className="template-fields">
      <Field label="Skill name">
        <input
          value={method.title}
          maxLength={100}
          readOnly={readOnly}
          onChange={(e) => change({ ...method, title: e.target.value })}
        />
      </Field>
      <Field label="Skill shortcut">
        <input
          value={method.slug}
          maxLength={40}
          readOnly={readOnly}
          onChange={(e) => change({ ...method, slug: e.target.value })}
        />
      </Field>
      <Field label="When to use it">
        <textarea
          rows={2}
          value={method.description}
          maxLength={500}
          readOnly={readOnly}
          onChange={(e) => change({ ...method, description: e.target.value })}
        />
      </Field>
      <Field label="Skill instructions">
        <textarea
          rows={5}
          value={method.instructions}
          maxLength={12000}
          readOnly={readOnly}
          onChange={(e) => change({ ...method, instructions: e.target.value })}
        />
      </Field>
    </div>
  );
}
function Configuration({
  value,
  change,
  readOnly = false,
}: {
  value: Template;
  change: (v: Template) => void;
  readOnly?: boolean;
}) {
  const p = value.profile;
  if (readOnly)
    return (
      <div className="template-review-summary">
        <div className="template-review-identity">
          <span
            aria-hidden="true"
            style={{ background: `color-mix(in srgb, ${p.avatarColor} 25%, var(--surface))` }}
          >
            <CharacterSprite appearance={p.appearance} color={p.avatarColor} />
          </span>
          <div>
            <h3>{p.name}</h3>
            <p className="form-note">{p.tone}</p>
          </div>
        </div>
        <p className="template-review-role">{p.description || 'No extra role instructions.'}</p>
        <p className="form-note">
          {p.memoryLearning
            ? 'Learns preferences from future chats.'
            : 'Learning from chats starts off.'}{' '}
          {value.skills.length} {value.skills.length === 1 ? 'skill' : 'skills'} ·{' '}
          {value.routines.length} {value.routines.length === 1 ? 'routine' : 'routines'}. Routines
          start paused.
        </p>
        {value.skills.map((method: any, i: number) => (
          <details key={i} className="template-section">
            <summary>Skill: {method.title}</summary>
            <p className="form-note">
              /{method.slug} · {method.description}
            </p>
            <p className="template-review-role">{method.instructions}</p>
          </details>
        ))}
        {value.routines.map((r: any, i: number) => (
          <details key={i} className="template-section">
            <summary>Routine: {r.title}</summary>
            <p className="form-note">
              {scheduleLabel(r.schedule)} ·{' '}
              {r.execution === 'reminder' ? 'Reminder' : 'Assistant work'} · Notifications:{' '}
              {r.notification}
            </p>
            <p className="template-review-role">{r.instructions}</p>
            {r.skill && (
              <details>
                <summary>Saved method: {r.skill.title}</summary>
                <p className="form-note">
                  /{r.skill.slug} · {r.skill.description}
                </p>
                <p className="template-review-role">{r.skill.instructions}</p>
              </details>
            )}
          </details>
        ))}
      </div>
    );
  return (
    <div className="template-configuration">
      <div className="template-picture-review">
        <span>
          <CharacterSprite appearance={p.appearance} color={p.avatarColor} />
        </span>
        <div>
          <p>
            {p.appearance?.kind === 'image'
              ? 'This picture will be included in the template.'
              : 'This character travels with the template.'}
          </p>
          {p.appearance && p.appearance.kind !== 'sprout' && (
            <button
              type="button"
              className="text-button"
              onClick={() =>
                change({ ...value, profile: { ...p, appearance: { kind: 'sprout' } } })
              }
            >
              Use Relay’s sprout instead
            </button>
          )}
        </div>
      </div>
      <div className="template-fields">
        <Field label="Template name">
          <input
            required
            value={p.name}
            maxLength={40}
            readOnly={readOnly}
            onChange={(e) => change({ ...value, profile: { ...p, name: e.target.value } })}
          />
        </Field>
        <Field label="Template role and instructions">
          <textarea
            rows={5}
            value={p.description}
            maxLength={6000}
            readOnly={readOnly}
            onChange={(e) => change({ ...value, profile: { ...p, description: e.target.value } })}
          />
        </Field>
        <Field label="Template color">
          <input
            type="color"
            value={p.avatarColor}
            disabled={readOnly}
            onChange={(e) => change({ ...value, profile: { ...p, avatarColor: e.target.value } })}
          />
        </Field>
        <Field label="Template working style">
          <input
            value={p.tone}
            maxLength={300}
            readOnly={readOnly}
            onChange={(e) => change({ ...value, profile: { ...p, tone: e.target.value } })}
          />
        </Field>
        <label className="template-check">
          <input
            type="checkbox"
            checked={p.memoryLearning}
            disabled={readOnly}
            onChange={(e) =>
              change({ ...value, profile: { ...p, memoryLearning: e.target.checked } })
            }
          />
          Learn preferences from future chats
        </label>
      </div>
      <p className="form-note">
        {value.skills.length} {value.skills.length === 1 ? 'skill' : 'skills'} ·{' '}
        {value.routines.length} {value.routines.length === 1 ? 'routine' : 'routines'}. Imported
        routines start paused.
      </p>
      {value.skills.map((method: any, i: number) => (
        <details key={i} className="template-section">
          <summary>Skill: {method.title}</summary>
          <Method
            method={method}
            readOnly={readOnly}
            change={(next) =>
              change({
                ...value,
                skills: value.skills.map((x: any, n: number) => (n === i ? next : x)),
              })
            }
          />
          {!readOnly && (
            <button
              className="text-button"
              type="button"
              onClick={() =>
                change({ ...value, skills: value.skills.filter((_: any, n: number) => n !== i) })
              }
            >
              Leave out this skill
            </button>
          )}
        </details>
      ))}
      {value.routines.map((r: any, i: number) => {
        const edit = (next: any) =>
          change({
            ...value,
            routines: value.routines.map((x: any, n: number) => (n === i ? next : x)),
          });
        return (
          <details key={i} className="template-section">
            <summary>Routine: {r.title}</summary>
            <div className="template-fields">
              <Field label="Template routine name">
                <input
                  value={r.title}
                  maxLength={100}
                  readOnly={readOnly}
                  onChange={(e) => edit({ ...r, title: e.target.value })}
                />
              </Field>
              <Field label="Template routine instructions">
                <textarea
                  rows={4}
                  value={r.instructions}
                  maxLength={6000}
                  readOnly={readOnly}
                  onChange={(e) => edit({ ...r, instructions: e.target.value })}
                />
              </Field>
              <p className="form-note">
                {scheduleLabel(r.schedule)} ·{' '}
                {r.execution === 'reminder' ? 'Reminder' : 'Assistant work'} · Notifications:{' '}
                {r.notification}
              </p>
              {r.schedule.kind === 'email' ? (
                <>
                  <Field label="Template sender filter">
                    <input
                      value={r.schedule.sender}
                      maxLength={254}
                      readOnly={readOnly}
                      onChange={(e) =>
                        edit({ ...r, schedule: { ...r.schedule, sender: e.target.value } })
                      }
                    />
                  </Field>
                  <Field label="Template subject filter">
                    <input
                      value={r.schedule.subject}
                      maxLength={200}
                      readOnly={readOnly}
                      onChange={(e) =>
                        edit({ ...r, schedule: { ...r.schedule, subject: e.target.value } })
                      }
                    />
                  </Field>
                </>
              ) : (
                <>
                  <Field label="Template time zone">
                    <input
                      value={r.schedule.timeZone}
                      readOnly={readOnly}
                      onChange={(e) =>
                        edit({ ...r, schedule: { ...r.schedule, timeZone: e.target.value } })
                      }
                    />
                  </Field>
                  {r.schedule.date && (
                    <Field label="Template date">
                      <input
                        type="date"
                        value={r.schedule.date}
                        readOnly={readOnly}
                        onChange={(e) =>
                          edit({ ...r, schedule: { ...r.schedule, date: e.target.value } })
                        }
                      />
                    </Field>
                  )}
                  {r.schedule.time && (
                    <Field label="Template time">
                      <input
                        type="time"
                        value={r.schedule.time}
                        readOnly={readOnly}
                        onChange={(e) =>
                          edit({ ...r, schedule: { ...r.schedule, time: e.target.value } })
                        }
                      />
                    </Field>
                  )}
                </>
              )}
              {r.skill && (
                <details>
                  <summary>Saved method: {r.skill.title}</summary>
                  <Method
                    method={r.skill}
                    readOnly={readOnly}
                    change={(next) => edit({ ...r, skill: next })}
                  />
                </details>
              )}
            </div>
            {!readOnly && (
              <button
                className="text-button"
                type="button"
                onClick={() =>
                  change({
                    ...value,
                    routines: value.routines.filter((_: any, n: number) => n !== i),
                  })
                }
              >
                Leave out this routine
              </button>
            )}
          </details>
        );
      })}
    </div>
  );
}
export default function AssistantTemplates({
  assistantId,
  onClose,
  initialSource = '',
  nativeReceipt = '',
}: {
  assistantId: string | null;
  onClose: () => void;
  initialSource?: string;
  nativeReceipt?: string;
}) {
  const { s, act, selectThread } = useWorkspace();
  const importing = !assistantId;
  const receipt = /^[A-Za-z0-9_-]{16,100}$/.test(nativeReceipt) ? nativeReceipt : '';
  const draftKey = `relay-template-draft:${assistantId || 'import'}${initialSource ? ':' + (receipt || initialSource) : ''}`;
  const [draft, setDraft] = useState<Template | null>(() => {
    try {
      const saved = sessionStorage.getItem(draftKey);
      return saved
        ? validateTemplate(JSON.parse(saved))
        : assistantId
          ? prepareTemplate(s, assistantId).template
          : null;
    } catch {
      return assistantId ? prepareTemplate(s, assistantId).template : null;
    }
  });
  const [removed, setRemoved] = useState<string[]>(() =>
    assistantId ? prepareTemplate(s, assistantId).removed : [],
  );
  const [source, setSource] = useState(
    () =>
      initialSource || new URLSearchParams(location.hash.split('?')[1] || '').get('import') || '',
  );
  const [access, setAccess] = useState<'public' | 'workspace'>('public');
  const [privateAvailable, setPrivateAvailable] = useState(false);
  const [links, setLinks] = useState<Link[]>([]),
    [editing, setEditing] = useState<Link | null>(null);
  const [review, setReview] = useState<{ template: Template; digest?: string } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const lock = useRef(false),
    alive = useRef(true),
    controller = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    try {
      if (draft) sessionStorage.setItem(draftKey, JSON.stringify(draft));
    } catch {}
  }, [draft, draftKey]);
  async function refresh() {
    if (assistantId && api.mode() === 'server') {
      const result = await request(
        `/api/assistant-templates?assistantId=${encodeURIComponent(assistantId)}`,
      );
      if (alive.current) {
        setLinks(result.links);
        setPrivateAvailable(result.workspaceAccessAvailable);
      }
    }
  }
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, [assistantId]);
  async function perform(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : 'This template could not be processed.');
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function change(value: Template) {
    setDraft(value);
    setReview(null);
  }
  async function openSource(asReview = false) {
    await perform(async () => {
      controller.current?.abort();
      controller.current = new AbortController();
      const timeout = setTimeout(() => controller.current?.abort(), 15000);
      try {
        const value = await loadTemplate(source, controller.current.signal);
        if (alive.current) {
          change(value);
          if (asReview) setReview({ template: value });
          setNotice('Template loaded. Review the instructions before adding it.');
        }
      } finally {
        clearTimeout(timeout);
      }
    });
  }
  useEffect(() => {
    if (!receipt) return;
    if (draft) {
      try {
        setReview({ template: validTemplate(draft) });
      } catch (error) {
        setDraft(null);
        setError(error instanceof Error ? error.message : 'This template could not be read.');
      }
      return;
    }
    const timer = setTimeout(() => void openSource(true), 0);
    return () => clearTimeout(timer);
  }, [receipt]);
  function close() {
    if (!receipt) {
      onClose();
      return;
    }
    const dismiss = async () => {
      controller.current?.abort();
      await acknowledgeTemplateLink(receipt);
      sessionStorage.removeItem(draftKey);
      onClose();
    };
    if (busy && !draft) void dismiss().catch((error) => setError(error.message));
    else void perform(dismiss);
  }
  const bytes = review
    ? new TextEncoder().encode(JSON.stringify(review.template, null, 2) + '\n')
    : null;
  const [download, setDownload] = useState('');
  useEffect(() => {
    if (!bytes) {
      setDownload('');
      return;
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/json' }));
    setDownload(url);
    return () => URL.revokeObjectURL(url);
  }, [review]);
  return (
    <section
      className="template-editor"
      aria-label={importing ? 'Import assistant template' : 'Share assistant template'}
    >
      <button className="text-button" onClick={close} disabled={busy && !(receipt && !draft)}>
        <ArrowLeft size={16} />
        All assistants
      </button>
      <h2>
        {importing
          ? 'Add an assistant from a template'
          : editing
            ? 'Update shared template'
            : 'Share this assistant’s setup'}
      </h2>
      <p className="form-note">
        Templates include a role, selected skills and routine settings. Conversations, learned
        memories, attachments, computer access and credentials stay in the original workspace.
      </p>
      {receipt && !draft && (
        <p role="status">
          {busy ? 'Opening shared setup…' : 'Review this shared setup before adding it.'}{' '}
          {!busy && error && (
            <button className="secondary-button" onClick={() => void openSource(true)}>
              Try again
            </button>
          )}
        </p>
      )}
      {importing && !receipt && (
        <div className="template-import">
          <Field label="Template link">
            <input
              type="url"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="https://relay.example.com/share/assistant/…"
            />
          </Field>
          <button
            className="secondary-button"
            disabled={busy || !source.trim()}
            onClick={() =>
              void perform(async () => {
                controller.current?.abort();
                controller.current = new AbortController();
                const timeout = setTimeout(() => controller.current?.abort(), 15000);
                try {
                  const value = await loadTemplate(source, controller.current.signal);
                  if (alive.current) {
                    change(value);
                    setNotice('Template loaded. Review the instructions before adding it.');
                  }
                } finally {
                  clearTimeout(timeout);
                }
              })
            }
          >
            Load template
          </button>
          <label className="template-upload">
            <UploadSimple size={16} />
            Choose a template file
            <input
              type="file"
              accept=".json,application/json"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file)
                  void perform(async () => {
                    if (file.size > TEMPLATE_LIMIT)
                      throw new Error('Choose a template under 256 KB.');
                    const value = validTemplate(JSON.parse(await file.text()));
                    if (alive.current) {
                      change(value);
                      setNotice('File loaded. Review its instructions before adding it.');
                    }
                  });
              }}
            />
          </label>
        </div>
      )}
      {!!removed.length && !importing && (
        <p className="template-note">
          Removed possible credentials, private links or sender addresses from {removed.length}{' '}
          fields. Review the remaining wording for private or customer information; automatic checks
          cannot find every sensitive detail.
        </p>
      )}
      {draft && (
        <>
          <fieldset disabled={busy} className="template-fieldset">
            <Configuration value={review?.template || draft} change={change} readOnly={!!review} />
            {!importing && (
              <Field label="Who can open the link">
                <select
                  value={access}
                  disabled={!!review}
                  onChange={(e) => {
                    setAccess(e.target.value as 'public' | 'workspace');
                    setReview(null);
                  }}
                >
                  <option value="public">Anyone with the link</option>
                  <option value="workspace" disabled={!privateAvailable}>
                    Signed-in workspace owner
                  </option>
                </select>
              </Field>
            )}
            {!importing && (
              <p className="form-note">
                {access === 'public'
                  ? 'Anyone with this link can read and download this configuration.'
                  : 'This link requires sign-in to this Relay server.'}{' '}
                Revoking a link cannot recall copies already downloaded or imported.
              </p>
            )}
            {review ? (
              <div className="template-actions">
                <button className="text-button" onClick={() => setReview(null)}>
                  {importing ? 'Edit before adding' : 'Edit before sharing'}
                </button>
                {importing ? (
                  <button
                    className="primary-button"
                    onClick={() =>
                      void perform(async () => {
                        const a = await act('template.import', {
                          template: review.template,
                          ...(receipt ? { requestId: receipt } : {}),
                        });
                        if (a) {
                          sessionStorage.removeItem(draftKey);
                          await acknowledgeTemplateLink(receipt).catch(() => {});
                          selectThread(a.threadId);
                        }
                      })
                    }
                  >
                    Add assistant
                  </button>
                ) : (
                  <>
                    <FileDownload
                      href={download}
                      name="relay-assistant.json"
                      mime="application/json"
                      bytes={async () => bytes!}
                      label="Download assistant template"
                    >
                      Download template
                    </FileDownload>
                    {api.mode() === 'server' && (
                      <button
                        className="primary-button"
                        onClick={() =>
                          void perform(async () => {
                            const result = await request('/api/assistant-templates', {
                              assistantId,
                              template: review.template,
                              access,
                              reviewedDigest: review.digest,
                              ...(editing
                                ? { token: editing.token, revision: editing.revision }
                                : {}),
                            });
                            setEditing(result.link);
                            setNotice(
                              editing
                                ? 'Shared template updated.'
                                : 'Link created. Copy it below when you are ready to share.',
                            );
                            await refresh();
                          })
                        }
                      >
                        {editing
                          ? 'Update shared link'
                          : access === 'public'
                            ? 'Create public link'
                            : 'Create workspace link'}
                      </button>
                    )}
                  </>
                )}
              </div>
            ) : (
              <div className="template-actions">
                <button
                  className="primary-button"
                  onClick={() =>
                    void perform(async () => {
                      const template = validTemplate(draft);
                      const checked =
                        api.mode() === 'server' && !importing
                          ? await request('/api/assistant-templates/review', { template, access })
                          : { template };
                      setReview(checked);
                    })
                  }
                >
                  Review template
                </button>
                {!importing && (
                  <button
                    className="text-button"
                    onClick={() => {
                      const next = prepareTemplate(s, assistantId!);
                      change(next.template);
                      setRemoved(next.removed);
                    }}
                  >
                    Use current setup
                  </button>
                )}
              </div>
            )}
          </fieldset>
          {api.mode() === 'sample' && !importing && (
            <p className="form-note">
              You can download a template here. Connect to a Relay server to create a share link.
            </p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="template-notice">
          {notice}
        </p>
      )}
      {!importing && !!links.length && (
        <section className="template-links" aria-label="Shared links">
          <h3>Your shared links</h3>
          {links.map((link) => (
            <article key={link.token} aria-label={`Shared template version ${link.revision}`}>
              <p>
                <strong>
                  {link.revoked
                    ? 'Stopped'
                    : link.access === 'public'
                      ? 'Anyone with the link'
                      : 'Workspace sign-in required'}
                </strong>{' '}
                · version {link.revision}
              </p>
              <a href={link.url} target="_blank" rel="noreferrer">
                View template details
              </a>
              <div className="template-actions">
                <button
                  className="text-button"
                  disabled={busy || link.revoked}
                  onClick={() =>
                    void perform(async () => {
                      await copyText(link.url);
                      setNotice('Template link copied.');
                    })
                  }
                >
                  <Copy size={15} />
                  Copy link
                </button>
                <button
                  className="text-button"
                  disabled={busy || link.revoked}
                  onClick={() => {
                    setEditing(link);
                    change(link.template);
                    setAccess(link.access);
                    setRemoved([]);
                    setNotice(
                      'Editing the shared version. Use current setup to bring in your latest profile.',
                    );
                  }}
                >
                  Update template
                </button>
                <button
                  className="text-button"
                  disabled={busy || link.revoked}
                  onClick={() =>
                    void perform(async () => {
                      await request(`/api/assistant-templates/${link.token}/revoke`, {
                        revision: link.revision,
                      });
                      if (editing?.token === link.token) {
                        setEditing(null);
                        setReview(null);
                      }
                      await refresh();
                      setNotice(
                        'Link stopped. Previously downloaded copies remain with their recipients.',
                      );
                    })
                  }
                >
                  Stop sharing
                </button>
              </div>
            </article>
          ))}
        </section>
      )}
    </section>
  );
}
