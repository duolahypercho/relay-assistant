// SPDX-License-Identifier: MIT
// OpenRouter's documented PKCE flow. No borrowed CLI credentials or provider client IDs.
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { encrypt, decrypt } from './google.mjs';
import { modelJSON } from './model-stream.mjs';

export const openRouterBase = 'https://openrouter.ai/api/v1';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const lifetime = 10 * 60 * 1000;
const cookieName = (id) => `relay_model_${id.replaceAll('-', '')}`;
export class ModelOAuth {
  constructor(models) {
    this.models = models;
    this.store = models.store;
    this.key = models.key;
    // An exchange might already have minted a key. Never replay its code after a restart.
    for (const flow of this.flows()) {
      if (flow.phase === 'exchanging') this.fail(flow, 'Sign-in was interrupted. Start again.');
    }
  }
  flows() {
    const raw = this.store.secret('model-oauth');
    return raw ? decrypt(raw, this.key) : [];
  }
  write(flow) {
    const other = this.flows().filter((f) => f.id !== flow.id && f.expires > Date.now());
    this.store.secret('model-oauth', encrypt([...other, flow], this.key));
  }
  flow(id) {
    return this.flows().find((f) => f.id === id && f.expires > Date.now());
  }
  clearSecrets(flow) {
    for (const key of ['apiKey', 'verifier', 'ticketHash', 'browserHash', 'authorizationUrl'])
      delete flow[key];
  }
  fail(flow, message) {
    this.clearSecrets(flow);
    flow.phase = 'failed';
    flow.error = message;
    this.write(flow);
  }
  begin(origin) {
    const root = new URL(origin);
    if (
      root.protocol !== 'https:' &&
      !(root.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(root.hostname))
    )
      throw Error('Browser sign-in needs an HTTPS Relay address or localhost.');
    if (this.models.read().connections.length >= 30)
      throw Error('You can save up to 30 model connections.');
    if (
      this.flows().filter((f) => f.expires > Date.now() && !['saved', 'failed'].includes(f.phase))
        .length >= 4
    )
      throw Error('Finish or cancel an existing model sign-in first.');
    const id = randomUUID();
    const verifier = secret(),
      state = secret(),
      ticket = secret();
    const authorization = new URL('https://openrouter.ai/auth');
    authorization.search = new URLSearchParams({
      callback_url: `${root.origin}/api/models/oauth/callback?flow=${id}`,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state,
      key_label: 'Relay personal assistant',
    }).toString();
    const flow = {
      id,
      connectionId: randomUUID(),
      origin: root.origin,
      verifier,
      state,
      ticketHash: digest(ticket),
      authorizationUrl: authorization.href,
      phase: 'created',
      expires: Date.now() + lifetime,
    };
    this.write(flow);
    return {
      id: flow.id,
      openUrl: `${root.origin}/api/models/oauth/open?id=${flow.id}&ticket=${ticket}`,
    };
  }
  open(id, ticket, origin) {
    const flow = this.flow(id);
    if (
      !flow ||
      flow.origin !== origin ||
      flow.phase !== 'created' ||
      typeof ticket !== 'string' ||
      digest(ticket) !== flow.ticketHash
    )
      throw Error('This sign-in link expired or was already opened. Start again in Relay.');
    const nonce = secret();
    flow.browserHash = digest(nonce);
    delete flow.ticketHash;
    flow.phase = 'waiting';
    this.write(flow);
    return { url: flow.authorizationUrl, nonce, cookie: cookieName(flow.id) };
  }
  async callback(params, cookies, origin) {
    // A declined request omits state. Only this non-authorizing outcome can use
    // the opaque callback flow ID together with its initiating-browser cookie.
    const flow = this.flows().find(
      (f) =>
        f.expires > Date.now() &&
        (params.error && !params.state ? f.id === params.flow : f.state === params.state),
    );
    if (
      !flow ||
      flow.origin !== origin ||
      flow.phase !== 'waiting' ||
      digest(cookies[cookieName(flow.id)] || '') !== flow.browserHash
    )
      throw Error('This sign-in did not match its browser. Start again in Relay.');
    if (params.error) {
      this.fail(flow, 'Sign-in was declined. You can try again.');
      return flow.id;
    }
    if (
      typeof params.code !== 'string' ||
      !params.code ||
      params.code.length > 8192 ||
      /[\x00-\x20\x7f]/.test(params.code)
    )
      throw Error('OpenRouter returned an invalid sign-in response.');
    flow.phase = 'exchanging';
    this.write(flow);
    try {
      const response = await this.models.fetcher(`${openRouterBase}/auth/keys`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          code: params.code,
          code_verifier: flow.verifier,
          code_challenge_method: 'S256',
        }),
      });
      if (!response.ok) throw Error('Exchange rejected');
      const result = await modelJSON(response, 32000);
      if (
        typeof result.key !== 'string' ||
        !result.key.trim() ||
        result.key.length > 8192 ||
        /[\x00-\x20\x7f]/.test(result.key)
      )
        throw Error('Invalid key');
      if (this.flow(flow.id)?.phase !== 'exchanging') return flow.id;
      this.clearSecrets(flow);
      flow.apiKey = result.key;
      flow.phase = 'ready';
      this.write(flow);
    } catch {
      if (this.flow(flow.id)?.phase === 'exchanging')
        this.fail(flow, 'Sign-in could not be confirmed. Start a new sign-in.');
    }
    return flow.id;
  }
  result(id) {
    const flow = this.flow(id);
    if (!flow) throw Error('This model sign-in expired. Start again.');
    return { phase: flow.phase, ...(flow.error ? { error: flow.error } : {}) };
  }
  ready(input) {
    const flow = this.flow(input.oauthId);
    if (!flow || !['ready', 'saved'].includes(flow.phase))
      throw Error('Sign in to OpenRouter again.');
    if (
      input.id ||
      input.preset !== 'openrouter' ||
      (input.baseUrl && input.baseUrl !== openRouterBase) ||
      (input.protocol && input.protocol !== 'chat') ||
      input.apiKey
    )
      throw Error('This sign-in is only for a new OpenRouter connection at its official endpoint.');
    return flow;
  }
  credentials(input) {
    const flow = this.ready(input);
    if (flow.phase !== 'ready')
      throw Error('This sign-in was already saved. Edit the saved connection instead.');
    return { id: flow.connectionId, apiKey: flow.apiKey };
  }
  commit(flow, data) {
    this.clearSecrets(flow);
    flow.phase = 'saved';
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.secret('model-connections', encrypt(data, this.key));
      this.write(flow);
      this.store.db.exec('COMMIT');
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
    this.store.emit('change', this.store.read());
  }
  cancel(id) {
    this.store.secret(
      'model-oauth',
      encrypt(
        this.flows().filter((f) => f.id !== id && f.expires > Date.now()),
        this.key,
      ),
    );
    return { ok: true };
  }
}

