// SPDX-License-Identifier: MIT
import { artifactKinds } from '../shared/artifacts.mjs';
import { runAppContext } from '../shared/app-mentions.mjs';

// A conservative completion gate for direct creation requests. It never grants
// tool permissions or treats quoted/attached instructions as owner requests.
// Free-form advice, code examples and generic conversational drafts stay in chat.
const kinds = [
  ['document', /^(?:word\s+(?:document|file|doc|report)\b|docx\b)/i],
  ['spreadsheet', /^(?:excel\b|spreadsheet\b|workbook\b|xlsx\b)/i],
  ['presentation', /^(?:powerpoint\b|presentation\b|slide\s+deck\b|pptx\b)/i],
  [
    'web',
    /^(?:interactive\s+(?:page|web\s?page|website)|html\s+(?:page|file)|web\s?page\b|website\b)/i,
  ],
];
export function artifactCreationKind(text) {
  if (typeof text !== 'string' || text.length > 12000) return null;
  let request = text.trim();
  if (
    /^(?:[>"'“‘`]|how\b|explain\b|show me how\b)/i.test(request) ||
    /\b(?:don't|do not|never) (?:save|create|make|generate)\b|\b(?:in chat only|just (?:the )?code|code (?:sample|example)|example code)\b|(?:不要|不用|别|別)(?:保存|儲存|生成|创建|建立)/i.test(
      request,
    )
  )
    return null;
  request = request.replace(
    /^(?:please\s+|(?:can|could|would|will) you\s+|i (?:want|need|would like) you to\s+)+/i,
    '',
  );
  const english = request.match(/^(?:make|create|build|generate|write|draft|prepare)\s+(.+)/is);
  if (english) {
    const object = english[1].replace(
      /^(?:(?:me|us|a|an|the|my|our|new|short|little|simple|small|downloadable|editable|offline|mobile|responsive)\s+)+/i,
      '',
    );
    if (
      /^(?:(?:presentation|powerpoint|slide deck|website|web\s?page)\s+(?:outline|ideas?|plan|instructions|script)|(?:excel|spreadsheet)\s+(?:formula|instructions|example))\b/i.test(
        object,
      )
    )
      return null;
    return kinds.find(([, pattern]) => pattern.test(object))?.[0] || null;
  }
  const chinese = request.match(
    /^(?:请|請)?(?:帮我|幫我|为我|為我)?(?:制作|製作|创建|建立|生成|做|写|寫)(?:一个|一個|一份|个|個|份)?(?:可下载的|可下載的|简单的|簡單的|小)?(.+)/,
  );
  if (!chinese) return null;
  const noun = chinese[1];
  if (/^(?:Word|DOCX)(?:文档|文件|文檔|文書|报告|報告)?/i.test(noun)) return 'document';
  if (/^(?:Excel|XLSX|电子表格|電子表格|试算表|試算表)/i.test(noun)) return 'spreadsheet';
  if (/^(?:PowerPoint|PPTX?|幻灯片|幻燈片|演示文稿|簡報)/i.test(noun)) return 'presentation';
  if (/^(?:互动网页|互動網頁|交互页面|交互頁面|网页|網頁|HTML页面|HTML頁面)/i.test(noun))
    return 'web';
  return null;
}

// Bind a narrow demonstrative revision request to the preceding result in this
// chat. Other wording retains the ordinary model flow rather than guessing a target.
export function artifactRevisionRequest(state, run) {
  const sourceId = run.activeMessageId || run.messageId;
  const messages = state.messages.filter((m) => m.threadId === run.threadId);
  const at = messages.findIndex((m) => m.id === sourceId && m.role === 'user');
  if (at < 0) return null;
  const source = messages[at];
  if (
    typeof source.text !== 'string' ||
    source.text.length > 12000 ||
    source.fileIds?.length ||
    source.quoted ||
    source.skill
  )
    return null;
  const text = source.text.trim().replace(/^(?:please\s+|(?:can|could|would) you\s+)+/i, '');
  if (/\b(?:example|outline|instructions|in chat only|do not|don't)\b/i.test(text || ''))
    return null;
  const match = text?.match(/^(?:update|revise|edit)\s+that\s+(?:same\s+)?(.+)/i);
  const kind = match && kinds.find(([, pattern]) => pattern.test(match[1]))?.[0];
  if (!kind) return null;
  const preceding = messages.slice(0, at).findLast((m) => m.role === 'assistant');
  const targets = (preceding?.cards || []).flatMap((card) => {
    if (card.kind !== 'file') return [];
    const file = state.files.find((f) => f.id === card.id);
    const artifact = state.artifacts?.find((a) => a.id === file?.artifactId && a.kind === kind);
    const version = artifact?.versions.find((v) => v.fileId === file.id);
    return version ? [{ id: artifact.id, kind, version: version.number }] : [];
  });
  const unique = [...new Map(targets.map((target) => [target.id, target])).values()];
  return unique.length === 1 ? unique[0] : null;
}

// A request-local reference, not a fuzzy ID lookup or a global "latest file".
// Resolve again at execution so a stale model/checkpoint cannot carry it into
// another request or a newly selected app workflow.
export function currentArtifactReference(state, run, sourceMessageId) {
  if (
    !run ||
    !sourceMessageId ||
    (run.activeMessageId || run.messageId) !== sourceMessageId ||
    runAppContext(run).length
  )
    return null;
  return artifactRevisionRequest(state, run);
}

export function artifactRevisionTools(tools, revision) {
  if (!revision) return tools;
  return tools.map((tool) => {
    if (!['read_artifact', 'save_artifact'].includes(tool.name)) return tool;
    return {
      ...tool,
      description:
        'For this owner request, use id "current" to refer to the single preceding result being revised. Relay binds that reference; do not copy or shorten its internal ID. Read it first, then save with the returned revisionTarget and expectedVersion. ' +
        tool.description,
      parameters: {
        ...tool.parameters,
        properties: {
          ...tool.parameters.properties,
          id: {
            ...tool.parameters.properties.id,
            description:
              'Use "current" for the result this request revises. Other results still require an exact artifact/file ID as described by this tool.',
          },
        },
      },
    };
  });
}

export function deliveredArtifact(state, run, kind, exports = [], revision = null) {
  const sourceId = run.activeMessageId || run.messageId;
  const related = [
    run,
    ...(state.runs || []).filter(
      (other) =>
        other.threadId === run.threadId &&
        (other.activeMessageId || other.messageId) === sourceId &&
        other.assistant?.id === run.assistant?.id,
    ),
  ];
  for (const artifact of state.artifacts || []) {
    if (artifact.kind !== kind) continue;
    if (revision && artifact.id !== revision.id) continue;
    for (const version of artifact.versions) {
      if (revision && version.number <= revision.version) continue;
      if (
        version.sourceMessageId !== sourceId ||
        !related.some((other) => version.operationId?.startsWith(`artifact:${other.id}:`))
      )
        continue;
      const file = state.files.find(
        (f) =>
          f.id === version.fileId &&
          f.artifactId === artifact.id &&
          f.artifactVersion === version.number,
      );
      if (file?.base64 && file.mime === artifactKinds[kind].mime) return true;
    }
  }
  // Only the server's completed, bound handoff receipt can attest a specialist
  // file. Assistant prose and an unbound/copied handoffContext are not proof.
  const handoff = (state.handoffs || []).find(
    (h) =>
      h.id === run.handoffContext?.id &&
      h.continuationId === run.id &&
      h.status === 'completed' &&
      related.some((other) => other.id === h.sourceRunId),
  );
  if (
    handoff?.result?.fileIds?.some((id) =>
      state.files.some(
        (file) =>
          file.id === id &&
          file.base64 &&
          file.mime === artifactKinds[kind].mime &&
          (!revision ||
            (file.artifactId === revision.id &&
              file.artifactVersion > revision.version &&
              state.artifacts?.some(
                (artifact) =>
                  artifact.id === revision.id &&
                  artifact.kind === kind &&
                  artifact.versions.some(
                    (version) =>
                      version.fileId === file.id && version.number === file.artifactVersion,
                  ),
              ))),
      ),
    )
  )
    return true;
  if (revision) return false;
  return exports.some(
    (item) =>
      item.sourceId === sourceId &&
      state.files.some(
        (file) =>
          file.id === item.fileId &&
          file.base64 &&
          file.name.toLowerCase().endsWith(`.${artifactKinds[kind].extension}`),
      ),
  );
}

export function artifactRecoveryMessage(kind, revision = null) {
  if (revision)
    return `Relay result check: the requested revision of ${revision.id} was not saved for this owner request. Reading a file or creating a different result does not revise this document. Read the existing source with read_artifact id "current", then use save_artifact with its returned revisionTarget and the requested changes. Load those tools if needed. Keep the same result identity and inspect the saved version before confirming completion. Do not repeat a successful save. Tool permissions and reviews remain unchanged.`;
  return `Relay result check: no saved ${artifactKinds[kind].extension.toUpperCase()} result exists for the current owner request. A completion claim or invented filename is not a saved result. Continue the authorized request using save_artifact (kind ${kind}) or the already available computer tools, and inspect the returned content check before finishing. Do not repeat a successful save. If required input is missing, use ask_question. Tool permissions and review requirements remain unchanged.`;
}
