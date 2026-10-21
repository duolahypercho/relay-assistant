// SPDX-License-Identifier: MIT
// An independent OAuth authorization server for protocol/UX acceptance. No vendor account is used.
import express from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { connectorFixture } from './connectors-fixture.mjs';
export async function oauthConnectorFixture() {
  const clients = new Map(),
    pending = new Map(),
    codes = new Map(),
    access = new Set(),
    refresh = new Set(),
    exchanges = [];
  let root,
    refreshFailure = false,
    refreshHold,
    metadataPatch = {},
    resourcePatch = {};
  const remote = await connectorFixture({
    authenticate: (req) => access.has((req.headers.authorization || '').replace(/^Bearer /, '')),
    configure(app) {
      app.use(express.urlencoded({ extended: false }));
      app.get(
        ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource'],
        (_req, res) =>
          res.json({
            resource: `${root}/mcp`,
            authorization_servers: [root],
            scopes_supported: ['notes:read', 'notes:write'],
            ...resourcePatch,
          }),
      );
      app.get('/.well-known/oauth-authorization-server', (_req, res) =>
        res.json({
          issuer: root,
          authorization_endpoint: `${root}/authorize`,
          token_endpoint: `${root}/token`,
          registration_endpoint: `${root}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
          ...metadataPatch,
        }),
      );
      app.post('/register', (req, res) => {
        const client = { ...req.body, client_id: randomUUID() };
        clients.set(client.client_id, client);
        res.status(201).json(client);
      });
      app.get('/authorize', (req, res) => {
        const q = req.query,
          client = clients.get(q.client_id);
        if (
          !client?.redirect_uris.includes(q.redirect_uri) ||
          q.resource !== `${root}/mcp` ||
          q.response_type !== 'code' ||
          q.code_challenge_method !== 'S256' ||
          !/^[\w-]{43}$/.test(q.code_challenge || '')
        )
          return res.sendStatus(400);
        const id = randomUUID();
        pending.set(id, { ...q });
        res
          .type('html')
          .send(
            `<!doctype html><html lang="en"><title>Notebook test sign-in</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:18px system-ui;margin:40px;max-width:540px}button{font:inherit;margin:12px 10px 12px 0;padding:12px}</style><h1>Connect your notebook</h1><p>Independent test app. Relay is requesting access to read and save notes.</p><form method="post" action="/consent"><input type="hidden" name="id" value="${id}"><button name="choice" value="allow">Allow Relay</button><button name="choice" value="deny">Cancel</button></form></html>`,
          );
      });
      app.post('/consent', (req, res) => {
        const q = pending.get(req.body.id);
        pending.delete(req.body.id);
        if (!q) return res.sendStatus(400);
        const target = new URL(q.redirect_uri);
        target.searchParams.set('state', q.state);
        target.searchParams.set('iss', root);
        if (req.body.choice === 'allow') {
          const code = randomUUID();
          codes.set(code, q);
          target.searchParams.set('code', code);
        } else target.searchParams.set('error', 'access_denied');
        res.redirect(303, target.href);
      });
      app.post('/token', async (req, res) => {
        const b = req.body;
        exchanges.push({ ...b });
        const client = clients.get(b.client_id);
        if (!client || (client.client_secret && b.client_secret !== client.client_secret))
          return res.status(401).json({ error: 'invalid_client' });
        if (b.resource !== `${root}/mcp`) return res.status(400).json({ error: 'invalid_target' });
        if (b.grant_type === 'authorization_code') {
          const q = codes.get(b.code);
          codes.delete(b.code);
          if (
            !q ||
            q.client_id !== b.client_id ||
            q.redirect_uri !== b.redirect_uri ||
            createHash('sha256')
              .update(b.code_verifier || '')
              .digest('base64url') !== q.code_challenge
          )
            return res.status(400).json({ error: 'invalid_grant' });
        } else if (b.grant_type === 'refresh_token') {
          if (!refresh.delete(b.refresh_token))
            return res.status(400).json({ error: 'invalid_grant' });
          if (refreshHold) await refreshHold;
          if (refreshFailure === 'lost') {
            res.destroy();
            return;
          }
          if (refreshFailure) return res.status(400).json({ error: 'invalid_grant' });
        } else return res.status(400).json({ error: 'unsupported_grant_type' });
        const tokens = {
          access_token: `access-${randomUUID()}`,
          refresh_token: `refresh-${randomUUID()}`,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'notes:read notes:write',
        };
        access.add(tokens.access_token);
        refresh.add(tokens.refresh_token);
        res.json(tokens);
      });
    },
  });
  root = new URL(remote.endpoint).origin;
  return {
    ...remote,
    root,
    clients,
    exchanges,
    pending,
    codes,
    access,
    setRefreshFailure(value) {
      refreshFailure = value;
    },
    setRefreshHold(value) {
      refreshHold = value;
    },
    setMetadata(value) {
      metadataPatch = value;
    },
    setResource(value) {
      resourcePatch = value;
    },
  };
}