const path = '/api/models/oauth';
function originFor(config, req) {
  const url = new URL(config.publicUrl || `http://${config.host}:${config.port}`);
  if (config.port === 0) url.port = String(req.socket.localPort);
  return url.origin;
}
const screen = (res, ok) =>
  res
    .status(ok ? 200 : 400)
    .type('html')
    .send(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Model sign-in · Relay</title><style>body{font:17px/1.6 system-ui,sans-serif;color:#233a34;background:#f8faf7;margin:0;min-height:100dvh;display:grid;place-items:center}main{max-width:26rem;padding:2rem}h1{font-size:1.8rem;line-height:1.2}p{color:#52645d}</style><main><h1>${ok ? 'OpenRouter is connected.' : 'Sign-in wasn’t completed.'}</h1><p>${ok ? 'Return to Relay to choose and save your model. You can close this tab.' : 'Return to Relay and try signing in again. You can close this tab.'}</p></main></html>`,
    );
export function publicModelOAuthRoutes(app, provider, config) {
  const options = {
    httpOnly: true,
    sameSite: 'lax',
    secure: (config.publicUrl || '').startsWith('https:'),
    path: `${path}/callback`,
  };
  app.get(`${path}/open`, (req, res) => {
    res.set({ 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
    try {
      const result = provider.oauth.open(req.query.id, req.query.ticket, originFor(config, req));
      res.cookie(result.cookie, result.nonce, { ...options, maxAge: lifetime });
      res.redirect(303, result.url);
    } catch {
      screen(res, false);
    }
  });
  app.get(`${path}/callback`, async (req, res) => {
    res.set({ 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
    try {
      const cookies = Object.fromEntries(
        (req.headers.cookie || '').split(';').map((v) => v.trim().split('=')),
      );
      const id = await provider.oauth.callback(req.query, cookies, originFor(config, req));
      res.clearCookie(cookieName(id), options);
      screen(res, provider.oauth.flow(id)?.phase === 'ready');
    } catch {
      screen(res, false);
    }
  });
}
export function ownerModelOAuthRoutes(app, provider, config) {
  app.post(`${path}/begin`, (req, res, next) => {
    try {
      res.json(provider.oauth.begin(originFor(config, req)));
    } catch (e) {
      next(e);
    }
  });
  app.get(`${path}/result`, (req, res, next) => {
    try {
      res.json(provider.oauth.result(req.query.id));
    } catch (e) {
      next(e);
    }
  });
  app.post(`${path}/cancel`, (req, res, next) => {
    try {
      res.json(provider.oauth.cancel(req.body.id));
    } catch (e) {
      next(e);
    }
  });
}
