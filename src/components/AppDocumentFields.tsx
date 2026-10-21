import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Field } from './ui';

type Options = { values: string[]; hasMore: boolean };
export default function AppDocumentFields({
  names,
  values,
  onChange,
  identity,
  canSuggest,
  appName,
  busy,
  endpoint = '/connectors/documents/suggest',
  details,
}: {
  names: string[];
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
  identity: {
    connectionId: string;
    revision: number;
    threadId: string;
    toolName: string;
    fingerprint: string;
  };
  canSuggest: boolean;
  appName: string;
  busy: boolean;
  endpoint?: string;
  details?: Record<string, { description?: string; maxLength?: number; required?: boolean }>;
}) {
  const pending = useRef<AbortController | null>(null);
  const cache = useRef(new Map<string, { at: number; result: Options }>());
  const [options, setOptions] = useState<{
    field: string;
    loading?: boolean;
    error?: string;
    result?: Options;
    limit: number;
  } | null>(null);
  function clear() {
    pending.current?.abort();
    pending.current = null;
    setOptions(null);
  }
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (busy) clear();
  }, [busy]);
  async function lookup(field: string) {
    clear();
    const input = { ...identity, field, arguments: values };
    const key = JSON.stringify(input),
      saved = cache.current.get(key);
    if (saved && Date.now() - saved.at < 30000) {
      setOptions({ field, result: saved.result, limit: 8 });
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setOptions({ field, loading: true, limit: 8 });
    try {
      const result: Options = await api.request(endpoint, {
        method: 'POST',
        body: JSON.stringify(input),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
      });
      if (pending.current !== controller || controller.signal.aborted) return;
      if (cache.current.size >= 8) cache.current.delete(cache.current.keys().next().value!);
      cache.current.set(key, { at: Date.now(), result });
      setOptions({ field, result, limit: 8 });
    } catch (error) {
      if (pending.current === controller && !controller.signal.aborted)
        setOptions({ field, error: (error as Error).message, limit: 8 });
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }
  return (
    <>
      {canSuggest && <p className="form-note">Find options shares these fields with {appName}.</p>}
      {names.map((name) => (
        <div className="prompt-review-field" key={name}>
          <Field
            label={details && !details[name]?.required ? `${name} (optional)` : name}
            hint={details?.[name]?.description}
            action={
              canSuggest && (
                <div className="prompt-options-actions">
                  <button
                    type="button"
                    className="text-button"
                    aria-label={`Find options for ${name}`}
                    disabled={options?.field === name && options.loading}
                    onClick={() => void lookup(name)}
                  >
                    {options?.field === name && options.loading
                      ? 'Looking up options…'
                      : 'Find options'}
                  </button>
                  {options?.field === name && (
                    <button type="button" className="text-button" onClick={clear}>
                      {options.loading ? 'Cancel lookup' : 'Hide options'}
                    </button>
                  )}
                </div>
              )
            }
          >
            {details ? (
              <textarea
                rows={2}
                value={values[name] || ''}
                maxLength={details[name]?.maxLength || 12000}
                autoComplete="off"
                onChange={(event) => {
                  clear();
                  onChange(name, event.target.value);
                }}
              />
            ) : (
              <input
                value={values[name] || ''}
                maxLength={2000}
                autoComplete="off"
                onChange={(event) => {
                  clear();
                  onChange(name, event.target.value);
                }}
              />
            )}
          </Field>
          {options?.field === name && (
            <div className="prompt-options" aria-live="polite">
              {options.error && (
                <p role="alert" className="inline-error">
                  {options.error}
                </p>
              )}
              {options.result && (
                <>
                  <div role="group" aria-label={`Options for ${name}`}>
                    {options.result.values.slice(0, options.limit).map((value) => (
                      <button
                        key={value}
                        type="button"
                        className="secondary-button"
                        title={value || 'Empty value'}
                        onClick={() => {
                          clear();
                          onChange(name, value);
                        }}
                      >
                        <span>{value || 'Empty value'}</span>
                      </button>
                    ))}
                  </div>
                  {!options.result.values.length && (
                    <p className="form-note">No options found. You can enter your own value.</p>
                  )}
                  {options.result.values.length > options.limit && (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() =>
                        setOptions((current) =>
                          current ? { ...current, limit: current.limit + 8 } : null,
                        )
                      }
                    >
                      Show more options
                    </button>
                  )}
                  {options.result.hasMore && (
                    <p className="form-note">
                      There are more matches. Add detail and choose Find options again.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </>
  );
}
