// SPDX-License-Identifier: MIT
import { exampleCsv, importTransactions } from './finance.mjs';
export const iso = () => new Date().toISOString();
export const uid = (prefix = 'item') => `${prefix}-${globalThis.crypto.randomUUID()}`;
export function createWorkspace({ sample = true } = {}) {
  const now = iso();
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const state = {
    schema: 1,
    revision: 0,
    profile: {
      name: '',
      tone: 'Clear and friendly',
      initials: 'ME',
      notifications: true,
      theme: 'light',
    },
    threads: [{ id: 'main', title: 'Main chat', archived: false, draft: '', createdAt: now }],
    messages: [],
    questions: [],
    runs: [],
    tasks: [],
    approvals: [],
    goals: [],
    watches: [],
    routines: [],
    skills: [],
    files: [],
    mail: [],
    events: [],
    memories: [],
    notifications: [],
    receipts: [],
    transactions: [],
    financeName: '',
    fixture: { available: false, price: 89, text: 'The studio workshop is sold out.' },
    connections: {
      google: { connected: false, email: '', generation: 0 },
      model: { configured: false },
      computer: { enabled: false },
    },
  };
  if (!sample) return state;
  state.transactions = importTransactions(exampleCsv);
  state.financeName = 'Example transactions';
  state.mail = [
    {
      id: 'mail-field-trip',
      from: 'Mira Chen',
      email: 'mira@example.invalid',
      to: 'you@example.invalid',
      subject: 'A day at the Riverbank Field Lab',
      body: `Hello!\n\nOur group is visiting the Riverbank Field Lab next week. Please complete the attached permission form with the participant name, contact number, and any access needs. Return it by ${tomorrow}.\n\nWe will meet at 9:00 am and return at 3:30 pm.\n\nThanks,\nMira`,
      date: now,
      read: false,
      folder: 'inbox',
      attachmentIds: ['file-permission'],
    },
    {
      id: 'mail-review',
      from: 'Ellis Workshop',
      email: 'ellis@example.invalid',
      to: 'you@example.invalid',
      subject: 'Design review: find a time this week',
      body: 'Hi! Could we make time for a 30-minute design review this week? I have the updated concepts ready. Suggest a time and send me a calendar invitation once you have checked it.\n\nEllis',
      date: now,
      read: false,
      folder: 'inbox',
      attachmentIds: [],
    },
    {
      id: 'mail-weekend',
      from: 'Studio Notes',
      email: 'notes@example.invalid',
      to: 'you@example.invalid',
      subject: 'Your October reading list',
      body: 'Three ideas for your next quiet afternoon: a walk along the river, an independent bookshop visit, and a notebook for the ideas that come along.\n\nHave a good weekend!',
      date: now,
      read: true,
      folder: 'inbox',
      attachmentIds: [],
    },
  ];
  state.files = [
    {
      id: 'file-permission',
      name: 'field-lab-permission.pdf',
      mime: 'application/pdf',
      size: 0,
      base64: '',
      template: 'permission',
      fields: [
        { name: 'participant', type: 'text', label: 'Participant name' },
        { name: 'contact', type: 'text', label: 'Contact number' },
        { name: 'access', type: 'text', label: 'Access needs (optional)' },
      ],
      createdAt: now,
      source: 'Sample mailbox',
    },
    {
      id: 'file-notes',
      name: 'a-place-for-your-ideas.md',
      mime: 'text/markdown',
      size: 103,
      text: '# A place for your ideas\n\nWrite a thought here. Ask Relay to turn it into a plan when you are ready.\n',
      createdAt: now,
      source: 'Sample workspace',
    },
  ];
  state.goals = [
    {
      id: 'goal-savings',
      title: 'A little more breathing room',
      description: 'Build an emergency fund, one month at a time.',
      target: 3000,
      current: 1200,
      unit: 'USD',
      due: '',
      archived: false,
      milestones: [
        { id: 'm1', title: 'Set a monthly saving amount', done: true },
        { id: 'm2', title: 'Review recurring subscriptions', done: false },
        { id: 'm3', title: 'Reach the first $2,000', done: false },
      ],
      createdAt: now,
    },
    {
      id: 'goal-reading',
      title: 'Make room for reading',
      description: 'Finish six books before the end of the year.',
      target: 6,
      current: 2,
      unit: 'books',
      due: '',
      archived: false,
      milestones: [
        { id: 'm4', title: 'Choose the next book', done: false },
        { id: 'm5', title: 'Keep a short reading note', done: false },
      ],
      createdAt: now,
    },
  ];
  state.events = [
    {
      id: 'event-focus',
      title: 'A little time to focus',
      start: new Date(Date.now() + 3_600_000).toISOString(),
      end: new Date(Date.now() + 7_200_000).toISOString(),
      description: 'A protected hour for your most important work.',
      location: '',
      version: 1,
    },
  ];
  state.messages = [
    {
      id: 'welcome',
      threadId: 'main',
      role: 'assistant',
      text: 'A fresh space for your day. Tell me what you want to get done, or try one of the starting points below.',
      createdAt: now,
      cards: [],
    },
  ];
  return state;
}

export function deriveIdeas(state) {
  const ideas = [];
  for (const mail of state.mail.filter((m) => m.folder === 'inbox')) {
    if (
      state.receipts.some((r) => r.sourceId === mail.id && r.status === 'completed') ||
      state.tasks.some((t) => t.sourceId === mail.id && !['cancelled', 'failed'].includes(t.status))
    )
      continue;
    if (
      mail.attachmentIds?.some(
        (id) => state.files.find((f) => f.id === id)?.mime === 'application/pdf',
      )
    )
      ideas.push({
        id: `idea-${mail.id}`,
        title: 'One less form on your list',
        description: `Open the PDF from “${mail.subject}” and prepare a filled copy for your review.`,
        source: `Email from ${mail.from}`,
        sourceId: mail.id,
        kind: 'document',
        prompt: `Complete the form from ${mail.from}`,
      });
    else if (/review|meeting|calendar/i.test(mail.subject))
      ideas.push({
        id: `idea-${mail.id}`,
        title: 'Find a moment to connect',
        description: `Check your calendar for “${mail.subject}” and choose a time to review.`,
        source: `Email from ${mail.from}`,
        sourceId: mail.id,
        kind: 'calendar',
        prompt: `Plan ${mail.subject}`,
      });
  }
  if (
    state.transactions.length &&
    !state.receipts.some((r) => r.sourceId === 'finance-review') &&
    !state.tasks.some(
      (t) => t.sourceId === 'finance-review' && !['cancelled', 'failed'].includes(t.status),
    )
  )
    ideas.push({
      id: 'idea-finance',
      title: 'See where the month is going',
      description: 'Review spending categories and choose a realistic saving target.',
      source: state.financeName || 'Your transactions',
      sourceId: 'finance-review',
      kind: 'finance',
      prompt: 'Review my spending and help me save',
    });
  return ideas.filter(
    (i) => !state.memories.some((m) => m.type === 'dismissed-idea' && m.text === i.id),
  );
}
