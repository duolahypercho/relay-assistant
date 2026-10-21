import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GraduationCap, Paperclip, Plus } from '@phosphor-icons/react';
import { tr } from '../i18n';
import './composer-actions.css';

export default function ComposerActions({
  disabled,
  teaching,
  chatId,
  onAttach,
  onTeach,
}: {
  disabled: boolean;
  teaching: boolean;
  chatId: string;
  onAttach: () => void;
  onTeach: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8, maxHeight: 300 });
  const trigger = useRef<HTMLButtonElement>(null),
    menu = useRef<HTMLDivElement>(null);
  function close(restore = true) {
    setOpen(false);
    if (restore) requestAnimationFrame(() => trigger.current?.focus());
  }
  useEffect(() => {
    close(false);
  }, [disabled, teaching, chatId]);
  function place() {
    if (!trigger.current || !menu.current) return;
    const anchor = trigger.current.getBoundingClientRect(),
      box = menu.current.getBoundingClientRect();
    const viewport = window.visualViewport,
      top = viewport?.offsetTop || 0,
      height = viewport?.height || innerHeight,
      width = viewport?.width || innerWidth;
    setPosition({
      left: Math.max(8, Math.min(anchor.left, width - box.width - 8)),
      top: Math.max(top + 8, Math.min(anchor.top - box.height - 8, top + height - box.height - 8)),
      maxHeight: Math.max(88, height - 16),
    });
  }
  useLayoutEffect(() => {
    if (!open) return;
    place();
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node))
        close(false);
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', place);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
    };
  }, [open]);
  return (
    <>
      <button
        ref={trigger}
        className="composer-plus"
        type="button"
        disabled={disabled}
        aria-label={tr(teaching ? 'Add to chat' : 'Attach files')}
        title={tr(teaching ? 'Add to chat' : 'Attach files')}
        aria-haspopup={teaching ? 'menu' : undefined}
        aria-expanded={teaching ? open : undefined}
        onClick={() => (teaching ? setOpen(!open) : onAttach())}
        onKeyDown={(e) => {
          if (teaching && e.key === 'ArrowUp') {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Plus size={24} />
      </button>
      {open &&
        createPortal(
          <section aria-label={tr('Add to chat')}>
            <div
              ref={menu}
              className="composer-add-menu"
              role="menu"
              aria-label={tr('Add to chat')}
              style={position}
              onKeyDown={(e) => {
                if (e.key === 'Escape' || e.key === 'Tab') {
                  e.preventDefault();
                  e.stopPropagation();
                  close();
                }
                if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
                  e.preventDefault();
                  e.stopPropagation();
                  const buttons = Array.from(
                    e.currentTarget.querySelectorAll<HTMLButtonElement>('button'),
                  );
                  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                  const next =
                    e.key === 'Home'
                      ? 0
                      : e.key === 'End'
                        ? buttons.length - 1
                        : (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
                          buttons.length;
                  buttons[next]?.focus();
                }
              }}
            >
              <button
                role="menuitem"
                onClick={() => {
                  onAttach();
                  close();
                }}
              >
                <Paperclip size={20} />
                {tr('Attach files')}
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  close(false);
                  onTeach();
                }}
              >
                <GraduationCap size={20} />
                {tr('Teach a task')}
              </button>
            </div>
          </section>,
          document.body,
        )}
    </>
  );
}
