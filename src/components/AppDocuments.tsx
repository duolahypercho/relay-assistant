import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, FileText, MagnifyingGlass } from '@phosphor-icons/react';
import { api } from '../api';
import { useWorkspace } from '../context';
import { FilePreview } from '../views/Files';
import AppDocumentFields from './AppDocumentFields';

type Entry = {
  name: string;
  title: string;
  description: string;
  fingerprint: string;
  canSuggest: boolean;
  inputSchema: { properties: Record<string, unknown> };
};
type Connection = { id: string; revision: number; name: string };

export default function AppDocuments({
  connection,
  onClose,
}: {
  connection: Connection;
  onClose: () => void;
}) {
  const { s, threadId } = useWorkspace();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Entry | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<string[]>([]);
  const [fileId, setFileId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const request = useRef<AbortController | null>(null);
  const operation = useRef('');
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [selected?.name, fileId]);
  const identity = { connectionId: connection.id, revision: connection.revision, threadId };
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    setEntries(null);
    void api
      .request('/connectors/documents/list', {
        method: 'POST',
        body: JSON.stringify(identity),
        signal: controller.signal,
      })
      .then((data) => {
        if (!controller.signal.aborted) setEntries(data.entries);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => {
      controller.abort();
      cancel();
    };
  }, [connection.id, connection.revision, threadId, reload]);
  function cancel() {
    if (request.current)
      void api
        .request('/connectors/documents/cancel', {
          method: 'POST',
          body: JSON.stringify({ connectionId: connection.id, operationId: operation.current }),
        })
        .catch(() => {});
    request.current?.abort();
    request.current = null;
    setBusy(false);
    operation.current = crypto.randomUUID();
  }
  function back() {
    cancel();
    setError('');
    if (selected) {
      setSelected(null);
      setFiles([]);
      setFileId('');
    } else onClose();
  }
  async function read(entry: Entry, values: Record<string, string>) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const result = await api.request('/connectors/documents/read', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          ...identity,
          toolName: entry.name,
          fingerprint: entry.fingerprint,
          arguments: values,
          operationId: operation.current,
        }),
      });
      if (controller.signal.aborted) return;
      if (result.isError) throw Error('The app could not open this document. Try again.');
      if (!result.fileIds.length) throw Error('This document did not contain any files or text.');
      await api.refresh();
      if (controller.signal.aborted) return;
      setFiles(result.fileIds);
      setFileId(result.fileIds[0]);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'The document could not open.');
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  const currentFile = s.files.find((file) => file.id === fileId);
  return (
    <section className="app-documents" aria-label={`${connection.name} documents`}>
      <button className="text-button" onClick={back}>
        <ArrowLeft size={18} /> {selected ? 'All documents' : 'Your apps'}
      </button>
      <h1 ref={heading} tabIndex={-1}>
        {currentFile?.name || selected?.title || `${connection.name} documents`}
      </h1>
      {!selected && (
        <>
          <p className="apps-intro">Choose a document to open. A copy stays in Files.</p>
          {!!entries?.length && (
            <label className="app-document-search">
              <MagnifyingGlass size={18} aria-hidden="true" />
              <input
                aria-label="Find a document"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find a document"
              />
            </label>
          )}
          <div className="app-document-list">
            {entries
              ?.filter((entry) =>
                `${entry.title} ${entry.description}`
                  .toLocaleLowerCase()
                  .includes(query.toLocaleLowerCase()),
              )
              .map((entry) => (
                <button
                  className="app-document-row"
                  key={entry.name}
                  onClick={() => {
                    setSelected(entry);
                    setFields({});
                    setError('');
                    operation.current = crypto.randomUUID();
                    if (!Object.keys(entry.inputSchema.properties).length) void read(entry, {});
                  }}
                >
                  <FileText size={22} aria-hidden="true" />
                  <span>
                    <strong>{entry.title}</strong>
                    <small>{entry.description}</small>
                  </span>
                  <ArrowRight size={18} aria-hidden="true" />
                </button>
              ))}
          </div>
          {entries && !entries.length && (
            <p>No documents are available to this chat. Check this app’s permissions in Manage.</p>
          )}
          {entries &&
            !!entries.length &&
            !entries.some((entry) =>
              `${entry.title} ${entry.description}`
                .toLocaleLowerCase()
                .includes(query.toLocaleLowerCase()),
            ) && <p role="status">No matching documents.</p>}
          {!entries && !error && <p role="status">Finding documents…</p>}
        </>
      )}
      {selected && !fileId && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void read(selected, fields);
          }}
        >
          <p className="apps-intro">{selected.description}</p>
          <fieldset className="app-fields" disabled={busy}>
            <AppDocumentFields
              key={`${selected.name}:${selected.fingerprint}`}
              names={Object.keys(selected.inputSchema.properties)}
              values={fields}
              identity={{ ...identity, toolName: selected.name, fingerprint: selected.fingerprint }}
              canSuggest={selected.canSuggest}
              appName={connection.name}
              busy={busy}
              onChange={(name, value) => {
                operation.current = crypto.randomUUID();
                setFields((fields) => ({ ...fields, [name]: value }));
              }}
            />
            <button className="primary-button" type="submit">
              {busy ? 'Opening…' : 'Open document'}
            </button>
          </fieldset>
          {busy && (
            <button type="button" className="text-button" onClick={cancel}>
              Cancel opening
            </button>
          )}
        </form>
      )}
      {fileId && (
        <>
          {files.length > 1 && (
            <label className="app-document-part">
              Document part
              <select value={fileId} onChange={(e) => setFileId(e.target.value)}>
                {files.map((id) => (
                  <option key={id} value={id}>
                    {s.files.find((f) => f.id === id)?.name || 'Removed file'}
                  </option>
                ))}
              </select>
            </label>
          )}
          <FilePreview
            id={fileId}
            onClose={() => {
              setFileId('');
              setFiles([]);
            }}
          />
        </>
      )}
      {error && (
        <div role="alert" className="inline-error">
          <p>{error}</p>
          {!entries && (
            <button className="secondary-button" onClick={() => setReload((value) => value + 1)}>
              Try again
            </button>
          )}
        </div>
      )}
    </section>
  );
}
