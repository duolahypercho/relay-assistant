// SPDX-License-Identifier: MIT
// Independent HTTP authorization/model server. Production never imports this fixture.
import express from 'express';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { assistantsFixture } from './assistants-fixture.mjs';
export async function modelOAuthFixture(directory, options = {}) {
  const remote = express(),
    pending = new Map(),
    codes = new Map(),
    keys = new Set();
  const exchanges = [],
    requests = [],
    deliveries = [];
  let catalogFails = false;
  remote.use(express.json());
  remote.use(express.urlencoded({ extended: false }));
  remote.get('/auth', (req, res) => {
    const q = req.query;
    if (
      q.code_challenge_method !== 'S256' ||
      !/^[\w-]{43}$/.test(q.code_challenge || '') ||
      !q.state
    )
      return res.sendStatus(400);
    const id = randomUUID();
    pending.set(id, q);
    res
      .type('html')
      .send(
        `<!doctype html><html lang="en"><title>Independent model sign-in</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:18px system-ui;margin:40px;max-width:540px}button{font:inherit;padding:12px;margin:10px 8px 10px 0}</style><main><h1>Connect a model account</h1><p>This is an isolated acceptance provider. No live account or payment.</p><form method="post" action="/consent"><input type="hidden" name="id" value="${id}"><button name="choice" value="allow">Allow Relay</button><button name="choice" value="deny">Cancel</button></form></main></html>`,
      );
  });
  remote.post('/consent', (req, res) => {
    const q = pending.get(req.body.id);
    pending.delete(req.body.id);
    if (!q) return res.sendStatus(400);
    const target = new URL(q.callback_url);
    target.searchParams.set('state', q.state);
    if (req.body.choice === 'allow') {
      const code = randomUUID();
      codes.set(code, q);
      target.searchParams.set('code', code);
    } else {
      target.searchParams.delete('state');
      target.searchParams.set('error', 'access_denied');
    }
    res.redirect(303, target.href);
  });
  remote.post('/api/v1/auth/keys', (req, res) => {
    const code = codes.get(req.body.code);
    codes.delete(req.body.code);
    if (
      !code ||
      req.body.code_challenge_method !== 'S256' ||
      createHash('sha256')
        .update(req.body.code_verifier || '')
        .digest('base64url') !== code.code_challenge
    )
      return res.sendStatus(400);
    exchanges.push(req.body);
    const key = `isolated-model-key-${randomUUID()}`;
    keys.add(key);
    res.json({ key });
  });
  remote.use('/api/v1', (req, res, next) => {
    const key = String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (!keys.has(key)) return res.sendStatus(401);
    deliveries.push(req.path);
    next();
  });
  remote.get('/api/v1/models', (_req, res) =>
    catalogFails
      ? res.sendStatus(503)
      : res.json({
          data: [
            { id: 'fixture/conversation', name: 'Conversation model' },
            { id: 'fixture/alternative', name: 'Another model' },
          ],
        }),
  );
  remote.post('/api/v1/chat/completions', (req, res) => {
    requests.push(req.body);
    const messages = req.body.messages,
      last = messages.at(-1);
    const message =
      last.role === 'tool'
        ? { role: 'assistant', content: 'I saved your preference through the signed-in model.' }
        : messages.some(
              (m) => m.role === 'user' && m.content === 'I prefer short replies. Remember that.',
            )
          ? {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'remember-short',
                  type: 'function',
                  function: {
                    name: 'learn_memory',
                    arguments: JSON.stringify({
                      key: 'preference.reply',
                      text: 'Prefers short replies.',
                      evidence: 'I prefer short replies',
                    }),
                  },
                },
              ],
            }
          : { role: 'assistant', content: 'Connected' };
    res.json({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] });
  });
  const remoteServer = remote.listen(0, '127.0.0.1');
  await once(remoteServer, 'listening');
  const remoteUrl = `http://127.0.0.1:${remoteServer.address().port}`;
  let f;
  try {
    f = await assistantsFixture(directory, {
      ...options,
      configure(store, services) {
        const provider = services.provider;
        provider.remove(provider.publicState().active);
        provider.fetcher = (input, init) => {
          const url = new URL(String(input));
          assert.equal(url.origin, 'https://openrouter.ai');
          return fetch(remoteUrl + url.pathname + url.search, init);
        };
        const begin = provider.oauth.begin.bind(provider.oauth);
        provider.oauth.begin = (origin) => {
          const result = begin(origin),
            flow = provider.oauth.flow(result.id),
            auth = new URL(flow.authorizationUrl);
          assert.equal(auth.origin, 'https://openrouter.ai');
          flow.authorizationUrl = `${remoteUrl}/auth${auth.search}`;
          provider.oauth.write(flow);
          return result;
        };
      },
    });
    return {
      ...f,
      exchanges,
      requests,
      deliveries,
      keys,
      setCatalogFailure(value) {
        catalogFails = value;
      },
      async close() {
        await f.close();
        remoteServer.closeAllConnections();
        await new Promise((r) => remoteServer.close(r));
      },
    };
  } catch (e) {
    await f?.close();
    remoteServer.closeAllConnections();
    await new Promise((r) => remoteServer.close(r));
    throw e;
  }
}
