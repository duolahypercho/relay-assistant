import { tr, uiLocale } from '../i18n';
import {
  useLayoutEffect,
  useId,
  useRef,
  cloneElement,
  isValidElement,
  type ReactNode,
} from 'react';
import { X, Check, Clock, Warning, FileText } from '@phosphor-icons/react';
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const d = ref.current!;
    const trigger = document.activeElement as HTMLElement | null;
    d.showModal();
    d.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => {
      d.close();
      if (trigger?.isConnected && !trigger.closest('[inert]'))
        trigger.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'wide' : ''}`}
      aria-labelledby={id}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="modal-head">
        <h2 id={id}>{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label={tr('Close dialog')}>
          <X size={22} />
        </button>
      </div>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
export function PageHeading({
  eyebrow = 'YOUR WORKSPACE',
  title,
  description,
  children,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading heading-actions">
      <div>
        <span className="overline">{eyebrow}</span>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {children && <div className="heading-buttons">{children}</div>}
    </div>
  );
}
export function Empty({
  icon: Icon = FileText,
  title,
  children,
  action,
}: {
  icon?: any;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <Icon size={34} />
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action && <div className="empty-actions">{action}</div>}
    </div>
  );
}
const statusNames: Record<string, string> = {
  queued: 'Queued',
  running: 'Working',
  paused: 'Paused',
  needs_input: 'Needs your input',
  needs_approval: 'Ready for review',
  completed: 'Completed',
  failed: 'Needs attention',
  cancelled: 'Cancelled',
  pending: 'Ready for review',
  approved: 'Approved',
  executing: 'Completing action',
  rejected: 'Declined',
  expired: 'Review expired',
  outcome_unknown: 'Check the outcome',
  watching: 'Watching',
  error: 'Needs attention',
};
export function Status({ status }: { status: string }) {
  return (
    <span className={`status status-${status}`}>
      {status === 'completed' ? (
        <Check size={13} weight="bold" />
      ) : ['failed', 'error', 'outcome_unknown'].includes(status) ? (
        <Warning size={13} />
      ) : (
        <Clock size={13} />
      )}{' '}
      {tr(statusNames[status] || status)}
    </span>
  );
}
export function Field({
  label,
  children,
  hint,
  action,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  action?: ReactNode;
}) {
  const id = useId();
  const props = { id, 'aria-describedby': hint ? `${id}-hint` : undefined };
  const control = isValidElement(children)
    ? cloneElement(children as React.ReactElement<any>, props)
    : children;
  return (
    <div className="field">
      {action ? (
        <div className="field-heading">
          <label htmlFor={id}>{label}</label>
          {action}
        </div>
      ) : (
        <label htmlFor={id}>{label}</label>
      )}
      {control}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}
export function dateTime(value: string, allDay = false) {
  const d = new Date(value);
  return Number.isNaN(+d)
    ? value
    : new Intl.DateTimeFormat(
        uiLocale(),
        allDay
          ? { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }
          : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
      ).format(d);
}
export const money = (cents: number) =>
  new Intl.NumberFormat(uiLocale(), { style: 'currency', currency: 'USD' }).format(cents / 100);
export function localDate(value: string) {
  const d = new Date(value);
  return new Date(+d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
