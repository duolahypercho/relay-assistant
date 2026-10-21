import { useEffect, useRef, useState } from 'react';
import { X, Paperclip } from '@phosphor-icons/react';
import { hasNativeShares, mobileShares, type IncomingShare } from '../native-mobile';
import { useWorkspace } from '../context';
import { api } from '../api';
import './mobile-shares.css';
export default function MobileShares() {
  const { s, selectThread, toast } = useWorkspace();
  const [pending, setPending] = useState<IncomingShare | null>(null),
    [chosen, setChosen] = useState('main'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const lock = useRef(false),
    blocked = useRef('');
  const chats = s.threads
    .filter((t) => !t.archived && !t.replyTo)
    .sort((a, b) => (a.id === 'main' ? -1 : b.id === 'main' ? 1 : 0))
    .slice(0, 200)
    .map((t) => ({ id: t.id, title: t.title }));
  // The original Main creation separates databases/sample resets at the same origin.
  const scope = JSON.stringify([
    location.origin,
    s.threads.find((t) => t.id === 'main')?.createdAt,
  ]);
  const serialized = JSON.stringify({
    scope,
    label: api.mode() === 'server' ? location.host : 'On this device',
    chats,
  });
  const latest = useRef({ scope, chats, selectThread, toast });
  latest.current = { scope, chats, selectThread, toast };
  async function attach(item: IncomingShare, threadId: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      if (item.scope !== latest.current.scope)
        throw new Error('Reconnect to the workspace this item was shared to.');
      const result = await api.act('share.attach', {
        id: item.id,
        threadId,
        text: item.text,
        files: item.files,
      });
      if (item.scope !== latest.current.scope) return;
      await mobileShares.acknowledge({ scope: item.scope, id: item.id });
      if (item.scope !== latest.current.scope) return;
      setPending(null);
      blocked.current = '';
      latest.current.selectThread(result.threadId);
      latest.current.toast('Added to your composer. Ready when you are.');
    } catch (e) {
      if (item.scope !== latest.current.scope) return;
      setChosen(threadId);
      blocked.current = item.id;
      setPending(item);
      setError(e instanceof Error ? e.message : 'Could not attach this share. Try again.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    setPending(null);
    setError('');
    blocked.current = '';
  }, [scope]);
  useEffect(() => {
    if (!hasNativeShares()) return;
    let alive = true,
      checking = false;
    async function check() {
      if (checking || lock.current || document.visibilityState === 'hidden') return;
      checking = true;
      try {
        await mobileShares.sync(JSON.parse(serialized));
        const result = await mobileShares.peek({ scope });
        const item = result?.item;
        if (!alive || !item || item.scope !== scope) return;
        const already = api.snapshot().shareImports?.find((x) => x.id === item.id);
        if (already && blocked.current !== item.id) await attach(item, already.threadId);
        else if (
          item.threadId &&
          latest.current.chats.some((c) => c.id === item.threadId) &&
          blocked.current !== item.id
        )
          await attach(item, item.threadId);
        else {
          setPending((old) => (old?.id === item.id ? old : item));
          setChosen((old) => (latest.current.chats.some((c) => c.id === old) ? old : 'main'));
        }
      } catch (e) {
        if (alive)
          setError(e instanceof Error ? e.message : 'Sharing is unavailable on this device.');
      } finally {
        checking = false;
      }
    }
    void check();
    const interval = setInterval(() => void check(), 2500);
    const wake = () => void check();
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      alive = false;
      clearInterval(interval);
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [serialized, scope]);
  if (!pending)
    return error ? (
      <div className="incoming-share" role="status">
        {error}
        <button
          className="icon-button"
          aria-label="Dismiss sharing notice"
          onClick={() => setError('')}
        >
          <X size={18} />
        </button>
      </div>
    ) : null;
  return (
    <section className="incoming-share" aria-label="Incoming share">
      <div className="incoming-share-title">
        <strong>
          <Paperclip size={18} /> Shared to Relay
        </strong>
        <button
          className="icon-button"
          aria-label="Discard incoming share"
          disabled={busy}
          onClick={() => {
            if (lock.current) return;
            lock.current = true;
            setBusy(true);
            void mobileShares
              .acknowledge({ scope: pending.scope, id: pending.id })
              .then(() => {
                setPending(null);
                setError('');
                blocked.current = '';
              })
              .catch(() => setError('Could not discard this item. Try again.'))
              .finally(() => {
                lock.current = false;
                setBusy(false);
              });
          }}
        >
          <X size={18} />
        </button>
      </div>
      {pending.text && <p>{pending.text}</p>}
      {pending.files.map((f, i) => (
        <p key={i}>{f.name}</p>
      ))}
      <label>
        Attach to{' '}
        <select
          aria-label="Share destination"
          value={chosen}
          disabled={busy}
          onChange={(e) => setChosen(e.target.value)}
        >
          {chats.map((c) => (
            <option value={c.id} key={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      </label>
      <div className="incoming-share-footer">
        <small>Your draft stays. You send when ready.</small>
        <button
          className="primary-button"
          disabled={busy}
          onClick={() => void attach(pending, chosen)}
        >
          {busy ? 'Attaching…' : 'Attach'}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
