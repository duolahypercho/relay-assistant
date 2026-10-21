import { useEffect, useRef, type ReactNode } from 'react';
import { ArrowBendUpLeft } from '@phosphor-icons/react';

// A shortcut for the existing inline reply, with no message or navigation of its own.
export default function MessageBubble({
  children,
  canReply,
  onReply,
  onDoubleClick,
}: {
  children: ReactNode;
  canReply: boolean;
  onReply: () => void;
  onDoubleClick: () => void;
}) {
  const bubble = useRef<HTMLDivElement>(null);
  const reply = useRef(onReply);
  reply.current = onReply;
  useEffect(() => {
    const el = bubble.current;
    if (!el || !canReply) return;
    let gesture: { id: number; x: number; y: number; started: number; locked: boolean } | null =
      null;
    let ready = false;
    let suppressClickUntil = 0;
    const reset = () => {
      gesture = null;
      ready = false;
      el.removeAttribute('data-swipe');
      el.style.removeProperty('--reply-drag');
    };
    const selected = () => !!window.getSelection()?.toString();
    const start = (event: TouchEvent) => {
      reset();
      suppressClickUntil = 0;
      // Leave links, quotes, reactions, media and horizontally scrollable content alone.
      if (
        event.touches.length !== 1 ||
        selected() ||
        (event.target instanceof Element &&
          event.target.closest(
            'a, button, input, textarea, select, audio, video, pre, table, [role="button"], [contenteditable="true"]',
          ))
      )
        return;
      const touch = event.touches[0];
      // Reserve the screen edge for the operating system's back gesture.
      if (touch.clientX < 24) return;
      gesture = {
        id: touch.identifier,
        x: touch.clientX,
        y: touch.clientY,
        started: performance.now(),
        locked: false,
      };
    };
    const move = (event: TouchEvent) => {
      if (!gesture) return;
      const touch = Array.from(event.touches).find((t) => t.identifier === gesture?.id);
      if (!touch || event.touches.length !== 1 || selected()) return reset();
      const dx = touch.clientX - gesture.x;
      const dy = Math.abs(touch.clientY - gesture.y);
      if (!gesture.locked) {
        // Vertical scrolling and a held finger win before horizontal intent is clear.
        if (dy > 12 || dx < -12 || performance.now() - gesture.started > 400) return reset();
        if (dx < 12 || dx < dy * 1.5) return;
        gesture.locked = true;
      }
      if (!event.cancelable || dy > 64) return reset();
      event.preventDefault();
      suppressClickUntil = performance.now() + 500;
      ready = dx >= 56;
      el.dataset.swipe = ready ? 'ready' : 'dragging';
      el.style.setProperty('--reply-drag', `${Math.max(0, Math.min(76, dx * 0.8))}px`);
    };
    const end = (event: TouchEvent) => {
      if (!gesture) return;
      const touch = Array.from(event.changedTouches).find((t) => t.identifier === gesture?.id);
      const commit =
        touch &&
        !event.touches.length &&
        gesture.locked &&
        ready &&
        touch.clientX - gesture.x >= 56 &&
        Math.abs(touch.clientY - gesture.y) <= 64 &&
        !selected();
      reset();
      if (commit) {
        event.preventDefault();
        // Keep focus within the native touch event so iOS opens its keyboard.
        reply.current();
      }
    };
    const click = (event: MouseEvent) => {
      if (performance.now() < suppressClickUntil) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    // A local, non-passive move listener lets vertical scrolling, pinch zoom and code
    // scrolling stay native. React's root touch listener is passive in browsers.
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end, { passive: false });
    el.addEventListener('touchcancel', reset);
    el.addEventListener('contextmenu', reset);
    el.addEventListener('click', click, true);
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', reset);
    return () => {
      reset();
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', reset);
      el.removeEventListener('contextmenu', reset);
      el.removeEventListener('click', click, true);
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', reset);
    };
  }, [canReply]);
  return (
    <div ref={bubble} className="message-bubble" onDoubleClick={onDoubleClick}>
      {canReply && (
        <span className="swipe-reply-cue" aria-hidden="true">
          <ArrowBendUpLeft size={19} weight="bold" />
        </span>
      )}
      {children}
    </div>
  );
}
