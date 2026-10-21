// SPDX-License-Identifier: MIT
import { computerFileFingerprint, deliveredComputerFile } from './computer-file-delivery.mjs';

// A schema hint for explicit local-file requests, never authority to create one.
// Other wording retains normal discovery; quoted examples cannot preload it.
function requestedTextKind(text) {
  if (typeof text !== 'string' || text.length > 12000) return null;
  const request = text
    .trim()
    .replace(
      /^(?:please\s+|(?:can|could|would|will) you\s+|i (?:want|need|would like) you to\s+)+/i,
      '',
    );
  if (
    /^(?:[>"'“‘`]|how\b|explain\b|show me how\b)/i.test(request) ||
    /\b(?:don't|do not|never)\s+(?:save|create|make|generate)\b|\b(?:in chat only|example code)\b|(?:不要|不用|别|別)(?:保存|儲存|生成|创建|建立)/i.test(
      request,
    )
  )
    return null;
  const english =
    /^(save|create|make|generate|write)\s+(?:(?:me|us|a|an|the|my|our|new|short|simple|small|downloadable)\s+)*(.+)/is.exec(
      request,
    );
  if (english) {
    if (/^(?:(?:plain\s+)?text\s+file|\.?txt\s+file)\b/i.test(english[2])) return 'plain';
    if (/^(?:save|create|make)$/i.test(english[1]) && /^note\b/i.test(english[2])) return 'note';
    return null;
  }
  const chinese =
    /^(?:请|請)?(?:帮我|幫我|为我|為我)?(?:保存|儲存|创建|建立|生成|制作|製作)(?:一个|一個|一份)?(?:可下载的|可下載的)?(纯文本文件|純文字檔案|文本文件|文字檔案|TXT文件|TXT檔案|笔记|筆記)/i.exec(
      request,
    );
  return chinese ? (/笔记|筆記/.test(chinese[1]) ? 'note' : 'plain') : null;
}
export const textFileToolRequested = (text) => !!requestedTextKind(text);
export const textFileRequestText = (run, text) =>
  !run.activeMessageId && run.questionContext ? run.questionContext.origin.request : text;
export const textFileCompletionRequired = (run, text) =>
  requestedTextKind(textFileRequestText(run, text)) === 'plain';

// Presence and provenance, not a semantic judgment of the file's requested contents.
export function deliveredTextFile(workspace, run, cards = [], exports = []) {
  const sourceId = run.activeMessageId || run.messageId;
  const related = new Set(
    workspace.runs
      .filter(
        (r) =>
          r.threadId === run.threadId &&
          (r.activeMessageId || r.messageId) === sourceId &&
          r.assistant?.id === run.assistant?.id,
      )
      .map((r) => r.id),
  );
  related.add(run.id);
  const plain = workspace.files.filter(
    (file) => file.mime === 'text/plain' && computerFileFingerprint(file),
  );
  const created = (file) =>
    file.creation?.kind === 'assistant-text' &&
    file.creation.fingerprint === computerFileFingerprint(file);
  if (
    plain.some(
      (file) =>
        created(file) &&
        related.has(file.creation.runId) &&
        file.creation.sourceMessageId === sourceId &&
        file.creation.threadId === run.threadId &&
        file.creation.assistantId === run.assistant?.id &&
        cards.some((c) => c.kind === 'file' && c.id === file.id),
    )
  )
    return true;
  if (deliveredComputerFile({ ...workspace, files: plain }, sourceId, exports, cards)) return true;
  const handoff = (workspace.handoffs || []).find(
    (h) =>
      h.id === run.handoffContext?.id &&
      h.continuationId === run.id &&
      h.status === 'completed' &&
      related.has(h.sourceRunId),
  );
  if (!handoff) return false;
  return plain.some(
    (file) =>
      created(file) &&
      handoff.result?.fileIds?.includes(file.id) &&
      workspace.runs.some(
        (child) =>
          child.id === file.creation.runId &&
          child.status === 'completed' &&
          child.threadId === file.creation.threadId &&
          child.assistant?.id === file.creation.assistantId &&
          (child.activeMessageId || child.messageId) === file.creation.sourceMessageId &&
          (child.id === handoff.childRunId ||
            (!!handoff.rootId && child.handoffRootId === handoff.rootId)),
      ),
  );
}

export const textFileRecoveryMessage =
  'Relay result check: the requested plain-text file has no verified saved result for this owner request. A completion claim or filename is not a file. Save the actual requested content with write_note using a .txt filename, or finish and attach the actual computer result. If work already succeeded, inspect that result instead of creating a duplicate. If required information is missing, use ask_question. Source, permission and review rules remain unchanged.';

export function pendingTextFileContext(run) {
  const answered = !run.activeMessageId && run.questionContext?.answers?.length;
  return (
    'Current requested result: the plain-text file is not saved yet. ' +
    (answered
      ? 'The owner has now answered the saved question. Use those supplied answers to continue the original request; its ask-first step has already happened. Do not repeat that question. Ask only if a different required detail remains missing. '
      : 'If the owner asked to choose a missing detail first, call ask_question with prompt only and wait before saving. Never invent a missing filename. ') +
    'Use write_note with a .txt name and the requested content, or finish and attach the actual computer result. A prose question or success claim does not perform that step. Keep the final confirmation short; the file card carries the result. Existing source, permission and review rules still apply.'
  );
}
