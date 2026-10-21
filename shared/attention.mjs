// SPDX-License-Identifier: MIT
// Notification text is source data. Targets are resolved against the current workspace,
// never treated as URLs, commands or permission to run an action.
const modes = new Set(['all', 'attention', 'off']);
export function notificationMode(value) {
  if (!modes.has(value)) throw Error('Choose all updates, attention only, or off.');
  return value;
}
export function attentionEvents(s) {
  const read = new Set(s.attentionReadIds || []),
    events = new Map();
  const add = (event) =>
    events.set(event.id, { ...event, read: !!event.read || read.has(event.id) });
  for (const n of (s.notifications || []).slice(0, 250)) {
    const review = n.reviewId && s.approvals.find((a) => a.id === n.reviewId);
    const thread = review?.threadId && s.threads.find((t) => t.id === review.threadId);
    add({
      id: n.id,
      title: n.title,
      body: String(n.body || '').slice(0, 240),
      createdAt: n.createdAt,
      read: n.read,
      category: n.category || 'result',
      assistantId: n.assistantId || review?.assistantId || thread?.assistantId || 'relay',
      group: !!thread?.participantIds,
      target: n.reviewId
        ? { reviewId: n.reviewId }
        : n.taskId
          ? { taskId: n.taskId }
          : { page: n.link },
    });
  }
  const cursors = s.attentionReadThrough || {};
  const positions = new Map(s.messages.map((m, i) => [m.id, i]));
  for (const m of s.messages.slice(-500)) {
    if (m.role !== 'assistant' || (!m.text && !m.cards?.length) || m.handoffWaiting) continue;
    const thread = s.threads.find((t) => t.id === m.threadId);
    if (!thread || thread.archived) continue;
    const question = m.cards?.find((c) => c.kind === 'question');
    const review = m.cards?.find((c) => c.kind === 'review');
    const old = (s.notifications || []).find(
      (n) => (review && n.reviewId === review.id) || (m.runId && n.runId === m.runId),
    );
    const assistantId = m.assistantId || thread.assistantId || 'relay';
    const name =
      m.assistantName ||
      (assistantId === 'relay'
        ? s.profile.assistantName || 'Relay'
        : s.assistants?.find((a) => a.id === assistantId)?.name || 'Your assistant');
    const category = m.error ? 'error' : question ? 'question' : review ? 'review' : 'result';
    const id =
      old?.id ||
      (question ? `question:${question.id}` : review ? `review:${review.id}` : `message:${m.id}`);
    add({
      id,
      title: category === 'result' ? `${name} has an update` : `${name} needs your attention`,
      body: question
        ? s.questions?.find((q) => q.id === question.id)?.prompt || 'A question is ready.'
        : review
          ? s.approvals.find((a) => a.id === review.id)?.title || 'An action is ready for review.'
          : String(m.text || 'Your result is ready.').slice(0, 240),
      createdAt: m.createdAt,
      assistantId,
      category,
      group: !!thread.participantIds,
      read:
        old?.read ||
        (positions.has(cursors[m.threadId]) &&
          positions.get(m.id) <= positions.get(cursors[m.threadId])),
      target: { threadId: m.threadId, messageId: m.id },
    });
  }
  return [...events.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 250);
}
export function attentionAllowed(s, event) {
  if (s.profile.notifications === false) return false;
  const mode = event.group
    ? 'all'
    : event.assistantId === 'relay'
      ? s.profile.notificationMode || 'all'
      : s.assistants?.find((a) => a.id === event.assistantId)?.notificationMode || 'all';
  return mode !== 'off' && (mode !== 'attention' || event.category !== 'result');
}
export function attentionTarget(s, id) {
  const e = attentionEvents(s).find((e) => e.id === id);
  if (!e)
    throw Error(
      'This update is no longer available. Open your conversation to see its latest state.',
    );
  const target = e.target;
  if (target.threadId) {
    const t = s.threads.find((t) => t.id === target.threadId && !t.archived);
    const m = s.messages.find((m) => m.id === target.messageId && m.threadId === t?.id);
    if (!t || !m) throw Error('This conversation is unavailable or archived.');
    return { id: e.id, threadId: t.id, messageId: m.id };
  }
  if (target.reviewId && s.approvals.some((a) => a.id === target.reviewId))
    return { id: e.id, reviewId: target.reviewId };
  if (target.taskId && s.tasks.some((t) => t.id === target.taskId))
    return { id: e.id, taskId: target.taskId };
  const pages = [
    'activity',
    'computer',
    'routines',
    'ideas',
    'files',
    'calendar',
    'inbox',
    'goals',
  ];
  return { id: e.id, page: pages.includes(target.page) ? target.page : 'chat' };
}
export function attentionCommand(s, p) {
  if (p.threadId) {
    const thread = s.threads.find((t) => t.id === p.threadId && !t.archived);
    const message = s.messages.find(
      (m) => m.id === p.throughMessageId && m.threadId === thread?.id,
    );
    if (!thread || (p.throughMessageId ? !message : typeof p.unreadMarker !== 'string'))
      throw Error('Choose a message in this conversation.');
    // An automatic read sent before a new manual reminder must not erase that reminder.
    if (p.unreadMarker && thread.unreadMarker === p.unreadMarker) delete thread.unreadMarker;
    s.attentionReadThrough ||= {};
    const old = s.messages.findIndex((m) => m.id === s.attentionReadThrough[thread.id]);
    if (message && s.messages.indexOf(message) > old)
      s.attentionReadThrough[thread.id] = message.id;
  } else {
    const events = attentionEvents(s);
    if (p.id && !events.some((e) => e.id === p.id))
      throw Error('This update is no longer available.');
    const ids = new Set(s.attentionReadIds || []);
    for (const e of events) if (!p.id || p.id === e.id) ids.add(e.id);
    s.attentionReadIds = [...ids].slice(-1000);
    for (const n of s.notifications || []) if (!p.id || p.id === n.id) n.read = true;
  }
  return { read: true };
}
