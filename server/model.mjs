// SPDX-License-Identifier: MIT
import { sseFrames, modelJSON } from './model-stream.mjs';
import { nativeCompletion } from './model-native.mjs';
import { usageCollector } from './model-usage.mjs';
import { capabilityMessages, quickReasoningEffort } from './model-capabilities.mjs';
import { localOllamaConnection, compactToolCatalogRequested } from '../shared/model-catalog.mjs';
import {
  computerCoordinateMode,
  computerCoordinateTools,
  tagComputerCoordinates,
} from './computer-coordinates.mjs';
import {
  ModelUnavailableError,
  providerHttpError,
  providerStreamError,
} from './model-failover.mjs';
export { sseFrames } from './model-stream.mjs';
export class ModelProvider {
  constructor({
    baseUrl,
    model,
    apiKey = '',
    protocol = 'responses',
    fetcher = fetch,
    observe,
    reportUsage = true,
    getCapabilities,
    replyMode = 'default',
  }) {
    if (!['responses', 'chat', 'anthropic', 'gemini'].includes(protocol))
      throw new Error('Choose Responses, Chat Completions, Anthropic Messages, or Gemini.');
    this.baseUrl = baseUrl?.replace(/\/$/, '');
    this.model = model;
    this.apiKey = apiKey;
    this.protocol = protocol;
    this.fetcher = fetcher;
    this.observe = observe;
    this.reportUsage = reportUsage;
    this.getCapabilities = getCapabilities;
    this.replyMode = replyMode;
  }
  get compactTools() {
    return compactToolCatalogRequested(this);
  }
  get configured() {
    return !!(this.baseUrl && this.model);
  }
  async request(path, init, signal, onDispatch) {
    signal?.throwIfAborted();
    onDispatch?.();
    let res;
    try {
      res = await this.fetcher(`${this.baseUrl}/${path}`, {
        ...init,
        redirect: 'error',
        signal,
        headers: {
          'Content-Type': 'application/json',
          ...(this.protocol === 'anthropic'
            ? {
                'anthropic-version': '2023-06-01',
                ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}),
              }
            : this.protocol === 'gemini'
              ? this.apiKey
                ? { 'x-goog-api-key': this.apiKey }
                : {}
              : this.apiKey
                ? { Authorization: `Bearer ${this.apiKey}` }
                : {}),
        },
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new ModelUnavailableError(
        'The model endpoint could not be reached. Check its URL and whether the service is running.',
        'unreachable',
      );
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw providerHttpError(res.status);
    }
    return res;
  }
  async complete(messages, tools = [], options = {}) {
    options.signal?.throwIfAborted();
    if (!this.configured) throw new Error('Configure a model endpoint and model ID on the server.');
    let observation;
    const started = () => {
      observation = this.observe?.();
    };
    const usage = usageCollector(this.protocol, (value) => observation?.report(value));
    let status = 'failed';
    try {
      const capabilities = this.getCapabilities ? await this.getCapabilities(options.signal) : {};
      // Metadata lookup can outlive a control/priority change. Recheck before copying
      // messages so handback can invalidate stale visuals before inference dispatch.
      if (this.getCapabilities) await options.beforeAttempt?.(options.signal);
      options.signal?.throwIfAborted();
      if (capabilities.tools === false && options.requiresTools)
        throw Error(
          'This model can chat and discuss attached documents, but cannot use assistant actions. Choose a model with tools in AI models, then retry.',
        );
      // Only a trusted host caller can request a read-only structured selection.
      // Apply the constrained path only to explicit, supported Quick mode.
      // Normal reasoning and unknown/hosted endpoints retain their existing protocol.
      const structured =
        !!options.localStructuredOutput &&
        localOllamaConnection(this) &&
        capabilities.source === 'ollama' &&
        quickReasoningEffort(this, capabilities) === 'none';
      if (structured && options.requiresTools)
        throw Error('A structured selection cannot execute assistant actions.');
      let prepared;
      // File parsers can yield while the owner takes control. Prepare again from
      // fresh, provider-scoped history when handback invalidates observations.
      for (let attempt = 0; ; attempt++) {
        options.signal?.throwIfAborted();
        const source = options.getMessages?.() || messages;
        prepared = options.prepareMessages
          ? await options.prepareMessages(source, capabilities, options.signal)
          : source;
        const changed = options.prepareMessages && (await options.beforeAttempt?.(options.signal));
        options.signal?.throwIfAborted();
        if (!changed) break;
        if (attempt >= 7)
          throw Error('The conversation changed while opening files. Retry when you are ready.');
      }
      prepared.validate?.();
      const availableTools = structured || capabilities.tools === false ? [] : tools;
      const coordinateMode = computerCoordinateMode(this, capabilities, availableTools);
      const generated = await this.generate(
        capabilityMessages(
          Array.isArray(prepared) ? prepared : prepared.messages,
          capabilities,
          structured,
        ),
        computerCoordinateTools(availableTools, coordinateMode),
        {
          ...options,
          usage,
          started,
          localStructuredOutput: structured ? options.localStructuredOutput : undefined,
          reasoningEffort: quickReasoningEffort(this, capabilities),
          quickRepliesAvailable: !!quickReasoningEffort(
            { ...this, replyMode: 'quick' },
            capabilities,
          ),
        },
      );
      const result = tagComputerCoordinates(generated, coordinateMode);
      if ((structured || capabilities.tools === false) && result.toolCalls.length)
        throw Error(
          'This chat-only model returned an unsupported action. No action was performed. Choose a model with tools to continue.',
        );
      status = 'completed';
      return { ...result, usage: usage.value, ...(structured ? { structuredOutput: true } : {}) };
    } catch (error) {
      if (options.signal?.aborted || error?.name === 'AbortError') status = 'cancelled';
      throw error;
    } finally {
      observation?.finish(status);
    }
  }
  async generate(
    messages,
    tools,
    {
      signal,
      onText = () => {},
      maxOutputTokens = 5000,
      usage,
      started,
      reasoningEffort,
      quickRepliesAvailable,
      localStructuredOutput,
    },
  ) {
    if (!this.configured) throw new Error('Configure a model endpoint and model ID on the server.');
    if (['anthropic', 'gemini'].includes(this.protocol))
      return nativeCompletion(this, messages, tools, {
        signal,
        onText,
        maxOutputTokens,
        usage,
        started,
      });
    const responses = this.protocol === 'responses';
    messages = messages.map(({ visual, providerOutput, modelOrigin, ...rest }) => {
      const message = {
        ...rest,
        ...(!responses && providerOutput?.protocol === 'chat' ? providerOutput.content : {}),
      };
      return !visual
        ? message
        : {
            ...message,
            content: responses
              ? [
                  { type: 'input_text', text: message.content },
                  { type: 'input_image', image_url: visual },
                ]
              : [
                  { type: 'text', text: message.content },
                  { type: 'image_url', image_url: { url: visual } },
                ],
          };
    });
    const input = responses
      ? messages.flatMap((m) => {
          if (m.responseOutput?.length) return m.responseOutput;
          if (m.role === 'tool')
            return [{ type: 'function_call_output', call_id: m.tool_call_id, output: m.content }];
          if (m.tool_calls)
            return [
              ...(m.content ? [{ role: 'assistant', content: m.content }] : []),
              ...m.tool_calls.map((c) => ({
                type: 'function_call',
                call_id: c.id,
                name: c.function.name,
                arguments: c.function.arguments,
              })),
            ];
          return [{ role: m.role, content: m.content }];
        })
      : messages.map(({ responseOutput, ...message }) => message);
    const mappedTools = responses
      ? tools.map((t) => ({ type: 'function', ...t }))
      : tools.map((t) => ({ type: 'function', function: t }));
    const body = {
      model: this.model,
      stream: true,
      ...(responses
        ? { input, store: false, include: ['reasoning.encrypted_content'] }
        : {
            messages: input,
            ...(this.reportUsage ? { stream_options: { include_usage: true } } : {}),
          }),
      ...(tools.length ? { tools: mappedTools } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(localStructuredOutput
        ? {
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: localStructuredOutput.name,
                strict: true,
                schema: localStructuredOutput.schema,
              },
            },
            ...(reasoningEffort === 'none'
              ? { temperature: 0, top_p: 1, presence_penalty: 0 }
              : {}),
          }
        : {}),
      ...(responses ? { max_output_tokens: maxOutputTokens } : { max_tokens: maxOutputTokens }),
    };
    const timeout = AbortSignal.timeout(120000);
    const res = await this.request(
      responses ? 'responses' : 'chat/completions',
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
      signal ? AbortSignal.any([signal, timeout]) : timeout,
      started,
    );
    let text = '';
    const calls = new Map();
    let outputItems = [];
    const reasoningText = {};
    const reasoningDetails = [];
    const acceptReasoning = (message) => {
      // Compatible APIs use different keys. Retain the original key for the
      // same connection's next tool round; neither field is a visible answer.
      for (const key of ['reasoning_content', 'reasoning']) {
        const value = message?.[key];
        if (value === undefined || value === null) continue;
        if (typeof value !== 'string')
          throw new Error('The model endpoint returned an invalid reasoning response.');
        reasoningText[key] = (reasoningText[key] || '') + value;
      }
    };
    const outputTooLarge = () =>
      text.length > 50000 ||
      Object.values(reasoningText).some((value) => value.length > 50000) ||
      JSON.stringify(reasoningDetails).length > 50000 ||
      [...calls.values()].some((c) => c.function.arguments.length > 50000);
    const limitError = () =>
      new Error(
        'The model could not finish within its response limit. ' +
          (quickRepliesAvailable && reasoningEffort !== 'none'
            ? 'Choose Quick replies in AI models, or try another model.'
            : 'Try a shorter request or choose another model.'),
      );
    const providerOutput = () =>
      responses
        ? undefined
        : {
            protocol: 'chat',
            content: {
              ...reasoningText,
              ...(reasoningDetails.length ? { reasoning_details: reasoningDetails } : {}),
            },
          };
    if (!res.headers.get('content-type')?.includes('event-stream')) {
      const json = await modelJSON(res);
      usage.accept(json);
      if (json.error) throw providerStreamError(json.error);
      if (json.choices?.[0]?.finish_reason === 'length') throw limitError();
      if (
        ['failed', 'incomplete'].includes(json.status) ||
        json.choices?.[0]?.finish_reason === 'content_filter'
      )
        throw new Error(
          'The model could not finish this request. Try a shorter or different request.',
        );
      if (responses) {
        outputItems = json.output || [];
        for (const item of outputItems) {
          if (item.type === 'function_call')
            calls.set(item.call_id, {
              id: item.call_id,
              type: 'function',
              function: { name: item.name, arguments: item.arguments },
            });
          else
            for (const part of item.content || [])
              if (part.type === 'output_text') text += part.text;
        }
      } else {
        const message = json.choices?.[0]?.message;
        text = message?.content || '';
        acceptReasoning(message);
        reasoningDetails.push(...(message?.reasoning_details || []));
        for (const call of message?.tool_calls || []) calls.set(call.id, call);
      }
      if (outputTooLarge()) throw new Error('The model output exceeded the limit.');
      onText(text);
      return {
        text,
        toolCalls: [...calls.values()],
        outputItems,
        providerOutput: providerOutput(),
      };
    }
    let finished = false;
    for await (const frame of sseFrames(res.body, {
      onDone: () => {
        finished = true;
      },
    })) {
      usage.accept(frame);
      if (frame.error || frame.type === 'error' || frame.type === 'response.failed')
        throw providerStreamError(frame.error || frame.response?.error);
      if (responses) {
        if (frame.type === 'response.completed') finished = true;
        if (frame.type === 'response.output_text.delta') {
          text += frame.delta;
          onText(text);
        }
        if (frame.type === 'response.output_item.added' && frame.item?.type === 'function_call')
          calls.set(frame.item.id, {
            id: frame.item.call_id,
            type: 'function',
            function: { name: frame.item.name, arguments: frame.item.arguments || '' },
          });
        if (frame.type === 'response.function_call_arguments.delta') {
          const call = calls.get(frame.item_id);
          if (call) call.function.arguments += frame.delta;
        }
        if (frame.type === 'response.output_item.done' && frame.item?.type === 'function_call')
          calls.set(frame.item.id, {
            id: frame.item.call_id,
            type: 'function',
            function: { name: frame.item.name, arguments: frame.item.arguments },
          });
        if (frame.type === 'response.output_item.done' && frame.item) outputItems.push(frame.item);
        if (frame.type === 'response.completed' && frame.response?.output)
          outputItems = frame.response.output;
        if (frame.type === 'response.incomplete')
          throw new Error('The model response reached its output limit. Send a shorter request.');
      } else {
        const delta = frame.choices?.[0]?.delta;
        if (['stop', 'tool_calls', 'function_call'].includes(frame.choices?.[0]?.finish_reason))
          finished = true;
        if (frame.choices?.[0]?.finish_reason === 'length') throw limitError();
        if (frame.choices?.[0]?.finish_reason === 'content_filter')
          throw new Error(
            'The model could not finish this request. Try a shorter or different request.',
          );
        acceptReasoning(delta);
        for (const detail of delta?.reasoning_details || []) {
          const prior = reasoningDetails.find(
            (d) => d.index === detail.index && d.type === detail.type,
          );
          if (!prior || detail.index === undefined) reasoningDetails.push({ ...detail });
          else {
            for (const [key, value] of Object.entries(detail)) {
              if (['text', 'data', 'summary'].includes(key))
                prior[key] = (prior[key] || '') + value;
              else prior[key] = value;
            }
          }
        }
        if (delta?.content) {
          text += delta.content;
          onText(text);
        }
        for (const c of delta?.tool_calls || []) {
          let call = calls.get(c.index);
          if (!call) {
            call = {
              id: c.id || `tool-${c.index}`,
              type: 'function',
              function: { name: '', arguments: '' },
            };
            calls.set(c.index, call);
          }
          if (c.id) call.id = c.id;
          if (c.function?.name) call.function.name += c.function.name;
          if (c.function?.arguments) call.function.arguments += c.function.arguments;
        }
      }
      if (outputTooLarge()) throw new Error('The model output exceeded the limit.');
    }
    if (!finished)
      throw new ModelUnavailableError(
        'The model connection ended before the response finished. Retry the request.',
        'interrupted',
      );
    return { text, toolCalls: [...calls.values()], outputItems, providerOutput: providerOutput() };
  }
}
