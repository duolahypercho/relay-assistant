// SPDX-License-Identifier: MIT
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import { stdioConnectorSession } from './connector-stdio.mjs';
import { connectorContentEntries } from './connector-content.mjs';

export const connectorFingerprint = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function connectorEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2000) throw Error('Enter an app address.');
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw Error('Enter a complete app address.');
  }
  if (url.username || url.password || url.search || url.hash)
    throw Error('Keep passwords, tokens and query parameters out of the app address.');
  const local =
    url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\./.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    throw Error('Use HTTPS, or HTTP on the Relay server’s localhost.');
  return url.href;
}
export function boundedJSON(value, limit = 32768) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    throw Error('Use a plain JSON object.');
  }
  if (typeof text !== 'string' || Buffer.byteLength(text) > limit)
    throw Error('This app payload is too large.');
  return JSON.parse(text);
}
export function connectorTool(raw) {
  if (typeof raw?.name !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(raw.name))
    throw Error('This app returned an invalid tool name.');
  const inputSchema = boundedJSON(raw.inputSchema, 24000);
  if (!inputSchema || inputSchema.type !== 'object')
    throw Error('App tools need object input schemas.');
  const tool = {
    name: raw.name,
    title: String(raw.title || raw.annotations?.title || raw.name).slice(0, 160),
    description: String(raw.description || '').slice(0, 4000),
    inputSchema,
    readOnly: raw.annotations?.readOnlyHint === true,
  };
  // Reject unresolved references and unsupported schemas before exposing the tool.
  validator(tool);
  return { ...tool, fingerprint: connectorFingerprint(tool) };
}
export function validator(tool) {
  const schema = tool.inputSchema;
  if (
    schema.$schema &&
    ![
      'http://json-schema.org/draft-07/schema#',
      'https://json-schema.org/draft/2020-12/schema',
    ].includes(schema.$schema)
  )
    throw Error('This app uses an unsupported input schema version.');
  try {
    const Engine = schema.$schema?.includes('2020-12') ? Ajv2020 : Ajv;
    return new Engine({
      strict: false,
      allErrors: false,
      validateFormats: false,
      ownProperties: true,
    }).compile(schema);
  } catch {
    throw Error('This app returned an unsupported input schema.');
  }
}
export function validateConnectorArguments(tool, args) {
  const value = boundedJSON(args);
  if (!value || Array.isArray(value) || typeof value !== 'object')
    throw Error('Tool arguments must be an object.');
  const check = validator(tool);
  if (!check(value))
    throw Error('The arguments do not match this app tool. Check its saved input schema.');
  return value;
}

// Only recognized network failures qualify. Invalid JSON/schema, redirects, size limits,
// authentication failures and cancellation must not turn into automatic retries.
function transientNetworkFailure(error) {
  const codes = new Set([
    'ECONNRESET',
    'EPIPE',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
  ]);
  for (let depth = 0; error && depth < 4; depth++, error = error.cause)
    if (codes.has(error.code)) return true;
  return false;
}

