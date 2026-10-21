import { useEffect, useRef } from 'react';
import { templateSourceUrl } from '../../shared/assistant-template-links.mjs';
import { useWorkspace } from '../context';
import { api } from '../api';
import { templateLinkBridge } from '../template-links';
export default function NativeTemplateLinks() {
  const { go, selectThread } = useWorkspace();
  const seen = useRef(''),
    latest = useRef({ go, selectThread });
  latest.current = { go, selectThread };
  useEffect(() => {
    const bridge = templateLinkBridge();
    if (!bridge || api.mode() !== 'server') return;
    let alive = true,
      checking = false;
    async function check() {
      if (!alive || checking || document.hidden) return;
      checking = true;
      try {
        const { item } = await bridge!.peek();
        if (!alive || !item || !/^[A-Za-z0-9_-]{16,100}$/.test(item.id)) return;
        const url = templateSourceUrl(item.url);
        const receipt = api.snapshot().templateImports?.find((x) => x.id === item.id);
        if (receipt) {
          await bridge!.acknowledge({ id: item.id });
          const assistant = api.snapshot().assistants?.find((a) => a.id === receipt.assistantId);
          if (alive && seen.current !== item.id && assistant)
            latest.current.selectThread(assistant.threadId);
          seen.current = item.id;
          return;
        }
        if (seen.current === item.id) return;
        seen.current = item.id;
        latest.current.go(
          'assistants',
          undefined,
          `#assistants?import=${encodeURIComponent(url)}&native=${encodeURIComponent(item.id)}`,
        );
        window.dispatchEvent(new Event('hashchange'));
      } catch {
        /* Older native shells have no template bridge; their existing import form remains available. */
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
  }, []);
  return null;
}
