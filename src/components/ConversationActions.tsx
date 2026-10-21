import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Archive,
  DotsThree,
  EnvelopeSimple,
  EnvelopeSimpleOpen,
  PencilSimple,
  PushPin,
  PushPinSlash,
} from '@phosphor-icons/react';
import { useWorkspace } from '../context';
import { conversationUnread } from '../../shared/chat-list.mjs';
import { tr } from '../i18n';
import type { Entity } from '../types';
import './conversation-actions.css';

export default function ConversationActions({
  thread,
  children,
  onRename,
  visible = true,
}: {
  thread: Entity;
  children?: ReactNode;
  onRename?: () => void;
  visible?: boolean;
}) {
  const { s, page, threadId, act, selectThread } = useWorkspace();
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null),
    menu = useRef<HTMLDivElement>(null);
  const pending = useRef(false);
  const assistant = thread.assistantHome
    ? s.assistants?.find((a) => a.threadId === thread.id)
    : undefined;
  const canPin = !!assistant || (thread.id !== 'main' && !thread.assistantHome && !thread.replyTo);
  const pinned = assistant ? assistant.pinned : thread.pinned;
  const unread = conversationUnread(s, thread.id);
  const label = children
    ? tr('Options for {name}', { name: thread.id === 'main' ? tr('Main chat') : thread.title })
    : tr('Conversation options');
  function close(restore = true) {
    setOpen(false);
    if (restore) requestAnimationFrame(() => trigger.current?.focus());
  }
  useEffect(() => {
    close(false);
  }, [page, threadId, visible]);
  function placeMenu() {
    if (!trigger.current || !menu.current) return;
    const anchor = trigger.current.getBoundingClientRect(),
      bounds = menu.current.getBoundingClientRect();
    if (anchor.bottom < 0 || anchor.top > innerHeight) {
      close(false);
      return;
    }
    const left = Math.max(8, Math.min(anchor.right - bounds.width, innerWidth - bounds.width - 8));
    const top = Math.max(8, Math.min(anchor.bottom + 6, innerHeight - bounds.height - 8));
    setPosition((old) => (old.left === left && old.top === top ? old : { left, top }));
  }
  useLayoutEffect(() => {
    if (!open) return;
    placeMenu();
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        !menu.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        close(false);
    };
    let frame = 0;
    const reposition = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(placeMenu);
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', reposition);
    window.visualViewport?.addEventListener('resize', reposition);
    const scroll = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) reposition();
    };
    document.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', reposition);
      window.visualViewport?.removeEventListener('resize', reposition);
      cancelAnimationFrame(frame);
      document.removeEventListener('scroll', scroll, true);
    };
  }, [open]);
  async function change(action: string, payload: Record<string, any>, after?: () => void) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      if (await act(action, payload)) {
        close();
        after?.();
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <div
      className={children ? 'conversation-row' : 'conversation-actions'}
      onContextMenu={(event) => {
        event.preventDefault();
        if (!thread.archived) setOpen(true);
      }}
    >
      {children}
      {!thread.archived && (
        <button
          ref={trigger}
          className="icon-button conversation-menu-trigger"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setOpen(true);
            }
          }}
        >
          <DotsThree size={20} aria-hidden="true" />
        </button>
      )}
      {open &&
        createPortal(
          <section aria-label={label}>
            <div
              ref={menu}
              className="conversation-menu"
              style={position}
              role="menu"
              aria-label={label}
              onKeyDown={(event) => {
                if (['Escape', 'Tab'].includes(event.key)) {
                  event.preventDefault();
                  event.stopPropagation();
                  close();
                }
                if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                  event.preventDefault();
                  event.stopPropagation();
                  const buttons = Array.from(
                    event.currentTarget.querySelectorAll<HTMLButtonElement>(
                      'button:not(:disabled)',
                    ),
                  );
                  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
                  const next =
                    event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? buttons.length - 1
                        : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
                          buttons.length;
                  buttons[next]?.focus();
                }
              }}
            >
              {canPin && (
                <button
                  role="menuitem"
                  disabled={busy}
                  onClick={() =>
                    void change(
                      assistant ? 'assistant.pin' : 'thread.update',
                      assistant
                        ? { id: assistant.id, value: !pinned }
                        : { id: thread.id, pinned: !pinned },
                    )
                  }
                >
                  {pinned ? <PushPinSlash size={18} /> : <PushPin size={18} />}{' '}
                  {tr(pinned ? 'Unpin conversation' : 'Pin conversation')}
                </button>
              )}
              <button
                role="menuitem"
                disabled={busy}
                onClick={() => void change('thread.read', { id: thread.id, read: unread })}
              >
                {unread ? <EnvelopeSimpleOpen size={18} /> : <EnvelopeSimple size={18} />}{' '}
                {tr(unread ? 'Mark as read' : 'Mark as unread')}
              </button>
              {onRename && (
                <button
                  role="menuitem"
                  disabled={busy}
                  onClick={() => {
                    close(false);
                    onRename();
                  }}
                >
                  <PencilSimple size={18} /> {tr('Rename conversation')}
                </button>
              )}
              {thread.id !== 'main' && !thread.assistantHome && !thread.replyTo && (
                <button
                  role="menuitem"
                  disabled={busy}
                  onClick={() =>
                    void change('thread.update', { id: thread.id, archived: true }, () => {
                      if (
                        threadId === thread.id ||
                        s.threads.find((t) => t.id === threadId)?.replyTo?.threadId === thread.id
                      )
                        selectThread('main');
                    })
                  }
                >
                  <Archive size={18} /> {tr('Archive conversation')}
                </button>
              )}
            </div>
          </section>,
          document.body,
        )}
    </div>
  );
}