// Each operation initializes a fresh MCP session. No redirect, background server request,
// sampling capability or automatic tools/call retry is accepted by Relay.
export async function connectorSession(
  record,
  work,
  { signal, timeoutMs = 45000, fetcher = fetch, beforeCall = () => {}, computer } = {},
) {
  if (record.transport === 'stdio')
    return stdioConnectorSession(record, work, { signal, timeoutMs, beforeCall, computer });
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(
    () => controller.abort(new DOMException('App timed out', 'TimeoutError')),
    timeoutMs,
  );
  let invoked = false,
    invokedMethod,
    transientReadFailure = false,
    authenticationRejected = false;
  const transport = new StreamableHTTPClientTransport(new URL(record.endpoint), {
    requestInit: { headers: record.token ? { Authorization: `Bearer ${record.token}` } : {} },
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
    fetch: async (input, init = {}) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== record.endpoint) throw Error('App requests must stay at the saved address.');
      if (typeof init.body === 'string') {
        const payload = JSON.parse(init.body);
        if (payload.method === 'completion/complete') {
          beforeCall();
          controller.signal.throwIfAborted();
        }
        if (['tools/call', 'resources/read', 'prompts/get'].includes(payload.method)) {
          if (invoked) throw Error('This app action was already dispatched.');
          beforeCall();
          controller.signal.throwIfAborted();
          invoked = true;
          invokedMethod = payload.method;
        }
      }
      let response;
      try {
        response = await fetcher(url, {
          ...init,
          redirect: 'error',
          signal: controller.signal,
        });
      } catch (error) {
        if (invokedMethod === 'resources/read')
          transientReadFailure = transientNetworkFailure(error);
        throw error;
      }
      if (invokedMethod === 'resources/read' && [502, 503, 504].includes(response.status))
        transientReadFailure = true;
      if (!invoked && [401, 403].includes(response.status)) authenticationRejected = true;
      if (!response.body) return response;
      let size = 0;
      const reader = response.body.getReader();
      const stream = new ReadableStream({
        async pull(next) {
          try {
            const { done, value } = await reader.read();
            if (done) return next.close();
            size += value.byteLength;
            if (size > 4 * 1024 * 1024) {
              controller.abort();
              throw Error('App response exceeded its limit.');
            }
            next.enqueue(value);
          } catch (error) {
            const recoverable =
              response.ok &&
              invokedMethod === 'resources/read' &&
              !controller.signal.aborted &&
              transientNetworkFailure(error);
            if (recoverable) transientReadFailure = true;
            next.error(error);
            // The SDK reports SSE body failures through onerror without rejecting the
            // pending request. Close this failed session so the bounded retry can proceed.
            if (recoverable) void client.close().catch(() => {});
          }
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      });
      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  });
  const client = new Client({ name: 'Relay', version: '0.1.0' }, { capabilities: {} });
  // Protocol errors are surfaced through the operation, never printed with headers/body.
  client.onerror = () => {};
  try {
    await client.connect(transport, { signal: controller.signal, timeout: timeoutMs });
    return await work(client, { signal: controller.signal, timeout: timeoutMs });
  } catch (error) {
    const failure = Error(
      invoked
        ? 'The app action may have run, but its result could not be confirmed. Check the app before trying again.'
        : authenticationRejected
          ? 'Sign in to this app again from Your apps, or check its saved token.'
          : 'Could not connect to this app. Check its address, token and Streamable HTTP support.',
    );
    failure.name = invoked
      ? 'UncertainActionError'
      : signal?.aborted
        ? 'AbortError'
        : authenticationRejected
          ? 'ConnectorSignInError'
          : 'ConnectorError';
    if (
      invokedMethod === 'resources/read' &&
      !controller.signal.aborted &&
      (transientReadFailure || transientNetworkFailure(error))
    )
      failure.retryableResourceRead = true;
    throw failure;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    // End fresh server sessions where supported; cleanup failure never changes a known result.
    const cleanup = setTimeout(() => controller.abort(), 800);
    try {
      if (!controller.signal.aborted) await transport.terminateSession().catch(() => {});
    } finally {
      clearTimeout(cleanup);
    }
    controller.abort();
    await client.close().catch(() => {});
  }
}
export async function discoverConnector(record, options = {}) {
  return connectorSession(record, connectorCatalog, options);
}
export async function connectorCatalog(client, request) {
  const tools = [],
    cursors = new Set();
  let cursor;
  if (client.getServerCapabilities()?.tools) {
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, request);
      for (const value of page.tools) {
        if (tools.length >= 100 || tools.some((t) => t.name === value.name))
          throw Error('This app returned too many or duplicate tools.');
        tools.push(connectorTool(value));
      }
      cursor = page.nextCursor;
      if (cursor && (cursors.has(cursor) || cursors.size >= 100))
        throw Error('This app repeated or exceeded its tool-list pages.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
  }
  for (const raw of await connectorContentEntries(client, request)) {
    if (tools.length >= 100 || tools.some((t) => t.name === raw.name))
      throw Error('This app returned too many or duplicate capabilities.');
    const { fingerprint, ...base } = connectorTool(raw);
    const tool = {
      ...base,
      kind: raw.kind,
      contentTarget: raw.contentTarget,
      ownerChoice: raw.ownerChoice,
    };
    tools.push({
      ...tool,
      fingerprint: connectorFingerprint(tool),
      ...(['prompt', 'resource-template'].includes(raw.kind) &&
      client.getServerCapabilities()?.completions
        ? { completions: true }
        : {}),
    });
  }
  if (!tools.length) throw Error('This app did not expose any tools, documents or templates.');
  return tools;
}
