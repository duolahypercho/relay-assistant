import { useState } from 'react';
import {
  Envelope,
  Plus,
  ArrowsClockwise,
  MagnifyingGlass,
  ArrowLeft,
  Paperclip,
  ArrowBendUpLeft,
  FileText,
} from '@phosphor-icons/react';
import { useWorkspace } from '../context';
import { api } from '../api';
import { PageHeading, Field, Modal, Empty, dateTime } from '../components/ui';
import type { Entity } from '../types';
export default function Inbox() {
  const { s, act, run, go, openFile, openTask, toast } = useWorkspace();
  const [folder, setFolder] = useState('inbox');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');
  const [compose, setCompose] = useState(false);
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [attachments, setAttachments] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [thread, setThread] = useState<Entity[]>([]);
  const messages = s.mail.filter(
    (m) =>
      m.folder === folder &&
      `${m.from} ${m.subject} ${m.body}`.toLowerCase().includes(query.toLowerCase()),
  );
  const message = s.mail.find((m) => m.id === selected);
  async function open(m: Entity) {
    setSelected(m.id);
    setThread([]);
    await act('mail.read', { id: m.id });
    if (s.connections.google.connected && m.threadId)
      await run(async () => {
        const r = await api.request(`/google/thread/${encodeURIComponent(m.id)}`);
        setThread(r.messages);
      });
  }
  function draft(m?: Entity) {
    setTo(m?.email || '');
    setSubject(m ? (/^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`) : '');
    setBody('');
    setReplyTo(m?.id || '');
    setAttachments([]);
    setCompose(true);
  }
  async function sync() {
    setBusy(true);
    await run(async () => {
      const r = await api.request('/google/sync', {
        method: 'POST',
        body: JSON.stringify({
          query: folder === 'sent' ? 'in:sent' : 'in:inbox',
          includeCalendar: false,
        }),
      });
      await api.refresh();
      toast(`Synced ${r.messages} messages${r.partial ? ' · More are available in Google' : ''}.`);
    });
    setBusy(false);
  }
  return (
    <section>
      <PageHeading
        title="A little less in your inbox"
        description={
          s.connections.google.connected
            ? `${s.connections.google.email} · ${s.connections.google.partial ? 'Showing a limited recent window' : 'Your connected mailbox'}`
            : 'A fictional mailbox to try replies, attachments, and reviews.'
        }
      >
        <button
          className="secondary-button"
          onClick={() =>
            s.connections.google.connected ? void sync() : go('settings', 'connections')
          }
          disabled={busy}
        >
          <ArrowsClockwise size={18} />
          {busy ? 'Syncing…' : s.connections.google.connected ? 'Sync Google' : 'Connect Google'}
        </button>
        <button className="primary-button" onClick={() => draft()}>
          <Plus size={18} />
          Compose
        </button>
      </PageHeading>
      <div className="surface-toolbar">
        <div className="tabs">
          {['inbox', 'sent'].map((f) => (
            <button
              key={f}
              className={folder === f ? 'selected' : ''}
              onClick={() => {
                setFolder(f);
                setSelected('');
              }}
            >
              {f === 'inbox' ? 'Inbox' : 'Sent'}{' '}
              <span className="count-label">{s.mail.filter((m) => m.folder === f).length}</span>
            </button>
          ))}
        </div>
        <label className="search-input">
          <MagnifyingGlass size={18} />
          <input
            aria-label="Search mail"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a message…"
          />
        </label>
      </div>
      <div className={`mail-workspace ${message ? 'has-selection' : ''}`}>
        <div className="mail-list">
          {messages.length ? (
            messages.map((m) => (
              <button
                key={m.id}
                className={`mail-item ${m.id === selected ? 'selected' : ''} ${!m.read ? 'unread' : ''}`}
                onClick={() => void open(m)}
              >
                <div className="mail-item-top">
                  <strong>{m.folder === 'sent' ? `To ${m.to}` : m.from}</strong>
                  <time>{dateTime(m.date).split(',').slice(0, 1)}</time>
                </div>
                <h3>{m.subject}</h3>
                <p>{m.body}</p>
                <div className="mail-item-bottom">
                  {!!(m.attachmentIds?.length || m.attachments?.length) && (
                    <span>
                      <Paperclip size={14} />
                      Attachment
                    </span>
                  )}
                  {!m.read && <span className="unread-marker" />}
                </div>
              </button>
            ))
          ) : (
            <Empty icon={Envelope} title="Nothing waiting here">
              Try a different search, or sync your connected mailbox.
            </Empty>
          )}
        </div>
        <div className="mail-detail">
          {message ? (
            <>
              <button className="text-button mail-back" onClick={() => setSelected('')}>
                <ArrowLeft size={17} />
                All messages
              </button>
              <div className="mail-detail-head">
                <h2>{message.subject}</h2>
                <span className="mini-avatar">{message.from.slice(0, 1)}</span>
                <div>
                  <strong>{message.from}</strong>
                  <span>
                    {message.email} · To {message.to || 'you'}
                  </span>
                  <small>{dateTime(message.date)}</small>
                </div>
              </div>
              <div className="mail-body">{message.body}</div>
              {message.attachmentIds?.map((id: string) => (
                <button key={id} className="attachment-button" onClick={() => openFile(id)}>
                  <FileText size={19} />
                  {s.files.find((f) => f.id === id)?.name || 'Attachment'}
                </button>
              ))}
              {message.attachments?.map((f: any) => (
                <button
                  key={f.attachmentId}
                  className="attachment-button"
                  onClick={() =>
                    void run(async () => {
                      const r = await api.request('/google/attachment', {
                        method: 'POST',
                        body: JSON.stringify({ id: message.id, attachmentId: f.attachmentId }),
                      });
                      await api.refresh();
                      openFile(r.result.id);
                    })
                  }
                >
                  <Paperclip size={19} />
                  {f.name}
                  <span>Import to Files</span>
                </button>
              ))}
              {thread
                .filter((m) => m.providerId !== message.providerId)
                .map((m) => (
                  <details className="mail-thread" key={m.id}>
                    <summary>
                      {m.from} · {dateTime(m.date)}
                    </summary>
                    <div className="mail-body">{m.body}</div>
                  </details>
                ))}
              <div className="mail-detail-actions">
                {message.folder !== 'sent' && (
                  <button className="primary-button" onClick={() => draft(message)}>
                    <ArrowBendUpLeft size={18} />
                    Prepare a reply
                  </button>
                )}
                {message.attachmentIds?.some(
                  (id: string) => s.files.find((f) => f.id === id)?.mime === 'application/pdf',
                ) && (
                  <button
                    className="secondary-button"
                    onClick={async () => {
                      const t = await act('task.create', {
                        title: `Complete the form from ${message.from}`,
                        description: message.body,
                        kind: 'document',
                        sourceId: message.id,
                        fileId: message.attachmentIds.find(
                          (id: string) =>
                            s.files.find((f) => f.id === id)?.mime === 'application/pdf',
                        ),
                      });
                      if (t) openTask(t.id);
                    }}
                  >
                    <FileText size={18} />
                    Fill the attached form
                  </button>
                )}
              </div>
            </>
          ) : (
            <Empty icon={Envelope} title="A message, a next step">
              Choose a message to read it, open an attachment, or prepare a reply.
            </Empty>
          )}
        </div>
      </div>
      {compose && (
        <Modal
          title={replyTo ? 'Prepare a reply' : 'Write a message'}
          onClose={() => setCompose(false)}
          wide
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const a = await act('mail.prepare', {
                to,
                subject,
                body,
                replyTo,
                attachmentIds: attachments,
              });
              if (a) {
                setCompose(false);
                toast('Your message is ready for review.');
              }
            }}
          >
            <Field label="To">
              <input
                type="email"
                required
                value={to}
                onChange={(e) => setTo(e.target.value)}
                maxLength={250}
              />
            </Field>
            <Field label="Subject">
              <input
                required
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                maxLength={200}
              />
            </Field>
            <Field label="Message">
              <textarea
                required
                rows={8}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={16000}
              />
            </Field>
            <Field label="Attach workspace files">
              <select
                multiple
                aria-label="Attach workspace files"
                value={attachments}
                onChange={(e) =>
                  setAttachments(
                    Array.from(e.target.selectedOptions)
                      .map((o) => o.value)
                      .slice(0, 8),
                  )
                }
              >
                {s.files.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </Field>
            <p className="form-note">
              The exact recipient, text, and attachments will appear in Activity for your approval.
            </p>
            <button type="submit" className="primary-button">
              Prepare for review
            </button>
          </form>
        </Modal>
      )}
    </section>
  );
}
