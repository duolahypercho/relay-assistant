// SPDX-License-Identifier: MIT
// Only direct owner requests activate this result check. It grants no permissions.
export function routineCreationRequested(text) {
  if (typeof text !== 'string' || text.length > 12000) return false;
  const request = text
    .trim()
    .replace(
      /^(?:please\s+|(?:can|could|would|will) you\s+|i (?:want|need|would like) you to\s+)+/i,
      '',
    );
  if (
    /^(?:[>"'“‘`]|how\b|explain\b|show me how\b)/i.test(request) ||
    /\b(?:don't|do not|never)\s+(?:save|create|make|set|schedule)\b|\b(?:in chat only|example|sample|instructions|outline)\b|(?:不要|不用|别|別)(?:保存|儲存|创建|建立|设置|設置)/i.test(
      request,
    )
  )
    return false;
  return (
    /^(?:create|save|make|set(?: up)?|schedule)\s+(?:(?:me|us|a|an|the|my|our|new|daily|weekly|monthly|recurring|paused)\s+)*(?:reminder|routine)\b/i.test(
      request,
    ) ||
    /^(?:请|請)?(?:帮我|幫我|为我|為我)?(?:创建|建立|设置|設置|保存|儲存)(?:一个|一個|个|個)?(?:每天的|每日|每周的|每週的|定时|定時)?(?:提醒|例行任务|例行任務)/.test(
      request,
    )
  );
}

export function deliveredRoutine(state, run) {
  const sourceId = run.activeMessageId || run.messageId;
  if (!sourceId) return false;
  const related = new Set([
    run.id,
    ...(state.runs || [])
      .filter(
        (other) =>
          other.threadId === run.threadId &&
          (other.activeMessageId || other.messageId) === sourceId &&
          other.assistant?.id === run.assistant?.id,
      )
      .map((other) => other.id),
  ]);
  return (state.routines || []).some(
    (routine) =>
      !routine.archived &&
      routine.threadId === run.threadId &&
      routine.creation?.sourceMessageId === sourceId &&
      related.has(routine.creation.runId),
  );
}

export const routineRecoveryMessage =
  'Relay result check: no saved routine exists for this owner request. A spoken confirmation or workspace navigation card does not create a reminder. Continue the authorized request using create_reminder for a fixed-text reminder or create_routine for scheduled assistant work, and inspect its returned schedule and paused state before finishing. If the full tool schema is deferred, load it with load_tools first. Ask only for missing required information using ask_question. Do not repeat an already saved routine or enable a paused routine unless requested. Existing tool permissions and reviews remain unchanged.';
