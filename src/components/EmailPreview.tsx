import { useEffect, useRef, useState } from 'react';
import { Paperclip, ArrowLeft } from '@phosphor-icons/react';
import { api } from '../api';
import { useWorkspace } from '../context';
import { fileBytes } from '../../shared/pdf.mjs';
import FileDownload from './FileDownload';
import './email-preview.css';
type Preview = {
  subject: string;
  from: string;
  to: string;
  cc: string;
  bcc: string;
  replyTo: string;
  date: string;
  text: string;
  contentHash: string;
  nextOffset: number | null;
  totalLength: number;
  warnings: string[];
  attachments: { index: number; name: string; mime: string; size: number; inline: boolean }[];
};
export default function EmailPreview({ file, snapshot }: { file: any; snapshot: boolean }) {
  const { s } = useWorkspace();
  const [preview, setPreview] = useState<Preview | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<number | null>(null),
    [opened, setOpened] = useState<any>(null),
    [attachmentError, setAttachmentError] = useState('');
  const request = useRef<AbortController | null>(null),
    attachmentRequest = useRef<AbortController | null>(null);
  const supported = api.mode() === 'server' && !snapshot;
  async function load(next = false) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError('');
    try {
      const query =
        next && preview ? `?offset=${preview.nextOffset}&contentHash=${preview.contentHash}` : '';
      const value: Preview = await api.request(
        `/files/${encodeURIComponent(file.id)}/email${query}`,
        { signal: controller.signal },
      );
      if (!controller.signal.aborted)
        setPreview((old) => ({ ...value, text: next && old ? old.text + value.text : value.text }));
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'This email could not be opened.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    if (supported) void load();
    return () => {
      request.current?.abort();
      attachmentRequest.current?.abort();
    };
  }, [file.id, supported]);
  async function open(index: number) {
    if (!preview || busy !== null) return;
    const controller = new AbortController();
    attachmentRequest.current = controller;
    setBusy(index);
    setAttachmentError('');
    try {
      const { result } = await api.request(
        `/files/${encodeURIComponent(file.id)}/email/attachments`,
        {
          method: 'POST',
          body: JSON.stringify({ index, contentHash: preview.contentHash }),
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted) return;
      await api.refresh();
      if (!controller.signal.aborted) setOpened(result);
    } catch (e) {
      if (!controller.signal.aborted)
        setAttachmentError(e instanceof Error ? e.message : 'This attachment could not be opened.');
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }
  if (!supported)
    return (
      <p className="form-note">
        Download the original email to open it. Email previews are available for saved files on your
        Relay server.
      </p>
    );
  if (opened)
    return (
      <EnclosedFile
        file={s.files.find((f) => f.id === opened.id) || opened}
        back={() => setOpened(null)}
      />
    );
  return (
    <section className="email-preview" aria-label="Saved email preview">
      {preview && (
        <>
          <h2>{preview.subject}</h2>
          <dl>
            {[
              ['From', preview.from],
              ['To', preview.to],
              [
                'Date',
                Number.isNaN(Date.parse(preview.date))
                  ? preview.date
                  : new Intl.DateTimeFormat(undefined, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(new Date(preview.date)),
              ],
              ['Cc', preview.cc],
              ['Bcc', preview.bcc],
              ['Reply to', preview.replyTo],
            ]
              .filter(([, value]) => value)
              .map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
          </dl>
          <p className="form-note">Saved email · Sender details are unverified</p>
          <pre className="email-body">{preview.text || 'No readable message body.'}</pre>
          {preview.nextOffset !== null && (
            <button className="secondary-button" disabled={loading} onClick={() => void load(true)}>
              Read more of this email
            </button>
          )}
          {!!preview.attachments.length && (
            <div className="email-attachments" aria-label="Email attachments">
              <h3>Attachments</h3>
              {preview.attachments.map((a) => (
                <button
                  key={a.index}
                  className="email-attachment"
                  disabled={busy !== null}
                  onClick={() => void open(a.index)}
                  aria-label={`Open attachment ${a.name}`}
                >
                  <Paperclip size={19} />
                  <span>
                    {a.name}
                    <small>
                      {Math.max(1, Math.ceil(a.size / 1024))} KB
                      {a.inline ? ' · Inline image or file' : ''}
                    </small>
                  </span>
                  <span>{busy === a.index ? 'Opening…' : 'Open'}</span>
                </button>
              ))}
              <p className="form-note">Opening an attachment also keeps a copy in Files.</p>
            </div>
          )}
          {attachmentError && <p role="alert">{attachmentError}</p>}
          <details>
            <summary>About this preview</summary>
            {preview.warnings.map((w) => (
              <p key={w} className="form-note">
                {w}
              </p>
            ))}
          </details>
        </>
      )}
      {loading && <p role="status">{preview ? 'Reading more…' : 'Opening the email…'}</p>}
      {error && (
        <>
          <p role="alert">{error}</p>
          <button className="secondary-button" disabled={loading} onClick={() => void load()}>
            Open preview again
          </button>
        </>
      )}
    </section>
  );
}
function EnclosedFile({ file, back }: { file: any; back: () => void }) {
  const { openFile } = useWorkspace();
  const [url, setUrl] = useState(''),
    [downloadError, setDownloadError] = useState('');
  useEffect(() => {
    let alive = true,
      object = '';
    void fileBytes(file)
      .then((bytes) => {
        if (!alive) return;
        object = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: file.mime }));
        setUrl(object);
      })
      .catch(() => {
        if (alive)
          setDownloadError('The attachment could not be opened. Try opening its file preview.');
      });
    return () => {
      alive = false;
      if (object) URL.revokeObjectURL(object);
    };
  }, [file.id]);
  return (
    <section className="email-preview" aria-label="Email attachment">
      <button className="text-button" onClick={back}>
        <ArrowLeft size={16} />
        Back to email
      </button>
      <h2>{file.name}</h2>
      {file.text !== undefined ? (
        <pre className="email-body">{file.text}</pre>
      ) : (
        <p className="form-note">
          Saved in Files. Open its preview or save the original to your device.
        </p>
      )}
      {file.textTruncated && (
        <p className="form-note">
          Showing part of this large attachment. Download it to see everything.
        </p>
      )}
      {downloadError && <p role="alert">{downloadError}</p>}
      <div className="email-attachment-actions">
        <button className="secondary-button" onClick={() => openFile(file.id)}>
          Open file preview
        </button>
        <FileDownload
          href={url || undefined}
          name={file.name}
          label={`Download ${file.name}`}
          children="Download attachment"
          mime={file.mime}
          bytes={() => fileBytes(file)}
        />
      </div>
    </section>
  );
}
