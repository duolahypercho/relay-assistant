import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { DesktopInputQueue, desktopKey } from '../../shared/desktop-input.mjs';

type Point = { x: number; y: number };
export type ComputerDisplayHandle = {
  copy: (cut?: boolean) => void;
  showKeyboard: () => void;
  hideKeyboard: () => void;
};
export default function ComputerDisplay({
  ref,
  frame,
  enabled,
  zoom,
  touchDrag,
  send,
  onPending,
  onError,
  onCopy,
  onKeyboardChange,
}: {
  ref?: Ref<ComputerDisplayHandle>;
  frame: any;
  enabled: boolean;
  zoom: boolean;
  touchDrag: boolean;
  send: (input: any) => Promise<any>;
  onPending: (pending: boolean) => void;
  onError: (message: string) => void;
  onCopy: (load: () => Promise<string>) => void;
  onKeyboardChange: (open: boolean) => void;
}) {
  const latest = useRef({ enabled, send, onPending, onError });
  latest.current = { enabled, send, onPending, onError };
  const [queue] = useState(
    () =>
      new DesktopInputQueue(
        (input: any) =>
          latest.current.enabled ? latest.current.send(input) : Promise.resolve(undefined),
        (pending = false) => latest.current.onPending(pending),
        (message = '') => latest.current.onError(message),
      ),
  );
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const display = useRef<HTMLButtonElement>(null);
  const gesture = useRef<{
    id: number;
    start: Point;
    client: Point;
    moved: boolean;
    touch: boolean;
  } | null>(null);
  const click = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastClick = useRef<{ point: Point; time: number } | null>(null);
  const composing = useRef(false);
  const softKeyboard = useRef(false);
  // A local sentinel lets soft keyboards emit deletion even after the last
  // committed text was sent. It never becomes guest input.
  const sentinel = '\u200b';
  function resetKeyboard() {
    const next = softKeyboard.current ? sentinel : '';
    setValue(next);
    if (keyboard.current) {
      keyboard.current.value = next;
      keyboard.current.setSelectionRange(next.length, next.length);
    }
  }
  function typedValue(text: string) {
    return softKeyboard.current && text.startsWith(sentinel) ? text.slice(1) : text;
  }
  const pointerFocus = useRef(false);
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);
  const [line, setLine] = useState<{ start: Point; end: Point } | null>(null);
  useEffect(() => {
    if (!enabled) {
      queue.clear();
      clearTimeout(click.current);
      gesture.current = null;
      composing.current = false;
      pointerFocus.current = false;
      lastClick.current = null;
      setLine(null);
      setValue('');
      keyboard.current?.blur();
    }
  }, [enabled, queue]);
  useEffect(
    () => () => {
      latest.current.enabled = false;
      latest.current.onPending = () => {};
      latest.current.onError = () => {};
      queue.clear();
      clearTimeout(click.current);
    },
    [queue],
  );
  const point = (
    event:
      | React.PointerEvent<HTMLButtonElement>
      | React.MouseEvent<HTMLButtonElement>
      | React.WheelEvent<HTMLButtonElement>,
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1279, Math.round(((event.clientX - rect.left) * 1280) / rect.width))),
      y: Math.max(0, Math.min(799, Math.round(((event.clientY - rect.top) * 800) / rect.height))),
    };
  };
  function flushClick() {
    clearTimeout(click.current);
    click.current = undefined;
    if (lastClick.current) {
      queue.push({ action: 'click', ...lastClick.current.point });
      lastClick.current = null;
    }
  }
  function commit(text: string) {
    if (!text || !enabled) return;
    flushClick();
    if (text.length > 4000) onError('Paste at most 4,000 characters at a time.');
    else queue.push({ action: 'type', text });
    resetKeyboard();
  }
  function copy(cut = false) {
    if (!enabled) return;
    flushClick();
    onCopy(async () => {
      const result = await queue.request({ kind: 'clipboard', action: cut ? 'cut' : 'copy' });
      return (result as { text: string }).text;
    });
  }
  useImperativeHandle(ref, () => ({
    copy,
    showKeyboard() {
      if (!enabled) return;
      flushClick();
      softKeyboard.current = true;
      resetKeyboard();
      keyboard.current?.focus({ preventScroll: true });
    },
    hideKeyboard() {
      keyboard.current?.blur();
    },
  }));
  useEffect(() => {
    const element = keyboard.current;
    if (!element) return;
    const beforeInput = (event: InputEvent) => {
      if (!enabled || !softKeyboard.current || composing.current || event.isComposing) return;
      const key = (
        {
          deleteContentBackward: 'BackSpace',
          deleteContentForward: 'Delete',
          insertParagraph: 'Return',
          insertLineBreak: 'Return',
        } as Record<string, string>
      )[event.inputType];
      if (!key || !event.cancelable) return;
      event.preventDefault();
      flushClick();
      queue.push({ action: 'key', key });
      resetKeyboard();
    };
    element.addEventListener('beforeinput', beforeInput);
    return () => element.removeEventListener('beforeinput', beforeInput);
  }, [enabled, queue]);
  useEffect(() => {
    const element = display.current;
    if (!element || !enabled || zoom) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (Math.abs(event.deltaY) <= 10) return;
      flushClick();
      const rect = element.getBoundingClientRect();
      queue.push({
        action: 'scroll',
        direction: event.deltaY < 0 ? 'up' : 'down',
        x: Math.max(
          0,
          Math.min(1279, Math.round(((event.clientX - rect.left) * 1280) / rect.width)),
        ),
        y: Math.max(0, Math.min(799, Math.round(((event.clientY - rect.top) * 800) / rect.height))),
      });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [enabled, zoom, queue]);
  return (
    <div className={`computer-screen-input ${focused ? 'has-keyboard' : ''}`}>
      <button
        ref={display}
        className={`computer-display ${enabled && !zoom ? 'accepts-drag' : ''} ${touchDrag ? 'accepts-touch-drag' : ''}`}
        aria-label={enabled ? 'Control private desktop' : 'Live private desktop'}
        aria-disabled={!enabled}
        aria-describedby="computer-input-help"
        onFocus={() => {
          if (enabled && !pointerFocus.current) keyboard.current?.focus({ preventScroll: true });
        }}
        onPointerDown={(event) => {
          pointerFocus.current = true;
          if (!enabled || event.button !== 0 || (event.pointerType === 'touch' && zoom)) return;
          // Native page scrolling owns touch swipes until the user enables Drag.
          if (event.pointerType !== 'touch' || touchDrag) event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          gesture.current = {
            id: event.pointerId,
            start: point(event),
            client: { x: event.clientX, y: event.clientY },
            moved: false,
            touch: event.pointerType === 'touch',
          };
        }}
        onPointerMove={(event) => {
          const drag = gesture.current;
          if (!drag || drag.id !== event.pointerId) return;
          drag.moved ||=
            Math.hypot(event.clientX - drag.client.x, event.clientY - drag.client.y) > 5;
          if (drag.moved && (!drag.touch || touchDrag))
            setLine({ start: drag.start, end: point(event) });
        }}
        onPointerUp={(event) => {
          pointerFocus.current = false;
          const drag = gesture.current;
          gesture.current = null;
          setLine(null);
          if (!enabled || !drag || drag.id !== event.pointerId) return;
          event.currentTarget.releasePointerCapture(event.pointerId);
          const end = point(event);
          if (drag.moved) {
            if (drag.touch && !touchDrag) return;
            flushClick();
            queue.push({ action: 'drag', ...drag.start, toX: end.x, toY: end.y });
          } else {
            const previous = lastClick.current;
            if (
              previous &&
              Date.now() - previous.time < 300 &&
              Math.hypot(end.x - previous.point.x, end.y - previous.point.y) < 12
            ) {
              clearTimeout(click.current);
              lastClick.current = null;
              queue.push({ action: 'double_click', ...end });
            } else {
              flushClick();
              lastClick.current = { point: end, time: Date.now() };
              click.current = setTimeout(flushClick, 260);
            }
          }
          if (!drag.touch) keyboard.current?.focus({ preventScroll: true });
        }}
        onPointerCancel={() => {
          pointerFocus.current = false;
          gesture.current = null;
          setLine(null);
        }}
        onLostPointerCapture={() => {
          gesture.current = null;
          setLine(null);
        }}
        onClick={(event) => {
          // Touch taps in the zoomed, pannable view do not start drag gestures.
          if (enabled && zoom && event.detail > 0 && !keyboard.current?.matches(':focus')) {
            flushClick();
            queue.push({ action: 'click', ...point(event) });
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          if (!enabled) return;
          flushClick();
          queue.push({ action: 'right_click', ...point(event) });
        }}
      >
        <img
          src={`data:image/jpeg;base64,${frame.screenshot}`}
          alt={frame.title || 'Relay’s private Linux desktop'}
          draggable={false}
        />
        {line && (
          <svg className="computer-drag-preview" viewBox="0 0 1280 800" aria-hidden="true">
            <line x1={line.start.x} y1={line.start.y} x2={line.end.x} y2={line.end.y} />
            <circle cx={line.end.x} cy={line.end.y} r="7" />
          </svg>
        )}
      </button>
      <textarea
        ref={keyboard}
        className="computer-direct-keyboard"
        aria-label="Type directly on the computer"
        aria-describedby="computer-input-help"
        tabIndex={-1}
        disabled={!enabled}
        value={value}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onFocus={() => {
          setFocused(true);
          onKeyboardChange(softKeyboard.current);
        }}
        onBlur={() => {
          composing.current = false;
          setFocused(false);
          softKeyboard.current = false;
          onKeyboardChange(false);
          resetKeyboard();
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          commit(typedValue(event.currentTarget.value));
        }}
        onChange={(event) => {
          setValue(event.target.value);
          if (!composing.current) commit(typedValue(event.target.value));
        }}
        onKeyDown={(event) => {
          if (!enabled || composing.current || event.nativeEvent.isComposing) return;
          if (
            (event.ctrlKey || event.metaKey) &&
            !event.altKey &&
            (!event.shiftKey || (frame.terminal && event.key.toLowerCase() === 'c')) &&
            !(frame.terminal && event.ctrlKey && !event.metaKey && !event.shiftKey) &&
            ['c', 'x'].includes(event.key.toLowerCase())
          ) {
            event.preventDefault();
            copy(event.key.toLowerCase() === 'x');
            return;
          }
          const key = desktopKey(event);
          if (key) {
            event.preventDefault();
            flushClick();
            queue.push({ action: 'key', key });
          }
        }}
      />
      <span id="computer-input-help" className="sr-only">
        Click and type on the desktop. With a mouse, drag to move or select. On touch screens, swipe
        to scroll the page or turn on Drag to move items. Tab leaves the desktop. In zoomed touch
        view, swipe to pan.
      </span>
    </div>
  );
}
