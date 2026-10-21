// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';

// A narrow result requirement for directly requested saved methods, never a permission.
export function skillSaveRequested(text) {
  if (typeof text !== 'string' || text.length > 12000) return false;
  const request = text
    .trim()
    .replace(
      /^(?:please\s+|(?:can|could|would|will) you\s+|i (?:want|need|would like) you to\s+)+/i,
      '',
    );
  if (
    /^(?:[>"'“‘`]|how\b|explain\b|show me how\b)/i.test(request) ||
    /\b(?:don't|do not|never)\s+(?:save|create|make)\b|\b(?:in chat only|example code)\b|(?:不要|不用|别|別)(?:保存|儲存|创建|建立)/i.test(
      request,
    )
  )
    return false;
  return (
    /^(?:save|create|make)\s+(?:(?:me|us|a|an|the|my|our|new|reusable|saved)\s+)*skill\b/i.test(
      request,
    ) ||
    /^(?:请|請)?(?:帮我|幫我|为我|為我)?(?:保存|儲存|创建|建立)(?:一个|一個|一份)?(?:可复用的|可重用的)?技能/.test(
      request,
    )
  );
}
export function skillSaveRequired(run, text) {
  return skillSaveRequested(
    !run.activeMessageId && run.questionContext ? run.questionContext.origin.request : text,
  );
}
export function skillSaveFingerprint(skill) {
  if (
    !skill ||
    typeof skill.id !== 'string' ||
    typeof skill.instructions !== 'string' ||
    !Number.isInteger(skill.version)
  )
    return null;
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: skill.id,
        version: skill.version,
        title: skill.title,
        slug: skill.slug,
        description: skill.description,
        instructions: skill.instructions,
        documentMeta: skill.documentMeta,
        files: skill.files,
      }),
    )
    .digest('hex');
}
export function deliveredSkill(state, run, cards = []) {
  const sourceId = run.activeMessageId || run.messageId;
  const related = new Set([
    run.id,
    ...(state.runs || [])
      .filter(
        (r) =>
          r.threadId === run.threadId &&
          (r.activeMessageId || r.messageId) === sourceId &&
          r.assistant?.id === run.assistant?.id,
      )
      .map((r) => r.id),
  ]);
  const skills = (state.skills || []).filter(
    (s) => !s.archived && s.savedBy?.fingerprint === skillSaveFingerprint(s),
  );
  if (
    cards.some((c) => c.kind === 'workspace' && c.page === 'skills') &&
    skills.some(
      (s) =>
        related.has(s.savedBy.runId) &&
        s.savedBy.sourceMessageId === sourceId &&
        s.savedBy.threadId === run.threadId &&
        s.savedBy.assistantId === run.assistant?.id,
    )
  )
    return true;
  const handoff = (state.handoffs || []).find(
    (h) =>
      h.id === run.handoffContext?.id &&
      h.continuationId === run.id &&
      h.status === 'completed' &&
      related.has(h.sourceRunId),
  );
  return (
    !!handoff &&
    skills.some((s) =>
      (state.runs || []).some(
        (child) =>
          child.id === s.savedBy.runId &&
          child.status === 'completed' &&
          child.threadId === s.savedBy.threadId &&
          child.assistant?.id === s.savedBy.assistantId &&
          (child.activeMessageId || child.messageId) === s.savedBy.sourceMessageId &&
          (child.id === handoff.childRunId ||
            (!!handoff.rootId && child.handoffRootId === handoff.rootId)),
      ),
    )
  );
}
export const skillSaveRecoveryMessage =
  'Relay result check: no verified saved skill exists for this owner request. A confirmation or navigation card does not save a reusable method. Load save_skill with load_tools if its schema is deferred, then save the requested method with its exact instructions. Do not run the method unless requested. Inspect an existing successful result instead of creating a duplicate. If a required detail is missing, use ask_question. Existing source and permission rules still apply.';
