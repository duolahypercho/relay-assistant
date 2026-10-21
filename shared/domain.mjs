import { isStopMessage, requestChatStop, stopReply } from './chat-stop.mjs';
import { markConversation } from './chat-list.mjs';
import { appReferences, resolveChatApps } from './app-mentions.mjs';
import { attentionCommand, notificationMode } from './attention.mjs';
import { stageShare, removeShare, selectedShares } from './incoming-shares.mjs';
import { groupCommand, groupRecipients, groupRuns } from './groups.mjs';
import { openReplyThread, defaultReplyRecipient } from './reply-threads.mjs';
import { cancelHandoff } from './handoffs.mjs';
import { importTemplate } from './assistant-templates.mjs';
// SPDX-License-Identifier: MIT
import {
  configureIdeas,
  dismissIdea,
  restoreIdea,
  visibleIdeas,
  ideaState,
  pruneIdeas,
} from './ideas.mjs';
import { uid, iso } from './seed.mjs';
import { assistantCommand } from './assistants.mjs';
import {
  assistantProfile,
  assistantSnapshot,
  acceptsAssistant,
  assistantSkills,
  threadAssistantId,
  memoryAssistantId,
} from './assistant-scope.mjs';
import { questionCommand } from './questions.mjs';
import { importTransactions } from './finance.mjs';
import { surfaces } from './surfaces.mjs';
import { routineCommand } from './routines.mjs';
import { skillCommand, skillInvocation, skillSnapshot } from './skills.mjs';
import { memoryControlChanged, resolveMemory } from './memory.mjs';
import { fromBase64 } from './pdf.mjs';
export function required(value, label, limit = 200) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  if (value.trim().length > limit)
    throw new Error(`${label} must be ${limit} characters or fewer.`);
  return value.trim();
}
export function publicUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a complete http or https URL.');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Use a public http or https URL without credentials.');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.includes(':') ||
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
  )
    throw new Error('Private network addresses are unavailable to the agent browser.');
  return url.href;
}
function item(list, id, label) {
  const found = list.find((i) => i.id === id);
  if (!found) throw new Error(`${label} was not found.`);
  return found;
}
function notify(s, title, body, link, extra = {}) {
  if (!s.profile.notifications) return;
  s.notifications.unshift({
    id: uid('notice'),
    title,
    body,
    link,
    read: false,
    createdAt: iso(),
    ...extra,
  });
}
export function receipt(s, kind, title, detail, sourceId, extra = {}) {
  const r = {
    id: uid('receipt'),
    kind,
    title,
    detail,
    status: 'completed',
    sourceId,
    createdAt: iso(),
    ...extra,
  };
  s.receipts.unshift(r);
  return r;
}
export function createApproval(
  s,
  { kind, title, payload, taskId = '', sourceId = '', connectionGeneration = null },
) {
  const approval = {
    id: uid('review'),
    kind,
    title,
    payload: structuredClone(payload),
    taskId,
    sourceId,
    connectionGeneration,
    accountEmail: connectionGeneration !== null ? s.connections.google.email : '',
    status: 'pending',
    createdAt: iso(),
    expiresAt: Date.now() + 1800000,
  };
  if (kind === 'email')
    approval.attachments = (payload.attachmentIds || []).map((id) =>
      structuredClone(item(s.files, id, 'Attachment')),
    );
  s.approvals.unshift(approval);
  if (taskId) {
    const task = item(s.tasks, taskId, 'Task');
    task.status = 'needs_approval';
    task.approvalId = approval.id;
  }
  notify(s, 'Ready for your review', title, 'activity', {
    reviewId: approval.id,
    category: 'review',
  });
  return approval;
}
export function createTask(s, p) {
  const title = required(p.title, 'Task title', 180);
  const threadId = p.threadId || 'main';
  item(s.threads, threadId, 'Conversation');
  const task = {
    id: uid('task'),
    threadId,
    assistantId: threadAssistantId(s, threadId),
    assistant: assistantSnapshot(s, threadId),
    title,
    description: String(p.description || title).slice(0, 4000),
    kind: p.kind || 'general',
    sourceId: p.sourceId || '',
    status: 'queued',
    step: 0,
    attempt: 0,
    createdAt: iso(),
    updatedAt: iso(),
    plan: [],
    result: '',
    input: null,
    approvalId: null,
    leaseUntil: 0,
    leaseOwner: null,
  };
  if (!['general', 'research', 'document', 'finance', 'email', 'calendar'].includes(task.kind))
    throw new Error('Choose a supported task type.');
  if (p.fileId) {
    const f = item(s.files, p.fileId, 'Task file');
    if (task.kind === 'document' && f.mime !== 'application/pdf')
      throw new Error('Choose a PDF for a document task.');
    task.fileId = f.id;
  }
  task.plan =
    task.kind === 'document'
      ? [
          'Open the attached form',
          'Collect the requested details',
          'Prepare a filled copy',
          'Review and send the reply',
        ]
      : task.kind === 'finance'
        ? ['Read your transactions', 'Review category totals', 'Prepare a spending note']
        : ['Gather the relevant context', 'Work through the request', 'Save the result'];
  s.tasks.unshift(task);
  return task;
}
// Each command executes synchronously inside a storage transaction. External work is claimed separately.
export function command(
  s,
  action,
  p = {},
  deferPrune = false,
  appCatalog = s.connections.apps || [],
  origin = {},
) {
  if (action === 'reply.open') return openReplyThread(s, p.messageId);
  if (action.startsWith('group.')) return groupCommand(s, action, p);
  if (action === 'handoff.cancel') return cancelHandoff(s, p.id);
  if (action === 'template.import') return importTemplate(s, p.template, p.requestId);
  if (action.startsWith('assistant.')) return assistantCommand(s, action, p);
  if (action.startsWith('question.')) return questionCommand(s, action, p);
  if (action.startsWith('routine.')) return routineCommand(s, action, p);
  if (action === 'skill.run') {
    const skill = skillSnapshot(s, p.id);
    const thread = item(s.threads, p.threadId, 'Conversation');
    // An explicit skill test is separate from the unfinished composer. Retain
    // every draft field, including attachments and group recipients, on failure too.
    const fields = ['draft', 'draftFileIds', 'draftApps', 'draftShareIds', 'draftRecipientIds'];
    const draft = Object.fromEntries(
      fields.filter((key) => Object.hasOwn(thread, key)).map((key) => [key, thread[key]]),
    );
    try {
      return command(s, 'chat.send', {
        threadId: thread.id,
        text: `/${skill.slug}${p.input ? ` ${required(p.input, 'Run input', 10000)}` : ''}`,
        fileIds: [],
        shareIds: [],
      });
    } finally {
      for (const key of fields) {
        if (Object.hasOwn(draft, key)) thread[key] = draft[key];
        else delete thread[key];
      }
    }
  }
  if (action.startsWith('skill.')) return skillCommand(s, action, p);
  if (action === 'share.attach') return stageShare(s, p);
  if (action === 'share.remove') return removeShare(s, p);
  let result;
  switch (action) {
    case 'thread.create': {
      const assistant = assistantProfile(s, p.assistantId);
      const thread = {
        id: uid('thread'),
        title: String(p.title || 'New side chat').slice(0, 100),
        ...(assistant.id !== 'relay' ? { assistantId: assistant.id } : {}),
        archived: false,
        draft: '',
        createdAt: iso(),
      };
      s.threads.unshift(thread);
      result = thread;
      break;
    }
    case 'thread.read':
      return markConversation(s, p);
    case 'thread.update': {
      const t = item(s.threads, p.id, 'Conversation');
      if (t.replyTo && (p.title !== undefined || p.archived !== undefined))
        throw new Error('Rename or archive the original conversation instead.');
      if (p.pinned !== undefined) {
        if (typeof p.pinned !== 'boolean') throw new Error('Choose a valid pin setting.');
        if (t.id === 'main' || t.assistantHome || t.replyTo)
          throw new Error('Pin a side conversation or use the assistant pin control.');
        t.pinned = p.pinned;
      }
      if (p.title !== undefined) t.title = required(p.title, 'Conversation title', 100);
      if (p.archived !== undefined) {
        if ((t.id === 'main' || t.assistantHome) && p.archived)
          throw new Error('Keep your main workspace available.');
        t.archived = !!p.archived;
        for (const child of s.threads.filter((child) => child.replyTo?.threadId === t.id))
          child.archived = t.archived;
      }
      if (p.draftRecipientIds !== undefined) {
        t.draftRecipientIds = groupRecipients(s, t, { recipientIds: p.draftRecipientIds }, null);
        if (!t.participantIds) throw new Error('Choose recipients in a group chat.');
      }
      if (p.draftApps !== undefined) t.draftApps = appReferences(p.draftApps);
      if (p.draft !== undefined) t.draft = String(p.draft).slice(0, 12000);
      if (p.draftFileIds !== undefined) {
        if (
          !Array.isArray(p.draftFileIds) ||
          p.draftFileIds.length > 8 ||
          p.draftFileIds.some((id) => !s.files.some((f) => f.id === id))
        )
          throw new Error('Choose up to eight saved attachments.');
        t.draftFileIds = [...new Set(p.draftFileIds)];
      }
      if (p.queuePaused !== undefined) t.queuePaused = !!p.queuePaused;
      result = t;
      break;
    }
    case 'chat.present': {
      const thread = item(s.threads, p.threadId, 'Conversation');
      if (thread.archived)
        throw new Error('Restore this conversation before opening its workspace.');
      let card, text, request;
      if (p.taskId) {
        const task = item(s.tasks, p.taskId, 'Task');
        const existing = s.messages.findLast(
          (m) =>
            m.threadId === thread.id &&
            m.cards?.some((c) => ['task', 'task-detail'].includes(c.kind) && c.id === task.id),
        );
        if (existing) {
          result = existing;
          break;
        }
        card = { kind: 'task-detail', id: task.id };
        request = `Show the task: ${task.title}`;
        text = 'Here’s the plan, progress, and next step.';
      } else if (p.reviewId) {
        const approval = item(s.approvals, p.reviewId, 'Review');
        const existing = s.messages.findLast(
          (m) =>
            m.threadId === thread.id &&
            m.cards?.some(
              (c) =>
                (c.kind === 'review' && c.id === approval.id) ||
                (c.kind === 'task' && approval.taskId === c.id),
            ),
        );
        if (existing) {
          result = existing;
          break;
        }
        card = { kind: 'review', id: approval.id };
        text = 'Please review this before it goes ahead.';
      } else {
        const surface = Object.hasOwn(surfaces, p.page) ? surfaces[p.page] : null;
        if (!surface) throw new Error('Choose a supported workspace view.');
        card = { kind: 'workspace', page: p.page };
        request = surface.request;
        text = surface.text;
        const last = s.messages.findLast((m) => m.threadId === thread.id);
        if (last?.cards?.some((c) => c.kind === 'workspace' && c.page === p.page)) {
          result = last;
          break;
        }
      }
      let replyTo;
      if (request) {
        replyTo = uid('message');
        s.messages.push({
          id: replyTo,
          threadId: thread.id,
          role: 'user',
          text: request,
          createdAt: iso(),
          cards: [],
          workspaceAction: true,
        });
      }
      const message = {
        id: uid('message'),
        threadId: thread.id,
        role: 'assistant',
        text,
        cards: [card],
        createdAt: iso(),
        workspaceAction: true,
        ...(replyTo ? { replyTo } : {}),
      };
      s.messages.push(message);
      result = message;
      break;
    }
    case 'message.react': {
      const message = item(s.messages, p.id, 'Message');
      if (!['', '❤️', '👍', '😂', '‼️', '❓'].includes(p.reaction))
        throw new Error('Choose an available reaction.');
      message.reaction = p.reaction;
      result = message;
      break;
    }
    case 'chat.send': {
      if (p.delivery !== undefined && !['now', 'queue'].includes(p.delivery))
        throw Error('Choose Send or Queue follow-up.');
      const thread = item(s.threads, p.threadId, 'Conversation');
      // This provenance is supplied by VoiceCalls, never by a command payload.
      const voiceCall = origin.voiceCallId
        ? s.voiceCalls?.find(
            (c) => c.id === origin.voiceCallId && c.threadId === thread.id && c.status === 'active',
          )
        : null;
      if (origin.voiceCallId && !voiceCall) throw new Error('This voice chat has ended.');
      if (thread.archived) throw new Error('Restore this conversation before sending a message.');
      const shares = selectedShares(s, thread, p.shareIds);
      const fileIds = [...new Set([...(p.fileIds || []), ...shares.flatMap((x) => x.fileIds)])];
      if (fileIds.length > 8) throw new Error('Send up to eight attachments at a time.');
      fileIds.forEach((id) => item(s.files, id, 'Attachment'));
      const emptyText = p.text == null || (typeof p.text === 'string' && !p.text.trim());
      const text = required(
        emptyText && (shares.length || fileIds.length) ? 'Shared with you.' : p.text,
        'Message',
        12000,
      );
      const quoted = p.replyToMessageId
        ? item(s.messages, p.replyToMessageId, 'Original message')
        : null;
      if (quoted && quoted.threadId !== thread.id)
        throw new Error('Reply to a message in this conversation.');
      const recipients = groupRecipients(
        s,
        thread,
        p,
        quoted || (!p.recipientIds?.length ? defaultReplyRecipient(thread) : null),
      );
      const eligible = recipients?.length
        ? recipients
        : thread.participantIds || [threadAssistantId(s, thread.id)];
      const skills = (s.skills || []).filter((skill) =>
        eligible.every((id) => assistantSkills(s, id).some((x) => x.id === skill.id)),
      );
      const stopping = p.delivery === 'now' && !thread.participantIds && isStopMessage(text);
      const selectedApps = stopping ? [] : resolveChatApps(p.apps, appCatalog, eligible);
      const invocation = {
        ...skillInvocation({ ...s, skills }, text),
        ...(selectedApps.length ? { appContext: selectedApps } : {}),
      };
      const message = {
        id: uid('message'),
        threadId: thread.id,
        role: 'user',
        text,
        fileIds,
        ...(shares.some((x) => x.text)
          ? { sharedTexts: shares.filter((x) => x.text).map((x) => x.text) }
          : {}),
        createdAt: iso(),
        cards: [],
        ...invocation,
        ...(recipients ? { recipientIds: recipients } : {}),
        ...(quoted
          ? {
              quoted: {
                id: quoted.id,
                role: quoted.role,
                assistantId: quoted.assistantId,
                assistantName: quoted.assistantName,
                text: quoted.text.slice(0, 4000),
              },
            }
          : {}),
      };
      const steering =
        !stopping && p.delivery === 'now' && !thread.participantIds
          ? s.runs.find(
              (r) =>
                r.threadId === thread.id &&
                (voiceCall
                  ? ['queued', 'running'].includes(r.status) && r.voiceCallId === voiceCall.id
                  : r.status === 'running' && !r.voiceCallId) &&
                !(r.routineId && r.execution === 'reminder'),
            )
          : null;
      if (steering && (steering.steeringMessageIds?.length || 0) >= 32)
        throw Error(
          'This request has reached its follow-up limit. Queue this message or stop the current reply.',
        );
      if (steering) {
        message.steeringRunId = steering.id;
        steering.steeringMessageIds = [...(steering.steeringMessageIds || []), message.id];
        steering.partial = '';
      }
      s.messages.push(message);
      thread.draft = '';
      thread.draftFileIds = [];
      if (p.apps !== undefined) thread.draftApps = [];
      thread.draftShareIds = (thread.draftShareIds || []).filter(
        (id) => !shares.some((x) => x.id === id),
      );
      if (thread.participantIds) thread.draftRecipientIds = [];
      if (stopping) {
        result = requestChatStop(s, thread, message);
        break;
      }
      if (steering) {
        result = steering;
        break;
      }
      if (thread.participantIds) {
        result = groupRuns(s, thread, message, recipients, invocation);
        break;
      }
      const run = {
        id: uid('run'),
        threadId: thread.id,
        messageId: message.id,
        delivery: p.delivery || 'now',
        assistant: assistantSnapshot(s, thread.id),
        status: 'queued',
        createdAt: iso(),
        partial: '',
        leaseUntil: 0,
        ...invocation,
      };
      s.runs.push(run);
      result = run;
      if (
        !thread.replyTo &&
        thread.id !== 'main' &&
        ['New conversation', 'New side chat'].includes(thread.title)
      )
        thread.title = text.slice(0, 55);
      break;
    }
    case 'chat.stop': {
      result = stopReply(s, item(s.runs, p.id, 'Reply'));
      break;
    }
    case 'task.create':
      result = createTask(s, p);
      break;
    case 'task.action': {
      const t = item(s.tasks, p.id, 'Task');
      const transitions = {
        pause: { from: ['queued', 'running'], to: 'paused' },
        resume: { from: ['paused'], to: 'queued' },
        cancel: {
          from: ['queued', 'running', 'paused', 'needs_input', 'needs_approval'],
          to: 'cancelled',
        },
        retry: { from: ['failed', 'cancelled'], to: 'queued' },
      };
      const transition = transitions[p.action];
      if (!transition || !transition.from.includes(t.status))
        throw new Error(`Cannot ${p.action} a ${t.status.replaceAll('_', ' ')} task.`);
      if (
        p.action === 'cancel' &&
        s.approvals.some((a) => a.taskId === t.id && a.status === 'executing')
      )
        throw new Error('An approved action is already executing. Wait for its receipt.');
      t.status = transition.to;
      t.updatedAt = iso();
      t.leaseUntil = 0;
      t.leaseOwner = null;
      if (p.action === 'retry') {
        t.step = 0;
        t.error = '';
        t.attempt++;
        t.input = null;
        t.inputValues = null;
        t.approvalId = null;
        t.filledFileId = null;
      }
      if (['cancel', 'retry'].includes(p.action))
        for (const a of s.approvals.filter(
          (a) => a.taskId === t.id && ['pending', 'approved'].includes(a.status),
        ))
          a.status = 'rejected';
      result = t;
      break;
    }
    case 'task.input': {
      const t = item(s.tasks, p.id, 'Task');
      if (t.status !== 'needs_input') throw new Error('This task is not waiting for input.');
      const values = {};
      for (const field of t.input?.fields || []) {
        const v = p.values?.[field.name];
        if (field.required) required(v, field.label, 500);
        values[field.name] = String(v || '').slice(0, 500);
      }
      t.inputValues = values;
      t.status = 'queued';
      t.updatedAt = iso();
      result = t;
      break;
    }
    case 'approval.decide': {
      const a = item(s.approvals, p.id, 'Review');
      if (a.status !== 'pending') throw new Error('This action has already been reviewed.');
      if (a.expiresAt < Date.now()) throw new Error('This review expired. Prepare a new action.');
      if (!['approve', 'reject'].includes(p.decision)) throw new Error('Choose approve or reject.');
      if (
        a.connectionGeneration !== null &&
        (!s.connections.google.connected ||
          a.connectionGeneration !== s.connections.google.generation)
      )
        throw new Error('The connected account changed. Prepare a new action for review.');
      if (
        p.decision === 'approve' &&
        a.kind === 'calendar' &&
        a.payload.operation !== 'create' &&
        s.events.find((e) => e.id === a.payload.event.id)?.version !== a.payload.expectedVersion
      )
        throw new Error('The event changed since this review was prepared.');
      const t = a.taskId ? s.tasks.find((t) => t.id === a.taskId) : null;
      if (t && t.status === 'cancelled') throw new Error('This task was cancelled.');
      a.status = p.decision === 'approve' ? 'approved' : 'rejected';
      a.reviewedAt = iso();
      if (t && p.decision === 'reject') {
        t.status = 'cancelled';
        t.result = 'The proposed action was declined.';
      }
      result = a;
      break;
    }
    case 'goal.create': {
      const target = Number(p.target || 0),
        current = Number(p.current || 0);
      if (!Number.isFinite(target) || !Number.isFinite(current) || target < 0 || current < 0)
        throw new Error('Goal amounts must be positive numbers.');
      const g = {
        id: uid('goal'),
        title: required(p.title, 'Goal title', 140),
        description: String(p.description || '').slice(0, 1000),
        target,
        current,
        unit: String(p.unit || 'milestones').slice(0, 30),
        due: p.due || '',
        archived: false,
        milestones: (p.milestones || []).map((title) => ({
          id: uid('milestone'),
          title: required(title, 'Milestone', 180),
          done: false,
        })),
        createdAt: iso(),
      };
      s.goals.unshift(g);
      result = g;
      break;
    }
    case 'goal.update': {
      const g = item(s.goals, p.id, 'Goal');
      if (p.current !== undefined) {
        const n = Number(p.current);
        if (!Number.isFinite(n) || n < 0) throw new Error('Use a positive progress amount.');
        g.current = n;
      }
      if (p.title !== undefined) g.title = required(p.title, 'Goal title', 140);
      if (p.description !== undefined) g.description = String(p.description).slice(0, 1000);
      if (p.archived !== undefined) g.archived = !!p.archived;
      if (p.milestoneId) {
        const m = item(g.milestones, p.milestoneId, 'Milestone');
        m.done = !m.done;
      }
      if (p.addMilestone)
        g.milestones.push({
          id: uid('milestone'),
          title: required(p.addMilestone, 'Milestone', 180),
          done: false,
        });
      result = g;
      break;
    }
    case 'watch.create': {
      const kind = p.kind || 'change';
      if (!['change', 'text', 'price'].includes(kind))
        throw new Error('Choose change, text, or price tracking.');
      const threshold = Number(p.threshold);
      if (kind === 'price' && (!Number.isFinite(threshold) || threshold <= 0))
        throw new Error('Use a positive USD price threshold.');
      const url = p.url === 'relay://workshop' ? 'relay://workshop' : publicUrl(p.url);
      const w = {
        id: uid('watch'),
        title: required(p.title, 'Tracker name', 140),
        url,
        kind,
        expected: kind === 'text' ? required(p.expected, 'Text to look for', 300) : '',
        threshold: kind === 'price' ? threshold : 0,
        intervalMinutes: Math.max(1, Math.min(10080, Number(p.intervalMinutes) || 60)),
        paused: false,
        status: 'pending',
        failures: 0,
        lastHash: null,
        lastMatch: false,
        lastValue: '',
        nextCheck: 0,
        createdAt: iso(),
      };
      s.watches.unshift(w);
      result = w;
      break;
    }
    case 'watch.update': {
      const w = item(s.watches, p.id, 'Tracker');
      if (p.paused !== undefined) w.paused = !!p.paused;
      if (p.checkNow) w.nextCheck = 0;
      result = w;
      break;
    }
    case 'watch.delete': {
      item(s.watches, p.id, 'Tracker');
      s.watches = s.watches.filter((w) => w.id !== p.id);
      break;
    }
    case 'fixture.update': {
      s.fixture.available = !!p.available;
      s.fixture.price = Math.max(1, Number(p.price) || 89);
      s.fixture.text = s.fixture.available
        ? `Studio workshop: available now. Price: $${s.fixture.price.toFixed(2)}.`
        : 'The studio workshop is sold out.';
      result = s.fixture;
      break;
    }
    case 'file.add': {
      const mime = String(p.mime || 'application/octet-stream').slice(0, 120);
      const name = required(p.name, 'File name', 180).replace(/[\x00-\x1f/\\]/g, '_');
      const base64 = String(p.base64 || '');
      if (base64.length > 11_200_000 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(base64))
        throw new Error('Use a valid file smaller than 8 MB.');
      const f = {
        id: uid('file'),
        name,
        mime,
        base64,
        size: Math.floor((base64.length * 3) / 4),
        createdAt: iso(),
        source: 'Upload',
      };
      if (p.text !== undefined) f.text = String(p.text).slice(0, 2_000_000);
      else if (base64 && (mime.startsWith('text/') || mime === 'application/json')) {
        const text = new TextDecoder().decode(fromBase64(base64));
        f.text = text.slice(0, 2_000_000);
        if (text.length > f.text.length) f.textTruncated = true;
      }
      s.files.unshift(f);
      result = f;
      break;
    }
    case 'artifact.delete': {
      const artifact = item(s.artifacts || [], p.id, 'Result');
      const ids = new Set(artifact.versions.map((v) => v.fileId));
      if (
        s.tasks.some(
          (t) =>
            !['completed', 'failed', 'cancelled'].includes(t.status) &&
            (ids.has(t.fileId) || ids.has(t.filledFileId)),
        )
      )
        throw new Error('This result is in use by an unfinished task.');
      s.deletedArtifactOperations = [
        ...(s.deletedArtifactOperations || []),
        ...artifact.versions.map((v) => v.operationId),
      ].slice(-1000);
      s.artifacts = s.artifacts.filter((a) => a.id !== p.id);
      s.files = s.files.filter((f) => !ids.has(f.id));
      result = true;
      break;
    }
    case 'file.edit': {
      const f = item(s.files, p.id, 'File');
      if (f.artifactId) throw new Error('Open this result to save an editable new version.');
      if (!f.mime.startsWith('text/') && !['application/json'].includes(f.mime))
        throw new Error('This file cannot be edited as text.');
      f.text = String(p.text || '').slice(0, 2_000_000);
      f.base64 = '';
      delete f.textTruncated;
      f.size = new TextEncoder().encode(f.text).length;
      f.updatedAt = iso();
      result = f;
      break;
    }
    case 'file.delete': {
      const file = item(s.files, p.id, 'File');
      if (file.artifactId) throw new Error('Generated versions are kept with their result.');
      if (
        s.tasks.some(
          (t) =>
            !['completed', 'failed', 'cancelled'].includes(t.status) &&
            (t.fileId === p.id || t.filledFileId === p.id),
        )
      )
        throw new Error('This file is in use by an unfinished task.');
      s.files = s.files.filter((f) => f.id !== p.id);
      result = true;
      break;
    }
    case 'finance.import': {
      s.transactions = importTransactions(p.csv);
      s.financeName = required(p.name || 'Imported transactions', 'Import name', 140);
      result = { count: s.transactions.length };
      break;
    }
    case 'finance.category': {
      const t = item(s.transactions, p.id, 'Transaction');
      t.category = required(p.category, 'Category', 80);
      result = t;
      break;
    }
    case 'mail.read': {
      const m = item(s.mail, p.id, 'Email');
      m.read = true;
      result = m;
      break;
    }
    case 'mail.prepare': {
      const to = required(p.to, 'Recipient', 250);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || /[\r\n]/.test(to))
        throw new Error('Enter a valid email address.');
      const subject = required(p.subject, 'Subject', 200);
      if (/[\r\n]/.test(subject)) throw new Error('The subject must be on one line.');
      const body = required(p.body, 'Reply', 16000);
      const attachments = (p.attachmentIds || []).slice(0, 8);
      attachments.forEach((id) => item(s.files, id, 'Attachment'));
      result = createApproval(s, {
        kind: 'email',
        title: `Send “${subject}”`,
        payload: { to, subject, body, attachmentIds: attachments, replyTo: p.replyTo || '' },
        sourceId: p.replyTo || '',
        connectionGeneration: s.connections.google.connected
          ? s.connections.google.generation
          : null,
      });
      break;
    }
    case 'calendar.prepare': {
      if (!['create', 'update', 'delete'].includes(p.operation))
        throw new Error('Choose a supported calendar action.');
      const existing = p.operation !== 'create' && p.id ? item(s.events, p.id, 'Event') : null;
      let event;
      if (p.operation !== 'create' && !existing) throw new Error('Choose the event to change.');
      if (existing?.recurring)
        throw new Error('Change recurring events directly in Google Calendar.');
      if (p.operation === 'delete') event = structuredClone(existing);
      else {
        const start = new Date(p.start),
          end = new Date(p.end);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start)
          throw new Error('The end of the event must be after its start.');
        if (
          p.allDay &&
          (!/^\d{4}-\d{2}-\d{2}$/.test(p.start) ||
            !/^\d{4}-\d{2}-\d{2}$/.test(p.end) ||
            start.toISOString().slice(0, 10) !== p.start ||
            end.toISOString().slice(0, 10) !== p.end)
        )
          throw new Error('All-day events need valid date-only values.');
        event = {
          ...existing,
          id: existing?.id || uid('event'),
          calendarId:
            existing?.calendarId ||
            String(p.calendarId || s.connections.google.calendarId || 'primary').slice(0, 250),
          title: required(p.title, 'Event title', 180),
          start: p.allDay ? start.toISOString().slice(0, 10) : start.toISOString(),
          end: p.allDay ? end.toISOString().slice(0, 10) : end.toISOString(),
          allDay: !!p.allDay,
          location: String(p.location || '').slice(0, 300),
          description: String(p.description || '').slice(0, 4000),
          version: (existing?.version || 0) + 1,
        };
      }
      result = createApproval(s, {
        kind: 'calendar',
        title: `${p.operation === 'delete' ? 'Delete' : p.operation === 'update' ? 'Update' : 'Create'} “${event.title}”`,
        payload: { operation: p.operation, event, expectedVersion: existing?.version || 0 },
        connectionGeneration: s.connections.google.connected
          ? s.connections.google.generation
          : null,
      });
      break;
    }
    case 'profile.update': {
      if (p.name !== undefined) s.profile.name = String(p.name).trim().slice(0, 80);
      if (p.assistantName !== undefined)
        s.profile.assistantName = required(p.assistantName, 'Assistant name', 40);
      if (p.avatarColor !== undefined) {
        if (!/^#[0-9a-f]{6}$/i.test(p.avatarColor)) throw new Error('Use a valid hex color.');
        s.profile.avatarColor = p.avatarColor;
      }
      if (p.timeZone !== undefined) {
        try {
          new Intl.DateTimeFormat('en', { timeZone: p.timeZone });
        } catch {
          throw new Error('Use a valid IANA time zone.');
        }
        s.profile.timeZone = p.timeZone;
      }
      if (p.tone !== undefined) s.profile.tone = required(p.tone, 'Response style', 300);
      if (p.notificationMode !== undefined)
        s.profile.notificationMode = notificationMode(p.notificationMode);
      if (p.notifications !== undefined) s.profile.notifications = !!p.notifications;
      if (p.memoryLearning !== undefined) {
        if (typeof p.memoryLearning !== 'boolean')
          throw new Error('Choose whether to learn from chats.');
        if (s.profile.memoryLearning !== p.memoryLearning) {
          s.profile.memoryLearning = p.memoryLearning;
          memoryControlChanged(s);
        }
      }
      if (['light', 'dark', 'system'].includes(p.theme)) s.profile.theme = p.theme;
      if (['assistantName', 'tone', 'avatarColor'].some((key) => p[key] !== undefined))
        s.profile.assistantRevision = (s.profile.assistantRevision || 1) + 1;
      result = s.profile;
      break;
    }
    case 'memory.add': {
      const text = required(p.text, 'Memory', 500);
      const type = p.type === 'dismissed-idea' ? 'dismissed-idea' : 'note';
      const assistantId =
        p.assistantId ||
        (p.sourceMessageId
          ? threadAssistantId(s, item(s.messages, p.sourceMessageId, 'Source message').threadId)
          : 'relay');
      assistantProfile(s, assistantId);
      if (
        p.sourceMessageId &&
        !acceptsAssistant(
          s,
          item(s.messages, p.sourceMessageId, 'Source message').threadId,
          assistantId,
        )
      )
        throw new Error('Use a source message from this assistant’s chats.');
      const existing = s.memories.find(
        (m) =>
          memoryAssistantId(m) === assistantId &&
          m.type === type &&
          m.text.toLocaleLowerCase() === text.toLocaleLowerCase(),
      );
      if (existing) {
        if (type === 'note') {
          existing.origin = 'manual';
          delete existing.proposal;
          memoryControlChanged(s, assistantId);
        }
        result = existing;
        break;
      }
      const source = p.sourceMessageId
        ? item(s.messages, p.sourceMessageId, 'Source message')
        : null;
      const m = {
        id: uid('memory'),
        text,
        type,
        ...(assistantId !== 'relay' ? { assistantId } : {}),
        origin: 'manual',
        sourceMessageId: source?.id || '',
        sourceThreadId: source?.threadId || '',
        createdAt: iso(),
      };
      s.memories.unshift(m);
      if (type === 'note') memoryControlChanged(s, assistantId);
      result = m;
      break;
    }
    case 'memory.update': {
      const m = item(s.memories, p.id, 'Memory');
      if (m.type !== 'note') throw new Error('Suggestion preferences can be removed, not edited.');
      m.text = required(p.text, 'Memory', 500);
      m.updatedAt = iso();
      m.origin = 'manual';
      delete m.proposal;
      memoryControlChanged(s, memoryAssistantId(m));
      result = m;
      break;
    }
    case 'memory.delete': {
      result = item(s.memories, p.id, 'Memory');
      s.memories = s.memories.filter((m) => m.id !== p.id);
      if (result.type === 'note') memoryControlChanged(s, memoryAssistantId(result));
      break;
    }
    case 'memory.resolve':
      result = resolveMemory(s, p);
      break;
    case 'attention.read':
      return attentionCommand(s, p);
    case 'notification.read': {
      if (p.id) item(s.notifications, p.id, 'Notification').read = true;
      else s.notifications.forEach((n) => (n.read = true));
      break;
    }
    case 'idea.settings':
      result = configureIdeas(s, p.mode);
      break;
    case 'idea.restore':
      result = restoreIdea(s, p.id);
      break;
    case 'idea.accept': {
      const state = ideaState(s);
      const accepted = state.accepted.find((item) => item.id === p.id);
      if (accepted) {
        result = { runId: accepted.runId, threadId: 'main' };
        break;
      }
      const idea = visibleIdeas(s).find((item) => item.id === p.id);
      if (!idea) throw new Error('This suggestion changed or expired. Check for new ideas.');
      const request = required(p.text, 'Request', 4000);
      const thread = item(s.threads, 'main', 'Main chat'),
        draft = thread.draft;
      const run = command(s, 'chat.send', { threadId: 'main', text: request }, true);
      thread.draft = draft;
      run.ideaId = idea.id;
      run.ideaContext = idea.sources.map(({ ref, title, quote }) => ({ ref, title, quote }));
      const message = s.messages.find((m) => m.id === run.messageId);
      message.ideaId = idea.id;
      state.accepted.push({
        id: idea.id,
        runId: run.id,
        topic: idea.topic,
        title: idea.title,
        refs: idea.sources.map((source) => source.ref),
      });
      state.accepted = state.accepted.slice(-1000);
      state.items = state.items.filter((item) => item.id !== idea.id);
      result = { runId: run.id, threadId: 'main' };
      break;
    }
    case 'idea.dismiss':
      result = p.id?.startsWith('suggestion-')
        ? dismissIdea(s, p.id)
        : command(s, 'memory.add', { text: p.id, type: 'dismissed-idea' });
      break;
    case 'terminal.prepare':
      result = createApproval(s, {
        kind: 'terminal',
        title: 'Run a workspace command',
        payload: { command: required(p.command, 'Command', 2000) },
      });
      break;
    default:
      throw new Error(`Unknown workspace action: ${action}`);
  }
  if (!deferPrune) pruneIdeas(s);
  s.revision++;
  return result;
}
export function completeApproval(s, id, result = {}) {
  const a = item(s.approvals, id, 'Review');
  if (!['approved', 'executing'].includes(a.status))
    throw new Error('This action is not approved.');
  const sameAccount =
    a.connectionGeneration === null || a.connectionGeneration === s.connections.google.generation;
  if (a.kind === 'email' && sameAccount) {
    const m = {
      id: result.messageId || uid('mail'),
      from: s.profile.name || 'You',
      email: a.accountEmail || 'you@example.invalid',
      to: a.payload.to,
      subject: a.payload.subject,
      body: a.payload.body,
      date: iso(),
      read: true,
      folder: 'sent',
      attachmentIds: a.payload.attachmentIds,
    };
    s.mail.unshift(m);
  } else if (a.kind === 'calendar' && sameAccount) {
    const { operation, event, expectedVersion } = a.payload;
    const existing = s.events.find((e) => e.id === event.id);
    if (
      operation !== 'create' &&
      existing?.version !== expectedVersion &&
      a.connectionGeneration === null
    )
      throw new Error('The event changed since this review was prepared.');
    if (operation === 'delete') s.events = s.events.filter((e) => e.id !== event.id);
    else if (existing) Object.assign(existing, event, result.event || {});
    else s.events.push({ ...event, ...result.event });
  }
  a.status = 'completed';
  a.completedAt = iso();
  const r = receipt(s, a.kind, a.title, result.detail || 'Approved action completed.', a.sourceId, {
    approvalId: a.id,
    accountEmail: a.accountEmail,
    ...result,
  });
  if (a.taskId) {
    const t = item(s.tasks, a.taskId, 'Task');
    t.status = 'completed';
    t.step = t.plan.length;
    t.result = result.detail || 'Completed after your review.';
    t.updatedAt = iso();
    t.leaseUntil = 0;
  }
  notify(s, 'Action completed', a.title, a.kind === 'terminal' ? 'computer' : 'activity');
  s.revision++;
  return r;
}
export function recordObservation(s, id, text, error = '') {
  const w = s.watches.find((w) => w.id === id);
  if (!w || w.paused) return;
  w.lastChecked = iso();
  if (error) {
    w.failures++;
    w.status = 'error';
    w.error = error;
    w.nextCheck =
      Date.now() + Math.min(24 * 60, w.intervalMinutes * 2 ** Math.min(w.failures, 8)) * 60000;
    s.revision++;
    return;
  }
  const normalized = text.replace(/\s+/g, ' ').trim();
  let hash = 2166136261;
  for (const ch of normalized) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const fingerprint = (hash >>> 0).toString(16);
  let match = false,
    value = normalized.slice(0, 300);
  if (w.kind === 'change') match = w.lastHash !== null && fingerprint !== w.lastHash;
  if (w.kind === 'text') match = normalized.toLowerCase().includes(w.expected.toLowerCase());
  if (w.kind === 'price') {
    const amount = normalized.match(/(?:USD\s*|\$)(\d[\d,]*(?:\.\d{1,2})?)/i);
    if (!amount) {
      recordObservation(s, id, '', 'No USD price was found on this page.');
      return;
    }
    value = Number(amount[1].replaceAll(',', ''));
    match = value <= w.threshold;
  }
  const alert = w.kind === 'change' ? match : match && !w.lastMatch;
  if (alert)
    notify(
      s,
      w.kind === 'price'
        ? 'Your price target was reached'
        : w.kind === 'text'
          ? 'The text you are watching appeared'
          : 'The page changed',
      `${w.title}: ${typeof value === 'number' ? `$${value.toFixed(2)}` : value.slice(0, 120)}`,
      'goals',
    );
  w.lastHash = fingerprint;
  w.lastMatch = match;
  w.lastValue = value;
  w.status = 'watching';
  w.failures = 0;
  w.error = '';
  w.nextCheck = Date.now() + w.intervalMinutes * 60000;
  s.revision++;
}
