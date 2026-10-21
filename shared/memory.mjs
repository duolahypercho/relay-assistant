// SPDX-License-Identifier: MIT
import { uid, iso } from './seed.mjs';
import { assistantMemoryControls, runAssistantId, memoryAssistantId } from './assistant-scope.mjs';

const normalized = (text) => text.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
// With automatic learning off, only a direct save command opens the chat save
// action. Keep this deliberately narrow; My memories accepts any language.
export function explicitMemoryRequest(source) {
  if (!source || source.role !== 'user' || source.delegation || source.skill || source.appTemplate)
    return false;
  return /(?:^|[.!?。！？]\s*)(?:(?:please|can you|could you)\s+)?(?:remember\b|save (?:this|that|my)\b[^\n.!?]{0,100}\b(?:memory|memories)\b|keep (?:this|that) in mind\b)|(?:^|[.!?。！？]\s*)(?:请|帮我|请帮我)?(?:记住|记下|保存到记忆)/iu.test(
    source.text || '',
  );
}
// Conservative eligibility screening, not fact extraction. Ordinary questions
// and task instructions need no extra inference. The model still selects and
// quotes a fact; these English/Chinese forms do not cover every language.
export function mayContainMemoryStatement(source) {
  if (explicitMemoryRequest(source)) return true;
  if (!source || source.role !== 'user' || source.delegation || source.skill || source.appTemplate)
    return false;
  return /(?:^|[.!?。！？]\s*)(?:for [^.!?\n]{0,80},\s*)?(?:i\s+(?:(?:now|usually|always|generally|really)\s+)?(?:prefer|like|love|dislike|avoid|live|work|speak|am)\b|my\s+[^.!?\n]{0,60}\b(?:preference|preferences|name|birthday|timezone|time zone)\s+(?:is|are|has|have)\b|我(?:现在|通常|一直|更)?(?:喜欢|偏好|不喜欢|住在|工作|是|叫)|我的[^。！？\n]{0,30}(?:偏好|名字|生日|时区)(?:是|改|变)(?!什么|哪|谁|多少|怎么))/iu.test(
    source.text || '',
  );
}
export function explicitForgetRequest(source) {
  if (!source || source.role !== 'user' || source.delegation || source.skill || source.appTemplate)
    return false;
  return /(?:^|[.!?。！？]\s*)(?:(?:please|can you|could you)\s+)?(?:forget\b|(?:remove|delete)\b[^\n.!?]{0,120}\b(?:memory|memories|preference|preferences|saved (?:personal )?notes?)\b)|(?:^|[.!?。！？]\s*)(?:请|帮我|请帮我)?(?:忘记|忘掉|删除(?:我的)?(?:所有|全部)?(?:已保存的)?(?:个人)?(?:记忆|偏好))/iu.test(
    source.text || '',
  );
}
// Presentation-only acknowledgments do not change the requested memory operation.
// Preserve every substantive clause, including negations and later corrections.
export function memoryForgetRequestText(source) {
  return (source?.text || '')
    .trim()
    .replace(
      /[.!。！]\s*(?:acknowledge|confirm|reply)(?: (?:it|this))?(?: in one sentence| briefly)?[.!]?$/iu,
      '',
    )
    .trim();
}
// This selector receives the current message, not a resolved conversational
// referent. Bare references must ask for a subject instead of guessing a note.
export function unclearForgetTarget(source) {
  if (!explicitForgetRequest(source)) return false;
  return (
    /^(?:(?:please|can you|could you)\s+)?(?:forget|delete|remove)\s+(?:(?:it|this|that|these|those)(?:\s+(?:saved\s+)?(?:personal\s+)?(?:memory|memories|note|notes|preference|preferences))?(?:\s+(?:I|we|you)\s+(?:might|may|could)\s+(?:change|update|revise|reconsider)(?:\s+(?:later|someday|one day|in the future))?)?|(?:the\s+)?(?:memory|memories|note|notes|preference|preferences|one|ones)\s+(?:we\s+(?:discussed|talked about)|you\s+(?:saved|mentioned)))[.!?]*$/iu.test(
      source.text.trim(),
    ) ||
    /^(?:请|帮我|请帮我)?(?:忘记|忘掉|删除)(?:它|这个|那个|这些|那些)(?:已保存的)?(?:记忆|偏好)?[。！.!?？]*$/u.test(
      source.text.trim(),
    )
  );
}
function text(value, name, limit = 500) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit)
    throw new Error(`${name} must contain 1–${limit} characters.`);
  return value.trim();
}
export function memoryControlChanged(s, assistantId = 'relay') {
  const controls = assistantMemoryControls(s, assistantId);
  controls.memoryControlVersion = (controls.memoryControlVersion || 0) + 1;
  // Owner changes invalidate pending extraction and old conversations. New
  // messages can still teach a preference after learning is re-enabled.
  controls.memoryLearnAfter = s.messages.length;
}
export function memoryRequestSource(s, { runId, sourceMessageId, threadId } = {}) {
  const run = s.runs.find((r) => r.id === runId);
  const assistantId = runAssistantId(s, run || { threadId });
  const sourceIndex = s.messages.findIndex((m) => m.id === sourceMessageId);
  const source = s.messages[sourceIndex];
  if (
    !run ||
    !['queued', 'running'].includes(run.status) ||
    (run.activeMessageId || run.messageId) !== sourceMessageId ||
    run.threadId !== threadId ||
    run.routineId ||
    run.ideaId ||
    run.questionContext?.origin.ideaContext ||
    run.mailSource ||
    run.questionContext?.origin.restrictedRoutine ||
    !source ||
    source.role !== 'user' ||
    source.delegation ||
    source.appTemplate ||
    source.threadId !== threadId ||
    source.skill ||
    !s.threads.some((t) => t.id === threadId && !t.archived)
  )
    throw new Error('Use only the owner’s message in this active conversation.');
  return { run, source, sourceIndex, assistantId };
}
function currentMemoryControls(s, context, request) {
  const controls = assistantMemoryControls(s, request.assistantId);
  if (context.controlVersion !== (controls.memoryControlVersion || 0))
    throw new Error('Memory controls changed. Read the current memories before continuing.');
  return controls;
}
function checkSourceAge(controls, request) {
  if (request.sourceIndex < (controls.memoryLearnAfter || 0))
    throw new Error('This message predates the latest memory control change.');
}
export function memoryLearningSource(s, context = {}) {
  const request = memoryRequestSource(s, context);
  const controls = currentMemoryControls(s, context, request);
  // Tool arguments cannot opt into the host's explicit-save path.
  if (
    controls.memoryLearning === false &&
    !(context.allowExplicitSave === true && explicitMemoryRequest(request.source))
  )
    throw new Error('Learning from chats is turned off.');
  checkSourceAge(controls, request);
  return { ...request, explicitSave: controls.memoryLearning === false };
}
export function memoryForgettingSource(s, context = {}) {
  const request = memoryRequestSource(s, context);
  checkSourceAge(currentMemoryControls(s, context, request), request);
  if (!explicitForgetRequest(request.source))
    throw new Error('The owner did not ask to forget a saved memory.');
  return request;
}
export function explicitForgetAllRequest(source) {
  if (!explicitForgetRequest(source)) return false;
  return (
    /^(?:(?:please|can you|could you)\s+)?(?:forget|delete|remove)\s+(?:all|every one of)\s+(?:of\s+)?(?:my\s+)?(?:saved\s+)?(?:personal\s+)?(?:memories|notes)[.!。！]?$/iu.test(
      source.text.trim(),
    ) ||
    /^(?:请|帮我|请帮我)?(?:忘记|忘掉|删除)(?:我的)?(?:所有|全部)(?:已保存的)?(?:个人)?记忆[。！.!]?$/u.test(
      source.text.trim(),
    )
  );
}
export function learnMemory(s, p, context = {}) {
  const { source, sourceIndex, assistantId, explicitSave } = memoryLearningSource(s, context);
  if (!mayContainMemoryStatement(source))
    throw new Error(
      'Automatic learning needs a direct personal statement or save request in the current message; quoted evidence alone is insufficient.',
    );
  const value = text(p.text, 'Memory');
  const evidence = text(p.evidence, 'Source quote');
  if (!source.text.includes(evidence))
    throw new Error('The source quote must appear exactly in the owner’s current message.');
  if (typeof p.key !== 'string' || !/^[a-z][a-z0-9_.-]{0,79}$/.test(p.key))
    throw new Error('Use a short, stable lowercase key for this fact or preference.');
  const notes = s.memories.filter((m) => m.type === 'note' && memoryAssistantId(m) === assistantId);
  const keyed = notes.find((m) => m.key === p.key);
  const specified = p.memoryId ? notes.find((m) => m.id === p.memoryId) : null;
  if (p.memoryId && !specified) throw new Error('The memory to update no longer exists.');
  if (keyed && specified && keyed.id !== specified.id)
    throw new Error('The key belongs to a different memory.');
  const existing =
    specified || keyed || notes.find((m) => normalized(m.text) === normalized(value));
  if (existing?.key && existing.key !== p.key)
    throw new Error('Reuse the existing memory’s topic key.');
  if (existing && normalized(existing.text) === normalized(value)) {
    if (explicitSave && (existing.origin !== 'manual' || existing.proposal)) {
      Object.assign(existing, {
        origin: 'manual',
        sourceMessageId: source.id,
        sourceThreadId: source.threadId,
        evidence,
        updatedAt: iso(),
      });
      delete existing.proposal;
      return { id: existing.id, status: 'updated', text: existing.text };
    }
    if (
      existing.proposal &&
      s.messages.findIndex((m) => m.id === existing.proposal.sourceMessageId) < sourceIndex
    )
      delete existing.proposal;
    return { id: existing.id, status: 'unchanged', text: existing.text };
  }
  const previousSource = existing?.proposal?.sourceMessageId || existing?.sourceMessageId;
  if (
    existing?.proposal?.sourceMessageId === source.id &&
    existing.proposal.text === value &&
    existing.proposal.evidence === evidence
  )
    return { id: existing.id, status: 'proposed', text: existing.text, proposedText: value };
  if (previousSource && s.messages.findIndex((m) => m.id === previousSource) >= sourceIndex)
    throw new Error('A newer or identical message already supplied this memory.');
  if (
    notes.filter(
      (m) => m.sourceMessageId === source.id || m.proposal?.sourceMessageId === source.id,
    ).length >= 3
  )
    throw new Error('Keep learning selective: at most three memories from one message.');
  if (!existing && notes.length >= 200)
    throw new Error('Memory is full. Review existing notes before saving more.');
  const provenance = {
    sourceMessageId: source.id,
    sourceThreadId: source.threadId,
    evidence,
    updatedAt: iso(),
  };
  if (existing && existing.origin !== 'learned') {
    existing.key ||= p.key;
    existing.proposal = {
      id: uid('memory-update'),
      key: existing.key || p.key,
      text: value,
      ...provenance,
    };
    return {
      id: existing.id,
      status: 'proposed',
      text: existing.text,
      proposedText: value,
      message:
        'The owner’s saved wording remains active. They can review the possible update in My memories.',
    };
  }
  if (existing) {
    Object.assign(existing, {
      text: value,
      ...provenance,
      ...(explicitSave ? { origin: 'manual' } : {}),
    });
    return { id: existing.id, status: 'updated', text: value };
  }
  const memory = {
    id: uid('memory'),
    type: 'note',
    ...(assistantId !== 'relay' ? { assistantId } : {}),
    key: p.key,
    text: value,
    origin: explicitSave ? 'manual' : 'learned',
    createdAt: iso(),
    ...provenance,
  };
  delete memory.updatedAt;
  s.memories.unshift(memory);
  return { id: memory.id, status: 'saved', text: value };
}
export function resolveMemory(s, p) {
  const memory = s.memories.find((m) => m.id === p.id && m.type === 'note');
  if (!memory?.proposal || memory.proposal.id !== p.proposalId)
    throw new Error('This memory update changed. Review the latest suggestion.');
  if (typeof p.use !== 'boolean') throw new Error('Choose whether to use this update.');
  if (p.use) {
    const { id: _proposalId, ...accepted } = memory.proposal;
    Object.assign(memory, accepted, { origin: 'manual' });
  }
  delete memory.proposal;
  memoryControlChanged(s, memoryAssistantId(memory));
  return memory;
}
