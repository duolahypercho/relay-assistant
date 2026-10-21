import { useEffect, useId, useRef, useState } from 'react';
import { ArrowUp, CheckCircle } from '@phosphor-icons/react';
import { api } from '../api';
import { useWorkspace } from '../context';
import './question-card.css';

function savedAnswer(key: string) {
  try {
    return (localStorage.getItem(key) || '').slice(0, 4000);
  } catch {
    return '';
  }
}

export default function QuestionCard({ id }: { id: string }) {
  const { s } = useWorkspace();
  const q = s.questions?.find((q) => q.id === id);
  const label = useId();
  // Save each keystroke locally: page navigation and native termination must
  // not discard an unfinished answer. It is sent only with Send answer.
  const key = `relay-question-answer:${id}:${q?.createdAt || ''}`;
  const [draft, setDraft] = useState(() => ({ key, text: savedAnswer(key) }));
  const answer = draft.key === key ? draft.text : savedAnswer(key);
  const restored = useRef({ key, pending: answer.length > 0 });
  if (restored.current.key !== key) restored.current = { key, pending: answer.length > 0 };
  function setAnswer(value: string) {
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch {
      /* The current editor still works when device storage is unavailable. */
    }
    setDraft({ key, text: value });
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const acted = useRef(false);
  const receipt = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (q?.status && q.status !== 'pending') {
      try {
        localStorage.removeItem(key);
      } catch {
        /* Storage may be unavailable. */
      }
      setDraft({ key, text: '' });
      if (acted.current) receipt.current?.focus();
    }
  }, [key, q?.status]);
  if (!q) return null;
  const archived = s.threads.find((t) => t.id === q.threadId)?.archived;
  async function submit(action: string, payload = {}) {
    if (lock.current) return;
    lock.current = true;
    acted.current = true;
    setBusy(true);
    setError('');
    try {
      await api.act(action, { id, ...payload });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="question-card" role="group" aria-labelledby={label} aria-busy={busy}>
      <strong id={label}>{q.prompt}</strong>
      {q.status === 'pending' ? (
        <>
          {q.options.length > 0 && (
            <div className="question-choices">
              {q.options.map((o: any) => (
                <button
                  key={o.id}
                  disabled={busy || archived}
                  onClick={() => void submit('question.answer', { optionId: o.id })}
                >
                  <span>{o.label}</span>
                  {o.description && <small>{o.description}</small>}
                </button>
              ))}
            </div>
          )}
          <form
            className="question-answer"
            onSubmit={(e) => {
              e.preventDefault();
              if (answer.trim()) void submit('question.answer', { text: answer });
            }}
          >
            <input
              aria-label="Your own answer"
              placeholder={q.options.length ? 'Or tell me in your own words…' : 'Your answer…'}
              value={answer}
              onFocus={(e) => {
                if (!restored.current.pending) return;
                restored.current.pending = false;
                const input = e.currentTarget;
                // WebKit can restore the value with the caret at zero. Resume
                // at the end once; subsequent taps keep normal text selection.
                requestAnimationFrame(() => {
                  if (document.activeElement === input)
                    input.setSelectionRange(input.value.length, input.value.length);
                });
              }}
              onChange={(e) => setAnswer(e.target.value)}
              maxLength={4000}
              disabled={busy || archived}
            />
            <button
              type="submit"
              aria-label="Send answer"
              disabled={busy || archived || !answer.trim()}
            >
              <ArrowUp size={18} />
            </button>
          </form>
          <div className="question-foot">
            <small>
              {archived
                ? 'Restore this chat to answer.'
                : busy
                  ? 'Saving your answer…'
                  : 'Your answer continues this request.'}
            </small>
            <button disabled={busy} onClick={() => void submit('question.dismiss')}>
              Dismiss
            </button>
          </div>
        </>
      ) : (
        <div className="question-receipt" ref={receipt} tabIndex={-1}>
          <CheckCircle size={18} />
          <span>
            {q.status === 'answered' ? `Answered · ${q.answer}` : 'Dismissed · no answer sent'}
          </span>
        </div>
      )}
      {error && (
        <p className="question-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
