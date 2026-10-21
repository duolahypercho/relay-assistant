import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { isNativeMobile, mobileConnection } from '../native-mobile';

const storageKey = 'relay-model-sign-in';
type Flow = { id: string; phase: 'waiting' | 'ready'; openUrl?: string };
export function useModelSignIn(onReady: (id: string) => void) {
  const ready = useRef(onReady);
  ready.current = onReady;
  const pending = useRef(false);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [flow, setFlow] = useState<Flow | null>(() => {
    try {
      const id = sessionStorage.getItem(storageKey);
      return id ? { id, phase: 'waiting' } : null;
    } catch {
      return null;
    }
  });
  function forget() {
    try {
      sessionStorage.removeItem(storageKey);
    } catch {}
    setFlow(null);
    setError('');
  }
  async function cancel() {
    if (pending.current) return false;
    pending.current = true;
    setStarting(true);
    setFlow(null);
    if (flow) {
      try {
        await api.request('/models/oauth/cancel', {
          method: 'POST',
          body: JSON.stringify({ id: flow.id }),
        });
      } catch (e) {
        setFlow(flow);
        setError(e instanceof Error ? e.message : 'Could not cancel sign-in. Try again.');
        pending.current = false;
        setStarting(false);
        return false;
      }
    }
    forget();
    pending.current = false;
    setStarting(false);
    return true;
  }
  useEffect(() => {
    if (!flow || flow.phase !== 'waiting') return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await api.request(`/models/oauth/result?id=${encodeURIComponent(flow!.id)}`);
        if (!alive) return;
        if (result.phase === 'failed') throw Object.assign(Error(result.error), { status: 400 });
        if (result.phase === 'saved') {
          forget();
          return;
        }
        if (result.phase === 'ready') {
          setFlow({ id: flow!.id, phase: 'ready' });
          setError('');
          ready.current(flow!.id);
          return;
        }
        timer = setTimeout(poll, 1200);
      } catch (e) {
        if (!alive) return;
        if ((e as any)?.status >= 400 && (e as any)?.status < 500) {
          forget();
          setError(e instanceof Error ? e.message : 'Sign in again.');
        } else {
          setError('Waiting for your Relay server. Sign-in will resume when it reconnects.');
          timer = setTimeout(poll, 4000);
        }
      }
    }
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [flow?.id, flow?.phase]);
  async function begin() {
    if (pending.current || flow) return;
    pending.current = true;
    setStarting(true);
    setError('');
    const native = (window as any).relayNative;
    const tab = !native && !isNativeMobile ? window.open('about:blank', '_blank') : null;
    if (tab) tab.opener = null;
    try {
      const result = await api.request('/models/oauth/begin', { method: 'POST', body: '{}' });
      try {
        sessionStorage.setItem(storageKey, result.id);
      } catch {}
      setFlow({
        id: result.id,
        phase: 'waiting',
        ...(!native && !isNativeMobile && !tab ? { openUrl: result.openUrl } : {}),
      });
      if (native?.openAppSignIn) await native.openAppSignIn(result.openUrl);
      else if (isNativeMobile) await mobileConnection.openAppSignIn({ url: result.openUrl });
      else if (tab) tab.location.href = result.openUrl;
    } catch (e) {
      tab?.close();
      setError(
        e instanceof Error ? e.message : 'The browser could not open. Cancel and try again.',
      );
    } finally {
      pending.current = false;
      setStarting(false);
    }
  }
  return { flow, starting, error, begin, cancel, forget };
}
