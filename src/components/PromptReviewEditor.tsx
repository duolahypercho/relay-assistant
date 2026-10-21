import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Field } from './ui';

type Editor = {
  reviewToken: string;
  canSuggest: boolean;
  arguments: Record<string, string>;
  fields: { name: string; description: string; required: boolean; maxLength: number }[];
};
type Suggestions = { values: string[]; hasMore: boolean; total?: number };
export default function PromptReviewEditor({ approval }: { approval: any }) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const pending = useRef(false);
  function revealFocusedField() {
    requestAnimationFrame(() => {
      const input = document.activeElement;
      const messages = root.current?.closest('.messages');
      if (!(input instanceof HTMLTextAreaElement) || !root.current?.contains(input) || !messages)
        return;
      const viewport = messages.getBoundingClientRect();
      const field = input.closest('.prompt-review-field')!;
      const control = input.getBoundingClientRect();
      const heading = field.getBoundingClientRect();
      // Prefer the label and its action together with the control. For a tall
      // field, keep the editable control visible without moving other pages.
      const top = control.bottom - heading.top <= viewport.height - 8 ? heading.top : control.top;
      if (control.bottom > viewport.bottom - 4)
        messages.scrollTop += control.bottom - viewport.bottom + 4;
      else if (top < viewport.top + 4) messages.scrollTop += top - viewport.top - 4;
    });
  }
  useEffect(() => {
    window.addEventListener('resize', revealFocusedField);
    window.visualViewport?.addEventListener('resize', revealFocusedField);
    return () => {
      window.removeEventListener('resize', revealFocusedField);
      window.visualViewport?.removeEventListener('resize', revealFocusedField);
    };
  }, []);
  const lookup = useRef<AbortController | null>(null);
  const suggestionCache = useRef(new Map<string, { at: number; result: Suggestions }>());
  const [suggestion, setSuggestion] = useState<{
    field: string;
    loading?: boolean;
    result?: Suggestions;
    error?: string;
    limit: number;
  } | null>(null);
  useEffect(() => () => lookup.current?.abort(), []);
  function clearSuggestions() {
    lookup.current?.abort();
    lookup.current = null;
    setSuggestion(null);
  }
  const draftKey = `relay-prompt-review:${approval.id}`;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void api
      .request(`/connectors/prompts/${encodeURIComponent(approval.id)}`, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      })
      .then((data: Editor) => {
        if (controller.signal.aborted) return;
        let saved;
        try {
          saved = JSON.parse(localStorage.getItem(draftKey) || 'null');
        } catch {}
        const draft = saved?.reviewToken === data.reviewToken ? saved.values : null;
        setValues(
          Object.fromEntries(
            data.fields.map((field) => [
              field.name,
              typeof draft?.[field.name] === 'string' && draft[field.name].length <= field.maxLength
                ? draft[field.name]
                : data.arguments[field.name] || '',
            ]),
          ),
        );
        setEditor(data);
      })
      .catch((failure: Error) => {
        if (!controller.signal.aborted) setError(failure.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [approval.id, draftKey, attempt]);
  useEffect(() => {
    if (!editor) return;
    try {
      localStorage.setItem(draftKey, JSON.stringify({ reviewToken: editor.reviewToken, values }));
    } catch {}
  }, [editor, values, draftKey]);
  const args = Object.fromEntries(
    (editor?.fields || [])
      .filter(
        (field) =>
          field.required ||
          values[field.name] !== '' ||
          Object.hasOwn(editor!.arguments, field.name),
      )
      .map((field) => [field.name, values[field.name] || '']),
  );
  async function findOptions(field: string) {
    if (!editor || pending.current) return;
    clearSuggestions();
    const input = { id: approval.id, reviewToken: editor.reviewToken, field, arguments: args };
    const cacheKey = JSON.stringify(input);
    const cached = suggestionCache.current.get(cacheKey);
    if (cached && Date.now() - cached.at < 30000) {
      setSuggestion({ field, result: cached.result, limit: 8 });
      return;
    }
    const controller = new AbortController();
    lookup.current = controller;
    setSuggestion({ field, loading: true, limit: 8 });
    try {
      const result: Suggestions = await api.request('/connectors/prompts/suggest', {
        method: 'POST',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
        body: JSON.stringify(input),
      });
      if (lookup.current !== controller || controller.signal.aborted) return;
      if (suggestionCache.current.size >= 8)
        suggestionCache.current.delete(suggestionCache.current.keys().next().value!);
      suggestionCache.current.set(cacheKey, { at: Date.now(), result });
      setSuggestion({ field, result, limit: 8 });
    } catch (failure) {
      if (lookup.current === controller && !controller.signal.aborted)
        setSuggestion({ field, error: (failure as Error).message, limit: 8 });
    } finally {
      if (lookup.current === controller) lookup.current = null;
    }
  }
  async function decide(use: boolean) {
    if (pending.current || (use && !editor)) return;
    pending.current = true;
    clearSuggestions();
    setBusy(true);
    setError('');
    try {
      if (use)
        await api.request('/connectors/prompts/use', {
          method: 'POST',
          signal: AbortSignal.timeout(15000),
          body: JSON.stringify({
            id: approval.id,
            reviewToken: editor!.reviewToken,
            arguments: args,
          }),
        });
      else await api.act('approval.decide', { id: approval.id, decision: 'reject' });
      try {
        localStorage.removeItem(draftKey);
      } catch {}
      await api.refresh();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="prompt-review-editor" ref={root}>
      {loading ? (
        <p className="form-note" role="status">
          Opening template details…
        </p>
      ) : editor ? (
        <>
          <fieldset className="prompt-review-fields" disabled={busy}>
            <legend className="sr-only">Exact app arguments</legend>
            {editor.canSuggest && (
              <p className="form-note">
                Find options shares these fields with {approval.payload.name}.
              </p>
            )}
            {editor.fields.map((field) => (
              <div className="prompt-review-field" key={field.name}>
                <Field
                  label={`${field.name.replace(/[_-]/g, ' ')}${field.required ? '' : ' (optional)'}`}
                  hint={field.description}
                  action={
                    editor.canSuggest && (
                      <div className="prompt-options-actions">
                        <button
                          className="text-button"
                          type="button"
                          aria-label={`Find options for ${field.name.replace(/[_-]/g, ' ')}`}
                          disabled={suggestion?.field === field.name && suggestion.loading}
                          onClick={() => void findOptions(field.name)}
                        >
                          {suggestion?.field === field.name && suggestion.loading
                            ? 'Looking up options…'
                            : 'Find options'}
                        </button>
                        {suggestion?.field === field.name && (
                          <button className="text-button" type="button" onClick={clearSuggestions}>
                            {suggestion.loading ? 'Cancel lookup' : 'Hide options'}
                          </button>
                        )}
                      </div>
                    )
                  }
                >
                  <textarea
                    rows={2}
                    onFocus={revealFocusedField}
                    maxLength={field.maxLength}
                    value={values[field.name] || ''}
                    onChange={(event) => {
                      clearSuggestions();
                      setValues((previous) => ({ ...previous, [field.name]: event.target.value }));
                    }}
                  />
                </Field>
                {suggestion?.field === field.name && (
                  <div className="prompt-options" aria-live="polite">
                    {suggestion.error && (
                      <p className="inline-error" role="alert">
                        {suggestion.error}
                      </p>
                    )}
                    {suggestion.result && (
                      <>
                        <div
                          role="group"
                          aria-label={`Options for ${field.name.replace(/[_-]/g, ' ')}`}
                        >
                          {suggestion.result.values.slice(0, suggestion.limit).map((value) => (
                            <button
                              key={value}
                              type="button"
                              className="secondary-button"
                              title={value || 'Empty value'}
                              onClick={() => {
                                clearSuggestions();
                                setValues((previous) => ({ ...previous, [field.name]: value }));
                              }}
                            >
                              <span>{value || 'Empty value'}</span>
                            </button>
                          ))}
                        </div>
                        {suggestion.result.values.length === 0 && (
                          <p className="form-note">
                            No options found. You can enter your own value.
                          </p>
                        )}
                        {suggestion.result.values.length > suggestion.limit && (
                          <button
                            className="text-button"
                            type="button"
                            onClick={() =>
                              setSuggestion((current) =>
                                current ? { ...current, limit: current.limit + 8 } : null,
                              )
                            }
                          >
                            Show more options
                          </button>
                        )}
                        {suggestion.result.hasMore && (
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
            {editor.fields.length === 0 && <p>No extra information will be sent.</p>}
          </fieldset>
          <details className="connector-action-details">
            <summary>Action details</summary>
            <dl className="review-fields">
              <dt>Address</dt>
              <dd style={{ overflowWrap: 'anywhere' }}>{approval.payload.endpoint}</dd>
              <dt>Tool</dt>
              <dd>
                <code>{approval.payload.toolName}</code>
              </dd>
            </dl>
            <pre className="connector-arguments" aria-label="Raw app arguments">
              {JSON.stringify(args, null, 2)}
            </pre>
          </details>
          <p className="review-note">
            Change any details, then use this template. Actions it proposes still follow your app
            permissions.
          </p>
        </>
      ) : null}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="review-actions">
        <button className="secondary-button" disabled={busy} onClick={() => void decide(false)}>
          Decline
        </button>
        {!editor && !loading ? (
          <button className="primary-button" onClick={() => setAttempt((value) => value + 1)}>
            Try again
          </button>
        ) : (
          <button
            className="primary-button"
            disabled={busy || loading || !editor}
            onClick={() => void decide(true)}
          >
            {busy ? 'Working…' : 'Use template'}
          </button>
        )}
      </div>
    </div>
  );
}
