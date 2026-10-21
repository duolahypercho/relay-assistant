// SPDX-License-Identifier: MIT
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {
  discoverOAuthServerInfo,
  registerClient,
  startAuthorization,
  exchangeAuthorization,
  refreshAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { resolveDestination } from './network.mjs';
import { encrypt, decrypt } from './google.mjs';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const lifetime = 10 * 60 * 1000;
const expiry = (tokens) =>
  typeof tokens.expires_in === 'number' ? Date.now() + Math.max(0, tokens.expires_in) * 1000 : null;
const signInError = () =>
  Object.assign(Error('Sign in to this app again from Your apps.'), {
    name: 'ConnectorSignInError',
  });
const local = (u) => ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
function address(value, resource) {
  const url = new URL(value),
    root = new URL(resource);
  if (url.username || url.password || url.hash || value.length > 4000)
    throw Error('Invalid app sign-in address.');
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && local(root) && url.origin === root.origin)
  )
    throw Error('App sign-in requires HTTPS.');
  if (local(url) && !(local(root) && url.origin === root.origin))
    throw Error('App sign-in cannot redirect requests to a private server.');
  return url;
}
// Metadata is untrusted. Pin public DNS results and reject redirects before
// sending registration data, codes or refresh tokens. Loopback is limited to
// the exact explicitly configured development MCP origin.
export function oauthFetch(resource) {
  return async (input, init = {}) => {
    const url = address(input instanceof Request ? input.url : String(input), resource);
    const pinned = local(url) ? null : await resolveDestination(url.href);
    return new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).request(
        url,
        {
          method: init.method || 'GET',
          headers: {
            ...Object.fromEntries(new Headers(init.headers).entries()),
            'accept-encoding': 'identity',
          },
          signal: init.signal || AbortSignal.timeout(15000),
          timeout: 15000,
          ...(pinned
            ? {
                lookup: (_host, options, done) =>
                  options.all
                    ? done(null, [{ address: pinned.address, family: 4 }])
                    : done(null, pinned.address, 4),
              }
            : {}),
        },
        (response) => {
          let size = 0;
          const chunks = [];
          response.on('data', (chunk) => {
            size += chunk.length;
            if (size > 128000) response.destroy(Error('App sign-in response is too large.'));
            else chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () => {
            if (response.statusCode >= 300 && response.statusCode < 400) {
              reject(Error('App sign-in metadata and token requests cannot redirect.'));
              return;
            }
            const headers = new Headers();
            for (const [key, value] of Object.entries(response.headers))
              if (value !== undefined)
                headers.set(key, Array.isArray(value) ? value.join(', ') : value);
            resolve(
              new Response(
                [204, 205, 304].includes(response.statusCode) ? null : Buffer.concat(chunks),
                { status: response.statusCode, headers },
              ),
            );
          });
        },
      );
      request.on('error', reject);
      request.on('timeout', () => request.destroy(Error('App sign-in timed out.')));
      request.end(init.body instanceof URLSearchParams ? init.body.toString() : init.body);
    });
  };
}
export function publicConnection(record) {
  const { token, oauth, ...rest } = record;
  return {
    ...rest,
    ...(record.transport === 'stdio'
      ? {
          launch: {
            command: record.launch.command,
            args: record.launch.args,
            cwd: record.launch.cwd,
            envKeys: Object.keys(record.launch.env),
          },
        }
      : {}),
    hasToken: !!token,
    authentication: oauth ? 'oauth' : token ? 'token' : 'none',
    ...(oauth
      ? {
          signInNeeded: !!oauth.needsSignIn || !!oauth.refreshing,
          signInHost: new URL(oauth.issuer).host,
        }
      : {}),
  };
}
export class ConnectorOAuth {
  constructor(connectors, { fetchFactory = oauthFetch } = {}) {
    this.connectors = connectors;
    this.store = connectors.store;
    this.key = connectors.key;
    this.fetchFactory = fetchFactory;
    this.refreshes = new Map();
    this.results = new Map();
    // A process restart cannot safely repeat a possibly consumed authorization code.
    for (const flow of this.flows())
      if (flow.phase === 'exchanging') {
        flow.phase = 'failed';
        flow.error = 'Sign-in was interrupted. Start a new sign-in.';
        delete flow.codeVerifier;
        this.writeFlow(flow);
      }
  }
  flows() {
    const raw = this.store.secret('connector-oauth');
    return raw ? decrypt(raw, this.key) : [];
  }
  writeFlow(flow) {
    const all = this.flows().filter((f) => f.id !== flow.id && f.expires > Date.now());
    this.store.secret('connector-oauth', encrypt([...all, flow], this.key));
  }
  flow(id) {
    return this.flows().find((f) => f.id === id && f.expires > Date.now());
  }
  cancel(id) {
    const flow = this.flow(id);
    this.store.secret(
      'connector-oauth',
      encrypt(
        this.flows().filter((f) => f.id !== id),
        this.key,
      ),
    );
    if (flow)
      for (const [id, discovery] of this.connectors.discoveries)
        if (discovery.oauthFlowId === flow.id) this.connectors.discoveries.delete(id);
    return { ok: true };
  }
  cancelConnection(id) {
    for (const flow of this.flows()) if (flow.record.id === id) this.cancel(flow.id);
  }
  validRecord(flow) {
    const prior = this.connectors.record(flow.record.id);
    if ((prior?.revision || 0) !== flow.record.revision - 1)
      throw Error('This app changed. Start its sign-in again.');
  }
  async begin(input, origin) {
    if (this.flows().filter((f) => f.expires > Date.now()).length >= 8)
      throw Error('Finish or cancel an existing app sign-in first.');
    const record = this.connectors.candidate({ ...input, token: '' });
    delete record.oauth;
    if (!input.id && this.connectors.read().length >= 20)
      throw Error('You can connect up to twenty apps.');
    const fetchFn = this.fetchFactory(record.endpoint);
    let info, client;
    try {
      info = await discoverOAuthServerInfo(record.endpoint, { fetchFn });
      const metadata = info.authorizationServerMetadata;
      if (!metadata || new URL(metadata.issuer).href !== new URL(info.authorizationServerUrl).href)
        throw Error('Issuer mismatch');
      address(info.authorizationServerUrl, record.endpoint);
      for (const name of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint'])
        if (metadata[name]) {
          const endpoint = address(metadata[name], record.endpoint);
          if (!local(endpoint)) await resolveDestination(endpoint.href);
        }
      if (!metadata.code_challenge_methods_supported?.includes('S256'))
        throw Error('PKCE S256 is required');
      if (
        !info.resourceMetadata?.resource ||
        new URL(info.resourceMetadata.resource).href !== new URL(record.endpoint).href
      )
        throw Error('Resource mismatch');
      const redirectUri = `${new URL(origin).origin}/api/connectors/oauth/callback`;
      const scope = (info.resourceMetadata.scopes_supported || []).join(' ');
      if (scope.length > 4000 || /[\x00-\x1f\x7f]/.test(scope)) throw Error('Invalid scopes');
      const prior = input.id ? this.connectors.record(input.id) : null;
      const savedClient =
        prior?.endpoint === record.endpoint && prior.oauth?.issuer === info.authorizationServerUrl
          ? prior.oauth.client
          : null;
      if (input.clientId) {
        if (
          typeof input.clientId !== 'string' ||
          input.clientId.length > 2000 ||
          typeof (input.clientSecret || '') !== 'string' ||
          (input.clientSecret || '').length > 8192
        )
          throw Error('Invalid client');
        client = {
          client_id: input.clientId,
          ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
          issuer: info.authorizationServerUrl,
        };
      } else if (savedClient) {
        client = savedClient;
      } else {
        client = {
          ...(await registerClient(info.authorizationServerUrl, {
            metadata,
            clientMetadata: {
              client_name: 'Relay personal assistant',
              redirect_uris: [redirectUri],
              grant_types: ['authorization_code', 'refresh_token'],
              response_types: ['code'],
              token_endpoint_auth_method: 'none',
            },
            scope,
            fetchFn,
          })),
          issuer: info.authorizationServerUrl,
        };
      }
      const state = secret(),
        ticket = secret();
      const { authorizationUrl, codeVerifier } = await startAuthorization(
        info.authorizationServerUrl,
        {
          metadata,
          clientInformation: client,
          redirectUrl: redirectUri,
          scope,
          state,
          resource: info.resourceMetadata.resource,
        },
      );
      const flow = {
        id: randomUUID(),
        record,
        info,
        client,
        redirectUri,
        scope,
        state,
        codeVerifier,
        authorizationUrl: authorizationUrl.href,
        ticketHash: digest(ticket),
        phase: 'created',
        expires: Date.now() + lifetime,
      };
      this.validRecord(flow);
      this.writeFlow(flow);
      return {
        id: flow.id,
        host: authorizationUrl.host,
        scopes: scope.split(' ').filter(Boolean),
        openUrl: `${new URL(origin).origin}/api/connectors/oauth/open?id=${flow.id}&ticket=${ticket}`,
      };
    } catch {
      throw Error(
        'This app could not start browser sign-in. Check its OAuth support or add its registered client details.',
      );
    }
  }
  open(id, ticket) {
    const flow = this.flow(id);
    if (
      !flow ||
      flow.phase !== 'created' ||
      typeof ticket !== 'string' ||
      digest(ticket) !== flow.ticketHash
    )
      throw Error('This sign-in link expired or was already opened. Start again in Relay.');
    this.validRecord(flow);
    const nonce = secret();
    flow.browserHash = digest(nonce);
    delete flow.ticketHash;
    flow.phase = 'waiting';
    this.writeFlow(flow);
    return {
      url: flow.authorizationUrl,
      nonce,
      cookie: `relay_app_${flow.id.replaceAll('-', '')}`,
    };
  }
  async callback(params, cookies) {
    const flow = this.flows().find((f) => f.state === params.state && f.expires > Date.now());
    if (
      !flow ||
      flow.phase !== 'waiting' ||
      digest(cookies[`relay_app_${flow.id.replaceAll('-', '')}`] || '') !== flow.browserHash
    )
      throw Error('This app sign-in did not match its browser. Start again in Relay.');
    this.validRecord(flow);
    if (params.error) {
      flow.phase = 'failed';
      flow.error = 'Sign-in was cancelled or declined. You can try again.';
      this.writeFlow(flow);
      return flow.id;
    }
    if (
      typeof params.code !== 'string' ||
      !params.code ||
      params.code.length > 8192 ||
      (params.iss && params.iss !== flow.info.authorizationServerUrl)
    )
      throw Error('This app returned an invalid sign-in response.');
    flow.phase = 'exchanging';
    this.writeFlow(flow);
    try {
      const tokens = await exchangeAuthorization(flow.info.authorizationServerUrl, {
        metadata: flow.info.authorizationServerMetadata,
        clientInformation: flow.client,
        authorizationCode: params.code,
        codeVerifier: flow.codeVerifier,
        redirectUri: flow.redirectUri,
        resource: flow.info.resourceMetadata.resource,
        fetchFn: this.fetchFactory(flow.record.endpoint),
      });
      this.validRecord(flow);
      if (!this.flow(flow.id) || this.flow(flow.id).phase !== 'exchanging') return flow.id;
      if (tokens.token_type.toLowerCase() !== 'bearer') throw Error('Unsupported token');
      flow.record.token = tokens.access_token;
      flow.record.oauth = {
        issuer: flow.info.authorizationServerUrl,
        metadata: flow.info.authorizationServerMetadata,
        resource: flow.info.resourceMetadata.resource,
        client: flow.client,
        tokens,
        expiresAt: expiry(tokens),
        scope: tokens.scope || flow.scope,
      };
      flow.phase = 'authorized';
      delete flow.codeVerifier;
      delete flow.authorizationUrl;
      delete flow.browserHash;
      this.writeFlow(flow);
    } catch {
      if (this.flow(flow.id)?.phase === 'exchanging') {
        flow.phase = 'failed';
        flow.error = 'Sign-in could not be confirmed. Start a new sign-in.';
        delete flow.codeVerifier;
        this.writeFlow(flow);
      }
    }
    return flow.id;
  }
  async result(id) {
    const flow = this.flow(id);
    if (!flow) throw Error('This app sign-in expired. Start again.');
    this.validRecord(flow);
    if (flow.phase === 'failed' || flow.phase === 'exchanging')
      return { phase: flow.phase, error: flow.error };
    if (flow.phase !== 'authorized')
      return {
        phase: 'waiting',
        connection: publicConnection(flow.record),
        existing: !!this.connectors.record(flow.record.id),
      };
    const existing = [...this.connectors.discoveries.entries()].find(
      ([, d]) => d.oauthFlowId === id && d.expires > Date.now(),
    );
    if (existing)
      return {
        phase: 'ready',
        discoveryId: existing[0],
        connection: publicConnection(existing[1].record),
        existing: !!this.connectors.record(flow.record.id),
      };
    if (this.results.has(id)) return this.results.get(id);
    const work = (async () => {
      const result = await this.connectors.discoverRecord(flow.record);
      try {
        this.validRecord(flow);
        if (!this.flow(id)) throw Error('This sign-in was cancelled.');
      } catch (error) {
        this.connectors.discoveries.delete(result.discoveryId);
        throw error;
      }
      this.connectors.discoveries.get(result.discoveryId).oauthFlowId = id;
      return { phase: 'ready', ...result, existing: !!this.connectors.record(flow.record.id) };
    })().finally(() => this.results.delete(id));
    this.results.set(id, work);
    return work;
  }
  async credentials(record) {
    if (!record.oauth) return record;
    const key = `${record.id}:${record.revision}`;
    if (this.refreshes.has(key)) return this.refreshes.get(key);
    if (record.oauth.needsSignIn || record.oauth.refreshing) throw signInError();
    if (record.oauth.expiresAt === null || record.oauth.expiresAt > Date.now() + 30000)
      return record;
    const work = this.refresh(record).finally(() => this.refreshes.delete(key));
    this.refreshes.set(key, work);
    return work;
  }
  replaceCredentials(record, oauth) {
    const current = this.connectors.record(record.id);
    if (
      !current ||
      current.revision !== record.revision ||
      current.oauth?.tokens.access_token !== record.oauth.tokens.access_token
    )
      throw signInError();
    const next = { ...current, token: oauth.tokens.access_token, oauth };
    // Credential rotation does not change tool policy or invalidate a frozen review.
    this.store.secret(
      'app-connectors',
      encrypt(
        this.connectors.read().map((r) => (r.id === next.id ? next : r)),
        this.key,
      ),
    );
    return next;
  }
  async refresh(record) {
    const original = record.oauth;
    if (!original.tokens.refresh_token) {
      this.replaceCredentials(record, { ...original, needsSignIn: true });
      throw signInError();
    }
    this.replaceCredentials(record, { ...original, refreshing: true });
    try {
      const tokens = await refreshAuthorization(original.issuer, {
        metadata: original.metadata,
        clientInformation: original.client,
        refreshToken: original.tokens.refresh_token,
        resource: original.resource,
        fetchFn: this.fetchFactory(record.endpoint),
      });
      if (tokens.token_type.toLowerCase() !== 'bearer') throw Error('Unsupported token');
      return this.replaceCredentials(record, {
        ...original,
        tokens: { ...tokens, refresh_token: tokens.refresh_token || original.tokens.refresh_token },
        refreshing: false,
        needsSignIn: false,
        expiresAt: expiry(tokens),
      });
    } catch {
      // A lost response can consume a rotating refresh token. Never retry it blindly.
      try {
        this.replaceCredentials(record, { ...original, refreshing: false, needsSignIn: true });
      } catch {}
      throw signInError();
    }
  }
}
