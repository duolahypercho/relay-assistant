import { steeringContext } from './steering.mjs';
import { runAppContext } from './app-mentions.mjs';
import { assistantSnapshot, acceptsAssistant } from './assistant-scope.mjs';
// SPDX-License-Identifier: MIT
import { uid, iso } from './seed.mjs';

function text(value, label, limit) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit)
    throw new Error(`${label} must be between 1 and ${limit} characters.`);
  return value.trim();
}

// Model output is a proposal until the worker commits it with its assistant message.
export function questionProposal(p) {
  const prompt = text(p.prompt, 'Question', 600);
  const supplied = p.options === undefined ? [] : p.options;
  if (!Array.isArray(supplied) || supplied.length === 1 || supplied.length > 5)
    throw new Error('Ask for a text answer, or offer between two and five choices.');
  const options = supplied.map((o, index) => ({
    id: String(index + 1),
    label: text(o?.label, 'Choice', 100),
    description: o?.description ? text(o.description, 'Choice description', 240) : '',
  }));
  if (new Set(options.map((o) => o.label.toLowerCase())).size !== options.length)
    throw new Error('Each choice must be different.');
  return { prompt, options };
}

export function attachQuestion(s, run, proposal, message) {
  s.questions ||= [];
  const original = s.messages.find((m) => m.id === run.messageId);
  const origin = run.questionContext?.origin || {
    assistant: run.assistant || assistantSnapshot(s, run.threadId),
    request: run.routineId ? run.instructions : original?.text || '',
    fileIds: original?.fileIds || [],
    appContext: structuredClone(runAppContext(run)),
    skill: run.skill || null,
    skillInput: run.skillInput || '',
    handoffId: run.handoffId,
    routineTitle: run.routineTitle || '',
    restrictedRoutine: !!run.routineId || !!run.handoffRestricted,
    mailSource: run.mailSource || null,
    templateContext: run.templateContext || null,
    ideaContext: run.ideaContext || null,
    connectionGeneration: run.connectionGeneration ?? null,
  };
  const question = {
    id: uid('question'),
    ...questionProposal(proposal),
    threadId: run.threadId,
    sourceRunId: run.id,
    handoffId: run.handoffId,
    messageId: message.id,
    origin: { ...structuredClone(origin), steering: steeringContext(s, run) },
    previousAnswers: structuredClone(run.questionContext?.answers || []),
    status: 'pending',
    createdAt: iso(),
  };
  s.questions.push(question);
  message.cards.push({ kind: 'question', id: question.id });
  return question;
}

export function questionAnswerContext(s, q, answer) {
  const thread = s.threads.find((t) => t.id === q.threadId);
  if (!thread || thread.archived) throw new Error('Restore this conversation before answering.');
  if (q.origin.assistant && !acceptsAssistant(s, q.threadId, q.origin.assistant.id))
    throw new Error('The assistant who asked is no longer in this conversation.');
  if (q.origin.connectionGeneration != null) {
    const google = s.connections.google;
    if (!google.connected || google.generation !== q.origin.connectionGeneration)
      throw new Error(
        'The connected account changed. Start a new request with the current account.',
      );
  }
  return {
    origin: structuredClone(q.origin),
    answers: [...q.previousAnswers, { prompt: q.prompt, answer }],
  };
}

export function questionCommand(s, action, p) {
  const q = (s.questions || []).find((q) => q.id === p.id);
  if (!q) throw new Error('This question was not found.');
  if (action === 'question.dismiss') {
    if (q.status === 'answered') throw new Error('This question has already been answered.');
    q.status = 'dismissed';
    q.dismissedAt ||= iso();
    s.revision++;
    return q;
  }
  if (action !== 'question.answer') throw new Error('Unknown question action.');
  const hasChoice = p.optionId !== undefined;
  if (hasChoice && p.text !== undefined) throw new Error('Choose an option or write an answer.');
  const option = hasChoice && q.options.find((o) => o.id === p.optionId);
  if (hasChoice && !option) throw new Error('Choose one of the available answers.');
  const answer = option ? option.label : text(p.text, 'Answer', 4000);
  if (q.status === 'answered') {
    if (q.answer === answer && q.optionId === (option?.id || null))
      return s.runs.find((r) => r.id === q.answerRunId);
    throw new Error('This question has already been answered. Send an adjustment in chat.');
  }
  if (q.status !== 'pending')
    throw new Error('This question was dismissed. Send a new request in chat.');
  const context = questionAnswerContext(s, q, answer);
  const thread = s.threads.find((t) => t.id === q.threadId);
  // Queue a literal answer, not a slash command; leave the unrelated composer draft untouched.
  const message = {
    id: uid('message'),
    threadId: q.threadId,
    role: 'user',
    text: answer,
    fileIds: [],
    cards: [],
    createdAt: iso(),
    questionId: q.id,
    handoffId: q.handoffId,
    ...(thread.participantIds ? { recipientIds: [q.origin.assistant.id] } : {}),
    questionContext: structuredClone(context),
  };
  const run = {
    id: uid('run'),
    threadId: q.threadId,
    messageId: message.id,
    assistant: structuredClone(q.origin.assistant || assistantSnapshot(s, q.threadId)),
    status: 'queued',
    createdAt: iso(),
    partial: '',
    leaseUntil: 0,
    questionContext: context,
    handoffId: q.handoffId || q.origin.handoffId,
    connectionGeneration: q.origin.connectionGeneration,
    modelConnection: structuredClone(s.runs.find((r) => r.id === q.sourceRunId)?.modelConnection),
  };
  s.messages.push(message);
  s.runs.push(run);
  Object.assign(q, {
    status: 'answered',
    answer,
    optionId: option?.id || null,
    answeredAt: iso(),
    answerRunId: run.id,
    answerMessageId: message.id,
  });
  s.revision++;
  return run;
}
