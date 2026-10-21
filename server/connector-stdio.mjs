// SPDX-License-Identifier: MIT
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
export async function stdioConnectorSession(
  record,
  work,
  { computer, signal, timeoutMs = 45000, beforeCall = () => {} } = {},
) {
  if (!computer?.enabled)
    throw Error('Set up and start Relay’s computer before connecting a local tool.');
  computer.assertAvailable();
  computer.assertControl('agent');
  signal?.throwIfAborted();
  const transport = computer.stdio.transport(record.launch);
  const controller = new AbortController();
  let invoked = false;
  const abort = () => {
    controller.abort();
    void transport.close().catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  const send = transport.send.bind(transport);
  transport.send = async (message) => {
    transport.guard();
    controller.signal.throwIfAborted();
    if (message.method === 'completion/complete') {
      beforeCall();
      controller.signal.throwIfAborted();
    }
    if (['tools/call', 'resources/read', 'prompts/get'].includes(message.method)) {
      if (invoked) throw Error('This app action was already dispatched.');
      beforeCall();
      controller.signal.throwIfAborted();
      invoked = true;
    }
    return send(message);
  };
  const client = new Client({ name: 'Relay', version: '0.1.0' }, { capabilities: {} });
  client.onerror = () => {};
  try {
    await client.connect(transport, { signal: controller.signal, timeout: timeoutMs });
    return await work(client, { signal: controller.signal, timeout: timeoutMs });
  } catch {
    throw Object.assign(
      Error(
        invoked
          ? 'The local app action may have run, but its result could not be confirmed. Check its files before trying again.'
          : 'The local tool could not connect. Check its program and folder in Relay’s computer, or give control back to Relay.',
      ),
      {
        name: invoked ? 'UncertainActionError' : signal?.aborted ? 'AbortError' : 'ConnectorError',
      },
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    await transport.close();
    await client.close().catch(() => {});
  }
}
