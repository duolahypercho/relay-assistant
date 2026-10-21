// SPDX-License-Identifier: MIT
import { command } from '../shared/domain.mjs';
import { profileSnapshot } from '../shared/assistant-scope.mjs';
import { connectorFingerprint, validateConnectorArguments } from './connector-transport.mjs';

export function templateSelection(service, input, partial = false) {
  const { record, assistantId } = service.documentContext(input);
  const tool = record.tools.find(
    (t) => t.name === input.toolName && t.kind === 'prompt' && t.mode !== 'off',
  );
  if (!tool || tool.fingerprint !== input.fingerprint)
    throw Error('This template changed or is unavailable. Reopen Templates.');
  const args = validateConnectorArguments(
    partial ? { ...tool, inputSchema: { ...tool.inputSchema, required: [] } } : tool,
    input.arguments,
  );
  return { checked: { record, tool, arguments: args }, assistantId };
}
export function pickedTemplates(service, input) {
  const { record, assistantId } = service.documentContext(input);
  return {
    assistantName: profileSnapshot(service.store.read(), assistantId).name,
    entries: record.tools
      .filter((t) => t.kind === 'prompt' && t.mode !== 'off')
      .map((t) => ({
        name: t.name,
        title: t.title.replace(/^Use template: /, ''),
        description: t.description.replace(
          /\n?Using this template requires your choice in chat\.[\s\S]*$/,
          '',
        ),
        fingerprint: t.fingerprint,
        inputSchema: t.inputSchema,
        canSuggest: !!t.completions,
      })),
  };
}
export function suggestPickedTemplate(service, input, signal) {
  const initial = templateSelection(service, input, true);
  const guard = () => {
    if (templateSelection(service, input, true).assistantId !== initial.assistantId)
      throw Error('This chat’s assistant changed. Reopen Templates.');
  };
  return service.suggestContent(
    initial,
    input,
    guard,
    { type: 'ref/prompt', name: initial.checked.tool.contentTarget.name },
    signal,
  );
}
function operation(input) {
  if (typeof input?.operationId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.operationId))
    throw Error('Choose the template again.');
  return `template:${input.operationId}`;
}
export function cancelPickedTemplate(service, input) {
  const active = service.active.get(operation(input));
  if (active && active.connectionId !== input.connectionId)
    throw Error('This request belongs to another app.');
  active?.controller.abort();
  return { cancelled: !!active };
}
export async function usePickedTemplate(service, input, signal) {
  const initial = templateSelection(service, input),
    id = operation(input);
  const payload = {
    connectionId: initial.checked.record.id,
    revision: initial.checked.record.revision,
    toolName: initial.checked.tool.name,
    fingerprint: initial.checked.tool.fingerprint,
    arguments: initial.checked.arguments,
  };
  const fingerprint = connectorFingerprint({
    payload,
    threadId: input.threadId,
    assistantId: initial.assistantId,
  });
  const prior = () => {
    const row = service.store.db
      .prepare('SELECT fingerprint, body FROM connector_template_uses WHERE id=?')
      .get(id);
    if (!row) return null;
    if (row.fingerprint !== fingerprint)
      throw Error('This template choice already belongs to different details. Choose it again.');
    return JSON.parse(row.body);
  };
  const previous = prior();
  if (previous) return previous;
  if (service.active.has(id)) throw Error('This template is already opening.');
  const controller = new AbortController(),
    cancel = () => controller.abort();
  const guard = () => {
    controller.signal.throwIfAborted();
    if (templateSelection(service, input).assistantId !== initial.assistantId)
      throw Error('This chat’s assistant changed. Reopen Templates.');
  };
  const changed = () => {
    try {
      guard();
    } catch {
      cancel();
    }
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  service.store.on('change', changed);
  try {
    guard();
    const result = await service.call(payload, initial.assistantId, id, {
      reviewed: true,
      signal: controller.signal,
      guard,
    });
    guard();
    if (result.isError)
      throw Error('This app could not open the template. No chat request was sent.');
    return service.store.mutate((state) => {
      guard();
      const previous = prior();
      if (previous) return previous;
      const thread = state.threads.find((t) => t.id === input.threadId);
      const drafts = Object.fromEntries(
        Object.entries(thread).filter(([key]) => key.startsWith('draft')),
      );
      const title = initial.checked.tool.title.replace(/^Use template: /, '');
      const run = command(
        state,
        'chat.send',
        {
          threadId: thread.id,
          text: `Use “${title}” from ${initial.checked.record.name}.`,
          fileIds: result.fileIds,
          apps: [
            {
              id: initial.checked.record.id,
              revision: initial.checked.record.revision,
              name: initial.checked.record.name,
            },
          ],
          ...(thread.participantIds ? { recipientIds: [initial.assistantId] } : {}),
        },
        false,
        service.chatCatalog(),
      );
      // This explicit page action is independent of the unfinished composer.
      for (const key of Object.keys(thread)) if (key.startsWith('draft')) delete thread[key];
      Object.assign(thread, drafts);
      const message = state.messages.find((m) => m.id === run.messageId);
      message.appTemplate = {
        title,
        appName: initial.checked.record.name,
        arguments: initial.checked.arguments,
      };
      run.templateContext = { ...message.appTemplate, result };
      const receipt = { threadId: thread.id, runId: run.id, messageId: message.id };
      service.store.db
        .prepare('INSERT INTO connector_template_uses VALUES (?,?,?)')
        .run(id, fingerprint, JSON.stringify(receipt));
      return receipt;
    });
  } finally {
    signal?.removeEventListener('abort', cancel);
    service.store.off('change', changed);
  }
}
