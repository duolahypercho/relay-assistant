import { isEmailFile } from '../../shared/email-files.mjs';
import AskAboutFile from '../components/AskAboutFile';
import { mediaKind, mediaMime } from '../../shared/media-files.mjs';
import MediaPreview from '../components/MediaPreview';
import { officeKind, officeMime } from '../../shared/office-files.mjs';
import { useState, useRef, useEffect, useMemo, lazy, Suspense } from 'react';
import {
  Folder,
  FileText,
  FilePdf,
  FileCsv,
  UploadSimple,
  Plus,
  Trash,
  FloppyDisk,
  MagnifyingGlass,
  Spinner,
  Eye,
} from '@phosphor-icons/react';
import { useWorkspace } from '../context';
import { PageHeading, Field, Modal, Empty, dateTime } from '../components/ui';
import { fileBytes, fromBase64 } from '../../shared/pdf.mjs';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { artifactKinds } from '../../shared/artifacts.mjs';
import { api } from '../api';
import FileDownload from '../components/FileDownload';
import FileDrop, { useFileDrop, validateFileBatch } from '../components/FileDrop';
const PdfViewer = lazy(() => import('../components/PdfViewer'));
const OfficePreview = lazy(() => import('../components/OfficePreview'));
const EmailPreview = lazy(() => import('../components/EmailPreview'));
export async function fileToPayload(file: File) {
  if (file.size > 8 * 1024 * 1024) throw new Error('Use a file smaller than 8 MB.');
  const type =
    (isEmailFile({ name: file.name, mime: file.type }) ? 'message/rfc822' : '') ||
    officeMime(file.name) ||
    mediaMime({ name: file.name, mime: file.type }) ||
    file.type ||
    (/\.md$/i.test(file.name)
      ? 'text/markdown'
      : /\.csv$/i.test(file.name)
        ? 'text/csv'
        : /\.pdf$/i.test(file.name)
          ? 'application/pdf'
          : 'application/octet-stream');
  const base64 = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('This file could not be read.'));
    r.readAsDataURL(file);
  });
  return {
    name: file.name,
    mime: type,
    base64,
  };
}
export function FileDialog({
  id,
  onClose,
  snapshot,
}: {
  id: string;
  onClose: () => void;
  snapshot?: any;
}) {
  const { s } = useWorkspace();
  const file = snapshot || s.files.find((f) => f.id === id);
  return (
    <Modal title={file?.name || 'File unavailable'} onClose={onClose} wide>
      <FileContent id={id} onClose={onClose} snapshot={snapshot} />
    </Modal>
  );
}
export function FilePreview({ id, onClose }: { id: string; onClose?: () => void }) {
  const { go } = useWorkspace();
  return (
    <div className="file-page-preview">
      <FileContent key={id} id={id} onClose={onClose || (() => go('files'))} />
    </div>
  );
}
function FileContent({
  id,
  onClose,
  snapshot,
}: {
  id: string;
  onClose: () => void;
  snapshot?: any;
}) {
  const { s, act, run, openTask } = useWorkspace();
  const file = snapshot || s.files.find((f) => f.id === id);
  const textFile =
    !isEmailFile(file) && (file?.mime.startsWith('text/') || file?.mime === 'application/json');
  const savedText = useMemo(
    () => file?.text ?? (textFile ? new TextDecoder().decode(fromBase64(file?.base64 || '')) : ''),
    [file?.text, file?.base64, textFile],
  );
  const [text, setText] = useState<string>(savedText);
  const previousSavedText = useRef<string>(savedText);
  const [edit, setEdit] = useState(false);
  const [url, setUrl] = useState('');
  const [imageFailed, setImageFailed] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    document.dispatchEvent(new Event('relay:preview-file'));
  }, [id]);
  useEffect(() => {
    const previous = previousSavedText.current;
    previousSavedText.current = savedText;
    setText((current) => (current === previous ? savedText : current));
  }, [savedText]);
  useEffect(() => {
    if (!file) return;
    let alive = true,
      object = '';
    setUrl('');
    setImageFailed(false);
    void fileBytes(file)
      .then((bytes) => {
        object = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: file.mime }));
        if (alive) setUrl(object);
        else URL.revokeObjectURL(object);
      })
      .catch(() => {
        if (alive) setImageFailed(true);
      });
    return () => {
      alive = false;
      if (object) URL.revokeObjectURL(object);
    };
  }, [file?.id, file?.updatedAt]);
  if (!file) return <p role="status">This file is no longer in your workspace.</p>;
  return (
    <>
      <div className="file-dialog-toolbar">
        <span>
          {file.source} · {dateTime(file.createdAt)}
        </span>
        <div>
          {!snapshot && !edit && text === savedText && <AskAboutFile id={file.id} />}
          {textFile && !snapshot && !file.textTruncated && (
            <button className="secondary-button" onClick={() => setEdit(!edit)}>
              {edit ? <Eye size={17} /> : <FileText size={17} />} {edit ? 'Preview' : 'Edit text'}
            </button>
          )}
          <FileDownload
            href={url || undefined}
            name={file.name}
            mime={file.mime}
            bytes={() => fileBytes(file)}
          />
        </div>
      </div>
      {!snapshot && textFile && text !== savedText && (
        <p className="form-note" role="status">
          Unsaved changes
        </p>
      )}
      {file.textTruncated && (
        <p className="form-note">Showing part of this large file. Download it to see everything.</p>
      )}
      {file.mime === 'application/pdf' ? (
        <Suspense
          fallback={
            <div className="loading-block">
              <Spinner size={24} />
              Opening the document…
            </div>
          }
        >
          <PdfViewer file={file} />
        </Suspense>
      ) : officeKind(file) ? (
        <Suspense fallback={<p role="status">Opening the file…</p>}>
          <OfficePreview
            key={`${file.id}:${file.updatedAt || ''}`}
            file={file}
            snapshot={!!snapshot}
          />
        </Suspense>
      ) : isEmailFile(file) ? (
        <Suspense fallback={<p role="status">Opening the email…</p>}>
          <EmailPreview
            key={`${file.id}:${file.updatedAt || ''}`}
            file={file}
            snapshot={!!snapshot}
          />
        </Suspense>
      ) : textFile ? (
        edit ? (
          <textarea
            className="text-editor"
            aria-label="File text"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        ) : (
          <div className="document-preview markdown">
            {file.mime === 'text/markdown' ? (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  img: ({ alt, src }) => <span>Image reference: {alt || src}</span>,
                  a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
                }}
              >
                {text}
              </ReactMarkdown>
            ) : (
              <pre>{text}</pre>
            )}
          </div>
        )
      ) : mediaKind(file) ? (
        <MediaPreview key={`${file.id}:${file.updatedAt || ''}`} file={file} />
      ) : ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.mime) ? (
        imageFailed ? (
          <Empty title="Preview unavailable">
            This image could not be opened. You can still download the original file.
          </Empty>
        ) : url ? (
          <img
            className="image-preview"
            alt={file.name}
            src={url}
            onError={() => setImageFailed(true)}
          />
        ) : (
          <div className="loading-block" role="status">
            Opening the image…
          </div>
        )
      ) : (
        <Empty title="Ready to download">
          This file type is stored safely. Download it to open in your preferred app.
        </Empty>
      )}
      {snapshot ? (
        <p className="form-note">
          This is the attachment saved with this review. Later edits to workspace files do not
          change the reviewed copy.
        </p>
      ) : (
        <div className="modal-footer">
          <div>
            {confirmDelete ? (
              <span className="inline-confirm">
                Remove this file?
                <button
                  className="danger-button"
                  onClick={async () => {
                    if (await act('file.delete', { id })) {
                      onClose();
                    }
                  }}
                >
                  Remove file
                </button>
                <button className="secondary-button" onClick={() => setConfirmDelete(false)}>
                  Keep it
                </button>
              </span>
            ) : (
              <button className="text-button danger-text" onClick={() => setConfirmDelete(true)}>
                <Trash size={17} />
                Remove file
              </button>
            )}
          </div>
          <div>
            {file.mime === 'application/pdf' && (
              <button
                className="secondary-button"
                onClick={() =>
                  void run(async () => {
                    const t = await act('task.create', {
                      title: `Fill ${file.name}`,
                      description: `Fill the editable fields in ${file.name}`,
                      kind: 'document',
                      fileId: file.id,
                    });
                    if (t) {
                      onClose();
                      openTask(t.id);
                    }
                  })
                }
              >
                Fill this form
              </button>
            )}
            {(edit || (textFile && text !== savedText)) && (
              <button
                className="primary-button"
                onClick={async () => {
                  if (await act('file.edit', { id, text })) setEdit(false);
                }}
              >
                <FloppyDisk size={18} />
                Save changes
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
export default function Files() {
  const { s, act, run, openFile, openArtifact } = useWorkspace();
  const [query, setQuery] = useState('');
  const [create, setCreate] = useState(false);
  const [name, setName] = useState('new-note.md');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const uploading = useRef(false);
  const files = s.files.filter(
    (f) =>
      (!f.artifactId ||
        s.artifacts?.find((a) => a.id === f.artifactId)?.versions.at(-1).fileId === f.id) &&
      f.name.toLowerCase().includes(query.toLowerCase()),
  );
  async function upload(list: FileList | File[] | null) {
    const selected = Array.from(list || []);
    if (!selected.length || uploading.current) return;
    uploading.current = true;
    setBusy(true);
    try {
      await run(async () => {
        validateFileBatch(selected);
        for (const file of selected) await api.act('file.add', await fileToPayload(file));
      });
    } finally {
      uploading.current = false;
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }
  const drop = useFileDrop(
    upload,
    (message) =>
      void run(async () => {
        throw Error(message);
      }),
    !busy,
  );
  return (
    <section className="file-drop-target" {...drop.dropProps}>
      {drop.dragging && (
        <FileDrop
          title={busy ? 'Adding your files…' : 'Drop files to save'}
          hint="Keep them in Relay, ready for your next conversation."
        />
      )}
      <PageHeading
        title="A home for your work"
        description="Notes, documents, and the things your assistant creates."
      >
        {api.mode() === 'server' && (
          <button className="secondary-button" onClick={() => openArtifact('new')}>
            <Plus size={18} />
            New result
          </button>
        )}
        <button className="secondary-button" onClick={() => setCreate(true)}>
          <Plus size={18} />
          New note
        </button>
        <button className="primary-button" disabled={busy} onClick={() => input.current?.click()}>
          <UploadSimple size={18} />
          {busy ? 'Uploading…' : 'Upload file'}
        </button>
        <input
          type="file"
          multiple
          hidden
          ref={input}
          onChange={(e) => void upload(e.target.files)}
        />
      </PageHeading>
      <div className="surface-toolbar">
        <label className="search-input">
          <MagnifyingGlass size={18} />
          <input
            aria-label="Search files"
            placeholder="Find a file…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <span className="muted">
          {files.length} file{files.length === 1 ? '' : 's'}
        </span>
      </div>
      {files.length ? (
        <div className="file-grid">
          {files.map((f) => (
            <button className="file-tile" key={f.id} onClick={() => openFile(f.id)}>
              <span className={`file-kind ${f.mime === 'application/pdf' ? 'pdf' : ''}`}>
                {f.mime === 'application/pdf' ? (
                  <FilePdf size={32} />
                ) : f.mime === 'text/csv' ? (
                  <FileCsv size={32} />
                ) : (
                  <FileText size={32} />
                )}
              </span>
              <strong>{f.name}</strong>
              <span>
                {f.artifactId
                  ? `${artifactKinds[s.artifacts?.find((a) => a.id === f.artifactId)?.kind as keyof typeof artifactKinds]?.label || 'Result'} · Version ${f.artifactVersion}`
                  : f.source}
              </span>
              <small>
                {f.size ? `${(f.size / 1024).toFixed(1)} KB` : 'Sample document'} ·{' '}
                {dateTime(f.createdAt)}
              </small>
            </button>
          ))}
        </div>
      ) : (
        <Empty
          icon={Folder}
          title={query ? 'No matching files' : 'Make a little room for your work'}
        >
          Upload a document, start a note, or delegate a task that creates a result.
        </Empty>
      )}
      {create && (
        <Modal title="Start a note" onClose={() => setCreate(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const f = await act('file.add', { name, mime: 'text/markdown', text, base64: '' });
              if (f) {
                setCreate(false);
                setText('');
                openFile(f.id);
              }
            }}
          >
            <Field label="File name">
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={180}
              />
            </Field>
            <Field label="Your note">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={9}
                placeholder="A thought, a plan, a place to begin…"
              />
            </Field>
            <button className="primary-button" type="submit">
              Save note
            </button>
          </form>
        </Modal>
      )}
    </section>
  );
}
