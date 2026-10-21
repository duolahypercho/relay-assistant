// SPDX-License-Identifier: MIT
import { sseFrames, modelJSON } from './model-stream.mjs';
import { ModelUnavailableError, providerStreamError } from './model-failover.mjs';
const parsed = (text) => {
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new Error('The model returned invalid tool arguments.');
  }
};
function image(visual, anthropic) {
  const match = /^data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)$/i.exec(visual);
  if (!match) throw new Error('This model connection requires an inline image.');
  return anthropic
    ? { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }
    : { inlineData: { mimeType: match[1], data: match[2] } };
}
function nativeMessages(messages, anthropic) {
  const result = [];
  const names = new Map();
  const nativeIds = new Set();
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.providerOutput?.protocol === 'gemini')
      for (const p of m.providerOutput.content) {
        if (p.functionCall?.id) nativeIds.add(p.functionCall.id);
      }
    for (const call of m.tool_calls || []) names.set(call.id, call.function.name);
    let content;
    if (m.providerOutput?.protocol === (anthropic ? 'anthropic' : 'gemini'))
      content = m.providerOutput.content;
    else if (m.role === 'tool') {
      content = [
        anthropic
          ? { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }
          : {
              functionResponse: {
                name: names.get(m.tool_call_id) || m.name,
                ...(nativeIds.has(m.tool_call_id) ? { id: m.tool_call_id } : {}),
                response: { result: parsed(m.content) },
              },
            },
      ];
    } else {
      content = m.content
        ? [anthropic ? { type: 'text', text: m.content } : { text: m.content }]
        : [];
      if (m.visual) content.push(image(m.visual, anthropic));
      for (const call of m.tool_calls || [])
        content.push(
          anthropic
            ? {
                type: 'tool_use',
                id: call.id,
                name: call.function.name,
                input: parsed(call.function.arguments),
              }
            : { functionCall: { name: call.function.name, args: parsed(call.function.arguments) } },
        );
    }
    const role = m.role === 'assistant' ? (anthropic ? 'assistant' : 'model') : 'user';
    const field = anthropic ? 'content' : 'parts';
    if (result.at(-1)?.role === role) result.at(-1)[field].push(...content);
    else if (content.length) result.push({ role, [field]: [...content] });
  }
  return result;
}
export async function nativeCompletion(
  provider,
  messages,
  tools,
  { signal, onText, maxOutputTokens, usage, started },
) {
  const anthropic = provider.protocol === 'anthropic';
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const body = anthropic
    ? {
        model: provider.model,
        stream: true,
        max_tokens: maxOutputTokens,
        system,
        messages: nativeMessages(messages, true),
        ...(tools.length
          ? {
              tools: tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters,
              })),
            }
          : {}),
      }
    : {
        systemInstruction: { parts: [{ text: system }] },
        contents: nativeMessages(messages, false),
        generationConfig: { maxOutputTokens },
        ...(tools.length
          ? {
              tools: [
                {
                  functionDeclarations: tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    parametersJsonSchema: t.parameters,
                  })),
                },
              ],
            }
          : {}),
      };
  const path = anthropic
    ? 'messages'
    : `models/${encodeURIComponent(provider.model.replace(/^models\//, ''))}:streamGenerateContent?alt=sse`;
  const timeout = AbortSignal.timeout(120000);
  const res = await provider.request(
    path,
    { method: 'POST', body: JSON.stringify(body) },
    signal ? AbortSignal.any([signal, timeout]) : timeout,
    started,
  );
  const blocks = [];
  let text = '',
    complete = false,
    total = 0;
  function accept(frame) {
    usage.accept(frame);
    total += JSON.stringify(frame).length;
    if (total > 2_000_000) throw new Error('The model output exceeded the limit.');
    if (frame.error || frame.type === 'error') throw providerStreamError(frame.error);
    if (anthropic) {
      if (frame.type === 'content_block_start') blocks[frame.index] = { ...frame.content_block };
      if (frame.type === 'content_block_delta') {
        const block = blocks[frame.index];
        if (!block) throw new Error('The model returned an incomplete stream.');
        const delta = frame.delta;
        if (delta.type === 'text_delta') block.text = (block.text || '') + delta.text;
        if (delta.type === 'input_json_delta')
          block.arguments = (block.arguments || '') + delta.partial_json;
        if (delta.type === 'thinking_delta')
          block.thinking = (block.thinking || '') + delta.thinking;
        if (delta.type === 'signature_delta')
          block.signature = (block.signature || '') + delta.signature;
      }
      if (frame.type === 'message_delta' && frame.delta?.stop_reason === 'max_tokens')
        throw new Error('The model reached its output limit. Try a shorter request.');
      if (frame.type === 'message_stop') complete = true;
      text = blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text || '')
        .join('');
    } else {
      if (frame.promptFeedback?.blockReason) throw new Error('The model declined this request.');
      const candidate = frame.candidates?.[0];
      if (candidate?.finishReason && !['STOP'].includes(candidate.finishReason))
        throw new Error(
          'The model could not finish this request. Try a shorter or different request.',
        );
      if (candidate?.finishReason === 'STOP') complete = true;
      for (const part of candidate?.content?.parts || []) {
        blocks.push(part);
        if (part.text && !part.thought) text += part.text;
      }
    }
    if (text.length > 50000) throw new Error('The model output exceeded the limit.');
    onText(text);
  }
  if (res.headers.get('content-type')?.includes('event-stream')) {
    for await (const frame of sseFrames(res.body)) accept(frame);
    if (!complete)
      throw new ModelUnavailableError(
        'The model connection ended before the response finished. Retry the request.',
        'interrupted',
      );
  } else {
    const data = await modelJSON(res);
    if (anthropic) {
      if (data.error) throw providerStreamError(data.error);
      usage.accept(data);
      if (data.stop_reason === 'max_tokens')
        throw new Error('The model could not finish this request.');
      blocks.push(...(data.content || []));
      text = blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      onText(text);
    } else accept(data);
  }
  const content = blocks.map(({ arguments: args, ...b }) =>
    args === undefined ? b : { ...b, input: parsed(args) },
  );
  const toolCalls = content.flatMap((b, index) => {
    const call = anthropic
      ? b.type === 'tool_use' && { id: b.id, name: b.name, args: b.input }
      : b.functionCall && {
          id: b.functionCall.id || `gemini-${index}`,
          name: b.functionCall.name,
          args: b.functionCall.args,
        };
    return call
      ? [
          {
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args || {}) },
          },
        ]
      : [];
  });
  if (text.length > 50000 || toolCalls.some((c) => c.function.arguments.length > 50000))
    throw new Error('The model output exceeded the limit.');
  return { text, toolCalls, providerOutput: { protocol: provider.protocol, content } };
}
