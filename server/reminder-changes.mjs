// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { routineCommand } from '../shared/routines.mjs';
import { exactReminderText, reminderSchedule } from './reminders.mjs';

const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const hash = (value) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
export function reminderChangeToken(r) {
  return hash([
    r.id,
    r.version,
    r.title,
    r.instructions,
    r.schedule,
    r.paused,
    r.pausedBySchedule,
    r.archived,
    r.execution,
    r.threadId,
    r.nextRunAt,
  ]);
}
export function reminderView(r) {
  const { reminderChanges, reminderSignature, lastResult, ...view } = r;
  return {
    ...view,
    ...(r.execution === 'reminder' ? { changeToken: reminderChangeToken(r) } : {}),
  };
}
export function reminderChangeRequested(text) {
  if (typeof text !== 'string' || text.length > 12000) return false;
  const request = text.trim().replace(/^(?:please\s+|(?:can|could|would) you\s+)+/i, '');
  if (
    /\b(?:example|in chat only|do not|don't|how)\b|(?:示例|範例|例子|怎么|怎麼|如何)/i.test(request)
  )
    return false;
  return (
    /^(?:change|move|reschedule|postpone|pause|resume|cancel|stop|edit|update)\b[^.!?\n]{0,160}\breminder\b/i.test(
      request,
    ) ||
    /^(?:请|請)?(?:帮我|幫我)?(?:修改|更改|调整|調整|推迟|推遲|暂停|暫停|恢复|恢復|取消)[^。！？\n]{0,80}提醒/.test(
      request,
    )
  );
}

// Called atomically, after the tool dispatcher enforces assistant ownership.
export function changeReminder(s, input, { threadId, sourceMessageId, runId, now = Date.now() }) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) =>
        !['id', 'changeToken', 'action', 'title', 'text', 'delayMinutes', 'schedule'].includes(key),
    )
  )
    throw Error('Choose a reminder, its current changeToken, and an action.');
  if (!['update', 'pause', 'resume', 'cancel'].includes(input.action))
    throw Error('Unsupported reminder action.');
  const source = s.messages.find(
    (m) => m.id === sourceMessageId && m.threadId === threadId && m.role === 'user',
  );
  const run = s.runs.find(
    (r) =>
      r.id === runId &&
      r.threadId === threadId &&
      (r.activeMessageId || r.messageId) === sourceMessageId,
  );
  if (
    !source ||
    !run ||
    run.routineId ||
    run.handoffRestricted ||
    run.questionContext?.origin.restrictedRoutine ||
    s.threads.find((t) => t.id === threadId)?.participantIds
  )
    throw Error('Change reminders from an owner request in one assistant conversation.');
  const r = s.routines.find((r) => r.id === input.id);
  if (!r || r.execution !== 'reminder')
    throw Error('Choose an existing fixed-text reminder from list_routines.');
  const patchKeys = ['title', 'text', 'delayMinutes', 'schedule'].filter(
    (key) => input[key] !== undefined,
  );
  if (input.action === 'update' ? !patchKeys.length : patchKeys.length)
    throw Error('Only update accepts changes, and it needs a title, text or time.');
  // The token is a read witness, not part of the requested operation. A repeated
  // request cannot undo a subsequent owner pause/edit, even with a fresh token.
  const signature = hash(
    Object.fromEntries(
      Object.entries(input)
        .filter(([key]) => key !== 'changeToken')
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
  if (
    r.reminderChanges?.some(
      (c) =>
        c.sourceMessageId === sourceMessageId &&
        c.threadId === threadId &&
        c.signature === signature,
    )
  )
    return r;
  if (typeof input.changeToken !== 'string' || input.changeToken !== reminderChangeToken(r))
    throw Error(
      'This reminder changed. Read list_routines again before applying the requested change.',
    );
  if (input.action === 'update') {
    const patch = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.text !== undefined) {
      if (typeof input.text !== 'string' || !input.text.trim())
        throw Error('Use nonempty reminder text.');
      patch.instructions = exactReminderText(source.text || '') ?? input.text.trim();
    }
    let reminderAt;
    const changesTime = input.delayMinutes !== undefined || input.schedule !== undefined;
    if (changesTime) {
      const timing = reminderSchedule(s, input, source);
      patch.schedule = timing.schedule;
      reminderAt = timing.reminderAt;
    } else if (r.schedule.kind === 'once') {
      // A text-only edit must preserve seconds, DST fold, and delivery state.
      if (r.schedule.at <= now)
        throw Error('Choose a new future time to edit an expired reminder.');
      reminderAt = r.schedule.at;
    }
    const relative = changesTime ? input.delayMinutes !== undefined : r.reminderRelative;
    routineCommand(s, 'routine.update', { id: r.id, ...patch }, now, { reminderAt });
    r.reminderRelative = !!relative;
  } else
    routineCommand(
      s,
      `routine.${input.action === 'cancel' ? 'archive' : input.action}`,
      { id: r.id },
      now,
    );
  const receipt = {
    sourceMessageId,
    threadId,
    runId,
    signature,
    action: input.action,
    changeToken: reminderChangeToken(r),
  };
  r.reminderChanges = [...(r.reminderChanges || []), receipt].slice(-20);
  return r;
}
export function changedReminder(s, run) {
  const sourceId = run.activeMessageId || run.messageId;
  return s.routines.find((r) =>
    r.reminderChanges?.some((c) => c.sourceMessageId === sourceId && c.threadId === run.threadId),
  );
}
// Some models ask the right question in plain text instead of using ask_question.
// Turn only a choice grounded in multiple actual, named reminders into the native
// question flow. This saves nothing and grants no action permission.
export function reminderChoiceQuestion(s, text, calls, sourceText = '') {
  if (
    !calls.includes('list_routines') ||
    typeof text !== 'string' ||
    text.length > 2000 ||
    !/[?？]/.test(text) ||
    !/\bwhich\b|哪(?:个|個|一)/i.test(text)
  )
    return null;
  const named = s.routines.filter(
    (r) =>
      r.execution === 'reminder' &&
      !r.archived &&
      r.title &&
      text.toLowerCase().includes(r.title.toLowerCase()),
  );
  if (
    named.length < 2 ||
    named.length > 5 ||
    new Set(named.map((r) => r.title.toLowerCase())).size !== named.length
  )
    return null;
  return {
    prompt: /[\u3400-\u9fff]/.test(sourceText)
      ? '你想修改哪一个提醒？'
      : 'Which reminder do you mean?',
    options: named.map((r) => ({ label: r.title })),
  };
}
export function reminderChangeConfirmation(s, run, cards, calls) {
  if (
    cards.length !== 1 ||
    cards[0].kind !== 'reminder' ||
    calls.some(
      (name) =>
        !['change_reminder', 'manage_routine', 'list_routines', 'load_tools'].includes(name),
    )
  )
    return null;
  const r = s.routines.find((r) => r.id === cards[0].id);
  const sourceId = run.activeMessageId || run.messageId;
  const receipt = r?.reminderChanges?.findLast(
    (c) => c.sourceMessageId === sourceId && c.threadId === run.threadId,
  );
  if (!receipt) return null;
  const chinese = /[\u3400-\u9fff]/.test(s.messages.find((m) => m.id === sourceId)?.text || '');
  if (r.archived) return chinese ? '提醒已取消。' : 'Reminder cancelled.';
  if (
    r.schedule.kind === 'once' &&
    r.nextRunAt === null &&
    s.runs.some(
      (run) =>
        run.routineId === r.id &&
        run.routineVersion === r.version &&
        run.trigger === 'schedule' &&
        run.status === 'completed',
    )
  )
    return chinese ? '提醒已送达。' : 'Your reminder has arrived.';
  if (r.paused && !r.pausedBySchedule)
    return receipt.action === 'update' && receipt.changeToken === reminderChangeToken(r)
      ? chinese
        ? '提醒已更新，并保持暂停。'
        : 'Reminder updated and kept paused.'
      : chinese
        ? '提醒目前已暂停。'
        : 'Your reminder is paused.';
  if (receipt.changeToken !== reminderChangeToken(r))
    return chinese
      ? '提醒已再次更改，请查看卡片中的当前信息。'
      : 'This reminder changed again. Its card shows the current details.';
  if (r.schedule.kind === 'once' && r.schedule.at <= Date.now())
    return chinese
      ? '提醒时间已到，正在等待送达。'
      : 'Your reminder is due now and waiting to be delivered.';
  return chinese ? '提醒已更新。' : 'Reminder updated.';
}
export const reminderChangeRecoveryMessage =
  'Relay result check: no reminder change was saved for this request. Read list_routines, identify the requested reminder, and use change_reminder with its current changeToken. Preserve all unspecified fields and paused state. Do not create a replacement reminder. Ask one concise question with ask_question when the target or new time is ambiguous. Do not claim success without the saved result.';
