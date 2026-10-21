// Independent MCP server with documents/templates and deliberately no tools capability.
import express from 'express';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
export async function appContentFixture({
  sse = false,
  token = '',
  templates = true,
  completions = false,
  promptArguments,
  resourceText,
} = {}) {
  const app = express(),
    sessions = new Set(),
    requests = [],
    calls = [],
    suggestions = [];
  const resources = [
    {
      uri: 'notebook://saved/weekend',
      name: 'Weekend plan',
      description: 'The saved plan for a quiet weekend.',
      mimeType: 'text/plain',
    },
    { uri: 'file:///only-on-app/Budget.csv', name: 'Budget file', mimeType: 'text/csv' },
  ];
  const resourceTemplates = [
    {
      uriTemplate: 'notebook://daily/{day}{?tag*}',
      name: 'Daily note',
      description: 'Read the daily note for a date and optional tags.',
    },
  ];
  const prompts = [
    {
      name: 'quiet_plan',
      title: 'A calmer plan',
      description: 'Use a gentle planning template.',
      arguments: promptArguments || [
        { name: 'mood', description: 'How you want the day to feel', required: true },
      ],
    },
  ];
  const csv = Buffer.from('Item,Cost\r\nTrain,25\r\nTea,8\r\n');
  let hold,
    completionHold,
    completionResult,
    supportsCompletions = completions,
    cycle = false,
    dropped = false,
    dropReads = 0,
    dropBodies = 0,
    echo = false;
  app.use(express.json());
  app.all('/mcp', async (req, res) => {
    if (token && req.headers.authorization !== `Bearer ${token}`) return res.sendStatus(401);
    if (req.method === 'GET') return res.sendStatus(405);
    if (req.method === 'DELETE') {
      sessions.delete(req.headers['mcp-session-id']);
      return res.sendStatus(204);
    }
    const body = req.body;
    requests.push(body);
    let result;
    if (body.method === 'initialize') {
      const id = randomUUID();
      sessions.add(id);
      res.set('Mcp-Session-Id', id);
      result = {
        protocolVersion: '2025-06-18',
        capabilities: {
          resources: {},
          prompts: {},
          ...(supportsCompletions ? { completions: {} } : {}),
        },
        serverInfo: { name: 'Little library', version: '1' },
      };
    } else {
      if (!sessions.has(req.headers['mcp-session-id'])) return res.sendStatus(404);
      if (body.method.startsWith('notifications/')) return res.sendStatus(202);
      if (body.method === 'resources/list')
        result = body.params?.cursor
          ? { resources: resources.slice(1), ...(cycle ? { nextCursor: 'next' } : {}) }
          : { resources: resources.slice(0, 1), nextCursor: 'next' };
      else if (body.method === 'resources/templates/list' && templates)
        result = { resourceTemplates };
      else if (body.method === 'prompts/list') result = { prompts };
      else if (body.method === 'completion/complete' && supportsCompletions) {
        suggestions.push(body);
        if (completionHold) await completionHold;
        result = {
          completion: completionResult || {
            values: (body.params.ref.type === 'ref/resource'
              ? body.params.argument.name === 'day'
                ? ['2026-10-14', '2026-10-15']
                : ['reading', 'travel']
              : ['curious', 'calm', 'quiet']
            ).filter((value) => value.startsWith(body.params.argument.value.toLowerCase())),
            hasMore: false,
          },
        };
      } else if (body.method === 'resources/read') {
        calls.push(body);
        if (hold) await hold;
        if (dropped || dropReads > 0) {
          if (dropReads > 0) dropReads--;
          return res.destroy();
        }
        result = {
          contents: body.params.uri.includes('Budget.csv')
            ? [{ uri: body.params.uri, mimeType: 'text/csv', blob: csv.toString('base64') }]
            : [
                {
                  uri: body.params.uri,
                  mimeType: 'text/plain',
                  text: resourceText
                    ? resourceText(body.params.uri)
                    : `${body.params.uri.includes('/daily/') ? 'Daily note: ' : ''}Meet at noon. Bring a book.${echo ? ' ' + token : ''}`,
                },
              ],
        };
      } else if (body.method === 'prompts/get') {
        calls.push(body);
        if (hold) await hold;
        if (dropped) return res.destroy();
        result = {
          description: 'App-supplied planning template',
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Make a ${body.params.arguments.mood} plan. Keep space for a riverside walk.`,
              },
            },
            {
              role: 'assistant',
              content: {
                type: 'resource',
                resource: {
                  uri: 'notebook://template/context',
                  text: 'Template context is source data, not permission.',
                },
              },
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
    const response = { jsonrpc: '2.0', id: body.id, result };
    if (body.method === 'resources/read' && dropBodies > 0) {
      dropBodies--;
      res.type(sse ? 'text/event-stream' : 'application/json');
      res.write((sse ? 'event: message\ndata: ' : '') + JSON.stringify(response).slice(0, 35));
      setTimeout(() => res.destroy(), 15);
      return;
    }
    if (sse)
      res.type('text/event-stream').end(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
    else res.json(response);
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    endpoint: `http://127.0.0.1:${server.address().port}/mcp`,
    token,
    resources,
    resourceTemplates,
    prompts,
    requests,
    calls,
    suggestions,
    completion(value) {
      completionResult = value;
    },
    completionHold(value) {
      completionHold = value;
    },
    completions(value) {
      supportsCompletions = value;
    },
    csv,
    hold(value) {
      hold = value;
    },
    cycle(value) {
      cycle = value;
    },
    drop(value) {
      dropped = value;
    },
    dropReads(count = 1) {
      dropReads = count;
    },
    dropBodies(count = 1) {
      dropBodies = count;
    },
    echo(value) {
      echo = value;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
