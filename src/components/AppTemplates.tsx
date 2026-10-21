import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, MagicWand, MagnifyingGlass } from '@phosphor-icons/react';
import { api } from '../api';
import { useWorkspace } from '../context';
import AppDocumentFields from './AppDocumentFields';
type Entry = {
  name: string;
  title: string;
  description: string;
  fingerprint: string;
  canSuggest: boolean;
  inputSchema: {
    properties: Record<string, { description?: string; maxLength: number }>;
    required?: string[];
  };
};
type Connection = { id: string; revision: number; name: string };
export default function AppTemplates({
  connection,
  onClose,
}: {
  connection: Connection;
  onClose: () => void;
}) {
  const { s, threadId, go } = useWorkspace();
  const [entries, setEntries] = useState<Entry[] | null>(null),
    [selected, setSelected] = useState<Entry | null>(null);
  const [query, setQuery] = useState(''),
    [assistant, setAssistant] = useState('Relay');
  const [values, setValues] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(''),
    [reload, setReload] = useState(0);
  const request = useRef<AbortController | null>(null),
    operation = useRef(''),
    heading = useRef<HTMLHeadingElement>(null);
  const identity = { connectionId: connection.id, revision: connection.revision, threadId };
  const thread = s.threads.find((t) => t.id === threadId)!;
  const keyFor = (entry: Entry) =>
    `relay-template-choice:${thread.id}:${thread.createdAt}:${connection.id}:${connection.revision}:${entry.fingerprint}`;
  function save(entry: Entry, fields: Record<string, string>) {
    try {
      localStorage.setItem(
        keyFor(entry),
        JSON.stringify({ values: fields, operationId: operation.current }),
      );
    } catch {}
  }
  function choose(entry: Entry) {
    let saved: any;
    try {
      saved = JSON.parse(localStorage.getItem(keyFor(entry)) || 'null');
    } catch {}
    const fields = Object.fromEntries(
      Object.entries(entry.inputSchema.properties)
        .filter(
          ([name]) =>
            typeof saved?.values?.[name] === 'string' &&
            saved.values[name].length <= entry.inputSchema.properties[name].maxLength,
        )
        .map(([name]) => [name, saved.values[name]]),
    );
    operation.current = /^[a-f0-9-]{36}$/.test(saved?.operationId)
      ? saved.operationId
      : crypto.randomUUID();
    setValues(fields);
    setSelected(entry);
    setError('');
    save(entry, fields);
  }
  function cancel() {
    if (request.current)
      void api
        .request('/connectors/templates/cancel', {
          method: 'POST',
          body: JSON.stringify({ connectionId: connection.id, operationId: operation.current }),
        })
        .catch(() => {});
    request.current?.abort();
    request.current = null;
    setBusy(false);
  }
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    setEntries(null);
    void api
      .request('/connectors/templates/list', {
        method: 'POST',
        body: JSON.stringify(identity),
        signal: controller.signal,
      })
      .then((result) => {
        if (!controller.signal.aborted) {
          setEntries(result.entries);
          setAssistant(result.assistantName);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => {
      controller.abort();
      cancel();
    };
  }, [connection.id, connection.revision, threadId, reload]);
  useEffect(() => {
    heading.current?.focus();
  }, [selected?.name]);
  async function useTemplate() {
    if (!selected || request.current) return;
    const controller = new AbortController(),
      chosenOperation = operation.current;
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      await api.request('/connectors/templates/use', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          ...identity,
          toolName: selected.name,
          fingerprint: selected.fingerprint,
          arguments: values,
          operationId: chosenOperation,
        }),
      });
      if (controller.signal.aborted) return;
      try {
        if (
          JSON.parse(localStorage.getItem(keyFor(selected)) || 'null')?.operationId ===
          chosenOperation
        )
          localStorage.removeItem(keyFor(selected));
      } catch {}
      await api.refresh();
      if (!controller.signal.aborted) go('chat');
    } catch (error) {
      if (!controller.signal.aborted) setError((error as Error).message);
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <section className="app-documents" aria-label={`${connection.name} templates`}>
      <button
        className="text-button"
        onClick={() => {
          cancel();
          setError('');
          if (selected) setSelected(null);
          else onClose();
        }}
      >
        <ArrowLeft size={18} /> {selected ? 'All templates' : 'Your apps'}
      </button>
      <h1 ref={heading} tabIndex={-1}>
        {selected?.title || `${connection.name} templates`}
      </h1>
      {!selected ? (
        <>
          <p className="apps-intro">Choose a starting point for {assistant}.</p>
          <label className="app-document-search">
            <MagnifyingGlass size={18} />
            <span className="sr-only">Find a template</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find a template"
            />
          </label>
          <div className="app-document-list">
            {entries
              ?.filter((entry) =>
                `${entry.title} ${entry.description}`
                  .toLocaleLowerCase()
                  .includes(query.toLocaleLowerCase()),
              )
              .map((entry) => (
                <button className="app-document-row" key={entry.name} onClick={() => choose(entry)}>
                  <MagicWand size={22} />
                  <span>
                    <strong>{entry.title}</strong>
                    <small>{entry.description}</small>
                  </span>
                  <ArrowRight size={18} />
                </button>
              ))}
          </div>
          {!entries && !error && <p role="status">Finding templates…</p>}
          {entries && !entries.length && (
            <p>No templates are available to this chat. Check this app’s permissions in Manage.</p>
          )}
          {!!entries?.length &&
            !entries.some((entry) =>
              `${entry.title} ${entry.description}`
                .toLocaleLowerCase()
                .includes(query.toLocaleLowerCase()),
            ) && <p role="status">No matching templates.</p>}
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void useTemplate();
          }}
        >
          <p className="apps-intro">{selected.description}</p>
          <fieldset className="app-fields" disabled={busy}>
            <AppDocumentFields
              key={`${selected.name}:${selected.fingerprint}`}
              names={Object.keys(selected.inputSchema.properties)}
              values={values}
              identity={{ ...identity, toolName: selected.name, fingerprint: selected.fingerprint }}
              canSuggest={selected.canSuggest}
              appName={connection.name}
              busy={busy}
              endpoint="/connectors/templates/suggest"
              details={Object.fromEntries(
                Object.entries(selected.inputSchema.properties).map(([name, field]) => [
                  name,
                  { ...field, required: selected.inputSchema.required?.includes(name) },
                ]),
              )}
              onChange={(name, value) => {
                operation.current = crypto.randomUUID();
                const fields = { ...values, [name]: value };
                setValues(fields);
                save(selected, fields);
              }}
            />
            <p className="form-note">
              Sends one request to {assistant} in this chat. Your unfinished message stays as it is.
            </p>
            {s.connections.model.configured ? (
              <button className="primary-button" type="submit">
                {busy ? 'Opening template…' : 'Use in chat'}
              </button>
            ) : (
              <button
                className="primary-button"
                type="button"
                onClick={() => go('settings', 'models')}
              >
                Connect AI
              </button>
            )}
          </fieldset>
          {busy && (
            <button className="text-button" type="button" onClick={cancel}>
              Cancel opening
            </button>
          )}
        </form>
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
