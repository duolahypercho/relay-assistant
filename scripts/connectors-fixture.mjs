// SPDX-License-Identifier: MIT
// Independent JSON-RPC HTTP fixture for the production MCP SDK client. Never imported by production.
import express from 'express';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
export async function connectorFixture({
  sse = false,
  token = 'fictional-connector-token',
  authenticate,
  configure,
} = {}) {
  const tools = [
    {
      name: 'find_note',
      title: 'Find a note',
      description: 'Read the fictional notebook.',
      inputSchema: {
        type: 'object',
        properties: { topic: { type: 'string', minLength: 1 } },
        required: ['topic'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'save_note',
      title: 'Save a note',
      description: 'Write to the fictional notebook.',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string', minLength: 1 }, body: { type: 'string' } },
        required: ['title', 'body'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
    },
    {
      name: 'get_picture',
      title: 'Get a picture',
      description: 'Read a small test PNG.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
    },
  ];
  const sessions = new Set(),
    requests = [],
    calls = [],
    notes = [],
    app = express();
  let disconnect = false,
    responseError = false,
    hold = null,
    redirect = '',
    responseSecret = false;
  app.use(express.json({ limit: '5mb' }));
  configure?.(app);
  app.all('/mcp', async (req, res) => {
    if (authenticate ? !authenticate(req) : req.headers.authorization !== `Bearer ${token}`)
      return res.sendStatus(401);
    if (redirect) return res.redirect(307, redirect);
    if (req.method === 'GET') return res.sendStatus(405);
    if (req.method === 'DELETE') {
      sessions.delete(req.headers['mcp-session-id']);
      return res.sendStatus(204);
    }
    const body = req.body;
    requests.push({
      body,
      session: req.headers['mcp-session-id'],
      version: req.headers['mcp-protocol-version'],
    });
    let result;
    if (body.method === 'initialize') {
      const id = randomUUID();
      sessions.add(id);
      res.set('Mcp-Session-Id', id);
      result = {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'Notebook acceptance', version: '1.0' },
      };
    } else {
      if (!sessions.has(req.headers['mcp-session-id'])) return res.sendStatus(404);
      if (req.headers['mcp-protocol-version'] !== '2025-06-18') return res.sendStatus(400);
      if (body.method === 'notifications/initialized' || body.method === 'notifications/cancelled')
        return res.sendStatus(202);
      if (body.method === 'tools/list')
        result =
          body.params?.cursor === 'second'
            ? { tools: tools.slice(2) }
            : { tools: tools.slice(0, 2), nextCursor: 'second' };
      else if (body.method === 'tools/call') {
        calls.push(body.params);
        if (body.params.name === 'save_note') notes.push(structuredClone(body.params.arguments));
        if (hold) await hold;
        if (disconnect) {
          res.destroy();
          return;
        }
        result = {
          content: [
            {
              type: 'text',
              text:
                body.params.name === 'save_note'
                  ? 'Saved the Sunday plan in your notebook.'
                  : 'The notebook says: a slow Sunday by the water.',
            },
          ],
          structuredContent: { noteCount: notes.length },
          ...(responseError ? { isError: true } : {}),
        };
        if (responseSecret) result.content[0].text += ` ${token}`;
        if (body.params.name === 'get_picture')
          result = {
            content: [
              {
                type: 'image',
                mimeType: 'image/png',
                data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4WYAAAAASUVORK5CYII=',
              },
            ],
          };
      } else
        return res.json({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32601, message: 'Method not found' },
        });
    }
    const message = { jsonrpc: '2.0', id: body.id, result };
    if (sse) {
      res.type('text/event-stream');
      res.end(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    } else res.json(message);
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    endpoint: `http://127.0.0.1:${server.address().port}/mcp`,
    token,
    tools,
    calls,
    notes,
    requests,
    setDisconnect(v) {
      disconnect = v;
    },
    setError(v) {
      responseError = v;
    },
    setHold(v) {
      hold = v;
    },
    setRedirect(v) {
      redirect = v;
    },
    setEchoSecret(v) {
      responseSecret = v;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
