import { assistantMemories, threadAssistantId, profileSnapshot } from './assistant-scope.mjs';
// SPDX-License-Identifier: MIT
import { attachQuestion } from './questions.mjs';
import { command, createTask } from './domain.mjs';
import { iso, uid } from './seed.mjs';
import { summarizeTransactions } from './finance.mjs';
import { requestedSurface, surfaces } from './surfaces.mjs';
const money = (n) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n / 100);
export function sampleRunReply(s, run) {
  if (run.questionContext) {
    const { origin, answers } = run.questionContext;
    const request = `${origin.request}\n\n${answers.map((a) => `${a.prompt}\n${a.answer}`).join('\n\n')}`;
    if (origin.restrictedRoutine)
      return {
        text: 'Your answer is saved with the routine’s original request. Connect a model provider to continue this work.',
        cards: [],
      };
    return sampleRespond(
      s,
      request,
      run.threadId,
      origin.fileIds,
      run.messageId,
      run.assistant?.id,
    );
  }
  const source = s.messages.find((m) => m.id === run.messageId);
  if (
    !run.routineId &&
    !run.skill &&
    /^help me (?:plan|organize) (?:my )?(?:day|week|weekend)[.!?]*$/i.test(source?.text || '')
  )
    return {
      text: 'What would you like to make room for? Pick one, or tell me in your own words. I’ll use it in your sample plan.',
      cards: [],
      question: {
        prompt: 'What matters most for this plan?',
        options: [
          { label: 'Focus on one thing', description: 'Leave space for your most important task.' },
          {
            label: 'Make time to rest',
            description: 'Keep the pace gentle, with room to recharge.',
          },
          { label: 'A bit of both', description: 'Balance a small win with some breathing room.' },
        ],
      },
    };
  if (run.routineId && run.execution === 'reminder') return { text: run.instructions, cards: [] };
  if (run.mailSource)
    return {
      text: `Sample email trigger · ${run.routineTitle}\n\nMatched “${run.mailSource.subject}” from ${run.mailSource.email}. The email and your saved instructions are attached to this run. Connect a model provider to carry out the instructions. No email was sent.`,
      cards: [],
    };
  const message = s.messages.find((m) => m.id === run.messageId);
  const input = run.routineId ? run.instructions : run.skill ? run.skillInput : message?.text;
  const response = sampleRespond(
    s,
    run.skill ? `${run.skill.instructions}\n${input || ''}` : input || '',
    run.threadId,
    message?.fileIds || [],
    run.messageId,
    run.assistant?.id,
  );
  if (run.skill) response.text = `Sample skill run · ${run.skill.title}\n\n${response.text}`;
  return response;
}
export function sampleRespond(
  s,
  text,
  threadId = 'main',
  fileIds = [],
  sourceMessageId = '',
  assistantId = threadAssistantId(s, threadId),
) {
  const lower = text.toLowerCase();
  let response = { text: '', cards: [] };
  const surface = requestedSurface(text);
  if (surface) {
    response = { text: surfaces[surface].text, cards: [{ kind: 'workspace', page: surface }] };
  } else if (/^forget\s+/i.test(text)) {
    const query = text
      .replace(/^forget\s+(?:that\s+)?/i, '')
      .trim()
      .toLowerCase();
    const matches = assistantMemories(s, assistantId).filter(
      (m) => m.type === 'note' && m.text.toLowerCase().includes(query),
    );
    if (matches.length === 1) {
      command(s, 'memory.delete', { id: matches[0].id });
      response = {
        text: 'I’ve removed that saved memory. It is no longer included in my personal context. The original message stays in your chat history.',
        cards: [{ kind: 'navigation', page: 'settings', title: 'Review your memories' }],
      };
    } else
      response = {
        text: 'Choose the memory to forget from My memories, so I remove the right one.',
        cards: [{ kind: 'navigation', page: 'settings', title: 'Review your memories' }],
      };
  } else if (/(?:remember|keep in mind)\s+(.+)/i.test(text)) {
    const memory = command(s, 'memory.add', {
      text: text.replace(/^.*?(?:remember|keep in mind)\s+/i, ''),
      sourceMessageId,
      assistantId,
    });
    response = {
      text: 'I’ll keep that in mind. You can review, edit, or forget it in My memories.',
      cards: [{ kind: 'memory', id: memory.id }],
    };
  } else if (/form|permission|pdf|slip/.test(lower)) {
    const file =
      s.files.find((f) => fileIds.includes(f.id) && f.mime === 'application/pdf') ||
      s.files.find((f) => f.mime === 'application/pdf');
    const source = s.mail.find((m) => m.attachmentIds?.includes(file?.id) && m.folder === 'inbox');
    if (!file)
      response = {
        text: 'Attach a PDF here and ask me to fill it. Editable form fields are supported; scanned forms need an external editor.',
        cards: [{ kind: 'workspace', page: 'files' }],
      };
    else {
      const task = createTask(s, {
        title: 'Complete the permission form',
        description: text,
        kind: 'document',
        sourceId: source?.id || '',
        threadId,
      });
      task.fileId = file.id;
      response = {
        text: 'I’ll open the form, ask for the missing details, and prepare a filled copy. You’ll review the reply before it is sent.',
        cards: [{ kind: 'task', id: task.id }],
      };
    }
  } else if (/spend|financ|transaction|budget/.test(lower)) {
    const summary = summarizeTransactions(s.transactions);
    if (!summary.count)
      response = {
        text: 'Add your transaction CSV here. Use negative amounts for expenses and positive amounts for income.',
        cards: [{ kind: 'workspace', page: 'finance' }],
      };
    else {
      const task = createTask(s, {
        title: 'A clearer view of your spending',
        description: text,
        kind: 'finance',
        sourceId: 'finance-review',
        threadId,
      });
      response = {
        text: `Your import shows ${money(summary.expenses)} in spending and ${money(summary.income)} in income. ${summary.categories[0]?.name || 'Other'} is the largest spending category. I’ll save a spending note.`,
        cards: [
          { kind: 'finance', summary },
          { kind: 'task', id: task.id },
        ],
      };
    }
  } else if (/calendar|meeting|design review|schedule/.test(lower)) {
    response = {
      text: `You have ${s.events.length} event${s.events.length === 1 ? '' : 's'} in this workspace. Choose a time below. I’ll show the details for review before changing anything.`,
      cards: [{ kind: 'workspace', page: 'calendar' }],
    };
  } else if (/mail|inbox|email|messages/.test(lower)) {
    const messages = s.mail.filter((m) => m.folder === 'inbox');
    response = {
      text: `There are ${messages.filter((m) => !m.read).length} unread messages in your ${s.connections.google.connected ? 'connected' : 'sample'} inbox. Here are the latest threads.`,
      cards: messages.slice(0, 4).map((m) => ({ kind: 'email', id: m.id })),
    };
  } else if (/goal|milestone|save|saving/.test(lower)) {
    response = {
      text: 'Keep the next step small enough to do. Your progress and next steps are here.',
      cards: [{ kind: 'workspace', page: 'goals' }],
    };
  } else if (/https?:\/\/\S+/.test(text) || /research|browse|summariz/.test(lower)) {
    const task = createTask(s, {
      title: text.slice(0, 100),
      description: text,
      kind: 'research',
      threadId,
    });
    response = {
      text: 'I’ve created a research task. A self-hosted browser can read public sources, and a configured model can produce a sourced result.',
      cards: [{ kind: 'task', id: task.id }],
    };
  } else if (/plan|task|help me|make|create|organize|write|draft/.test(lower)) {
    const task = createTask(s, {
      title: text.slice(0, 100),
      description: text,
      kind: 'general',
      threadId,
    });
    response = {
      text: 'I’ll keep the task here so you can follow its steps, pause it, and come back to the result.',
      cards: [{ kind: 'task', id: task.id }],
    };
  } else
    response = {
      text: `${s.profile.name ? `Hi ${s.profile.name}. ` : ''}This workspace is using the sample assistant. I can work with your files, spending, mailbox, calendar, goals and memories. For open-ended reasoning, configure a model provider on the included server.`,
      cards: [],
    };
  for (const card of response.cards)
    if (card.kind === 'task') {
      const task = s.tasks.find((t) => t.id === card.id);
      if (task) {
        task.assistantId = assistantId;
        task.assistant = profileSnapshot(s, assistantId);
      }
    }
  return response;
}
/** @param {any} [run] */
export function appendAssistant(s, threadId, response, extra = {}, run = null) {
  const { question, ...content } = response;
  const m = {
    id: uid('message'),
    threadId,
    role: 'assistant',
    assistantId: run?.assistant?.id || threadAssistantId(s, threadId),
    assistantName: run?.assistant?.name,
    ...(run ? { runId: run.id, handoffId: run.handoffId } : {}),
    createdAt: iso(),
    ...(run?.modelConnection?.display && !extra.error
      ? {
          modelBackup: {
            name: run.modelConnection.display.name,
            model: run.modelConnection.display.model,
          },
        }
      : {}),
    ...content,
    cards: [...(content.cards || [])],
    ...extra,
  };
  if (question && run) attachQuestion(s, run, question, m);
  s.messages.push(m);
  s.revision++;
  return m;
}
export function taskReport(s, t) {
  if (t.kind === 'finance') {
    const a = summarizeTransactions(s.transactions);
    return `# A clearer view of your spending\n\nBased on ${a.count} transactions from ${s.financeName || 'your import'}.\n\n- Income: ${money(a.income)}\n- Expenses: ${money(a.expenses)}\n- Remaining: ${money(a.net)}\n\n## Spending by category\n\n${a.categories.map((c) => `- ${c.name}: ${money(c.cents)} (${c.percent.toFixed(1)}%)`).join('\n')}\n\n## A practical next step\n\nChoose one recurring expense to review. Then decide how much of the remaining ${money(a.net)} you want to put toward your saving goal. These totals cover the import only.\n`;
  }
  return `# ${t.title}\n\n## The outcome\n\n${t.description}\n\n## A working plan\n\n1. Define what a successful result looks like.\n2. Gather relevant documents and sources.\n3. Break the work into concrete steps.\n4. Review decisions that affect other people.\n5. Save the result and the next action.\n\n${
    t.kind === 'research'
      ? '## Sources\n\nThis sample plan has not read external sources. Use the self-hosted browser and a configured model for live research.'
      : '## Your context\n\n' +
        (assistantMemories(s, t.assistantId || 'relay')
          .filter((m) => m.type === 'note')
          .map((m) => `- ${m.text}`)
          .join('\n') || 'Add relevant preferences in Settings or attach a file.')
  }\n`;
}
