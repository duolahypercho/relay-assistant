import { assistantMemories, threadAssistantId } from './assistant-scope.mjs';
// SPDX-License-Identifier: MIT
const clip = (value, size = 1200) => String(value || '').slice(0, size);
export function ideaState(s) {
  return (s.ideas ||= {
    items: [],
    dismissed: [],
    accepted: [],
    control: 0,
    mode: 'off',
    status: 'idle',
    nextCheck: 0,
  });
}
export function ideaSources(s, now = Date.now()) {
  const sources = [];
  const add = (type, row, title, content) => {
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    sources.push({
      ref: `${type}:${row.id}`,
      type,
      id: row.id,
      title: clip(title, 140),
      text,
      signature: JSON.stringify([title, text]),
    });
  };
  for (const g of s.goals.filter((g) => !g.archived).slice(0, 20))
    add('goal', g, g.title, {
      description: clip(g.description, 1000),
      due: g.due,
      current: g.current,
      target: g.target,
      unit: g.unit,
      milestones: (g.milestones || []).slice(0, 20),
    });
  for (const t of s.tasks
    .filter((t) => !['completed', 'cancelled', 'failed'].includes(t.status))
    .slice(0, 20))
    add('task', t, t.title, {
      description: clip(t.description, 800),
      status: t.status,
      step: t.step,
      input: t.input?.fields?.map((f) => ({ name: f.name, label: f.label })),
      error: clip(t.error, 300),
    });
  for (const e of s.events
    .filter(
      (e) => new Date(e.end).getTime() >= now && new Date(e.start).getTime() <= now + 14 * 86400000,
    )
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, 20))
    add('event', e, e.title, {
      start: e.start,
      end: e.end,
      location: clip(e.location, 200),
      description: clip(e.description, 600),
    });
  for (const m of s.mail.filter((m) => m.folder === 'inbox').slice(0, 12))
    add('mail', m, m.subject, {
      from: clip(m.from, 100),
      date: m.date,
      body: clip(m.body),
      attachmentNames: (m.attachmentIds || [])
        .map((id) => s.files.find((f) => f.id === id)?.name)
        .filter(Boolean)
        .slice(0, 8),
    });
  for (const m of assistantMemories(s)
    .filter((m) => m.type === 'note')
    .slice(0, 30))
    add('memory', m, 'Saved preference', clip(m.text, 500));
  for (const m of s.messages
    .filter(
      (m) =>
        m.role === 'user' &&
        threadAssistantId(s, m.threadId) === 'relay' &&
        !m.ideaId &&
        !m.skill &&
        s.threads.some((t) => t.id === m.threadId && !t.archived),
    )
    .slice(-12))
    add('message', m, 'Your conversation', clip(m.text));
  return sources;
}
export function visibleIdeas(s, now = Date.now()) {
  const sources = new Map(ideaSources(s, now).map((source) => [source.ref, source]));
  const hidden = new Set((s.ideas?.dismissed || []).map((item) => item.key));
  return (s.ideas?.items || []).filter(
    (idea) =>
      !idea.acceptedAt &&
      !hidden.has(idea.key) &&
      idea.expiresAt > now &&
      idea.sources.length &&
      idea.sources.every((source) => sources.get(source.ref)?.signature === source.signature),
  );
}
export function pruneIdeas(s, now = Date.now()) {
  if (!s.ideas) return;
  // Forgetting/changing source context also removes unsent suggestions and their quotes.
  s.ideas.items = visibleIdeas(s, now);
  const collections = {
    goal: 'goals',
    task: 'tasks',
    event: 'events',
    mail: 'mail',
    memory: 'memories',
    message: 'messages',
  };
  s.ideas.dismissed = s.ideas.dismissed.filter((item) =>
    item.refs.every((ref) => {
      const split = ref.indexOf(':');
      return s[collections[ref.slice(0, split)]]?.some((item) => item.id === ref.slice(split + 1));
    }),
  );
  const valid = new Set(s.ideas.items.map((item) => item.id));
  s.notifications = s.notifications.filter((n) => !n.ideaId || valid.has(n.ideaId));
}
export function configureIdeas(s, mode) {
  if (!['off', 'quiet', 'regular'].includes(mode)) throw new Error('Choose Off, Quiet or Regular.');
  const state = ideaState(s);
  state.mode = mode;
  state.control++;
  state.status = 'idle';
  state.runId = null;
  state.requested = false;
  state.lastFingerprint = '';
  state.nextCheck = 0;
  state.error = '';
  return state;
}
export function dismissIdea(s, id) {
  const state = ideaState(s),
    idea = visibleIdeas(s).find((item) => item.id === id);
  if (!idea) throw new Error('This suggestion is no longer current.');
  if (state.dismissed.length >= 1000)
    throw new Error('Restore an older dismissed idea before hiding another.');
  state.dismissed.push({
    id,
    key: idea.key,
    topic: idea.topic,
    title: idea.title,
    refs: idea.sources.map((source) => source.ref),
  });
  state.items = state.items.filter((item) => item.id !== id);
  return idea;
}
export function restoreIdea(s, id) {
  const state = ideaState(s);
  state.dismissed = state.dismissed.filter((item) => item.id !== id);
  state.lastFingerprint = '';
  state.nextCheck = 0;
  return { id };
}
