// SPDX-License-Identifier: MIT
import { connect } from 'node:http2';
import { createPrivateKey, sign, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const b64 = (value) =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const digest = (value) => createHash('sha256').update(value).digest('hex');
function jwt(header, payload, key, algorithm) {
  const input = `${b64(header)}.${b64(payload)}`;
  const signature = sign(
    algorithm,
    Buffer.from(input),
    algorithm === 'sha256' ? { key, dsaEncoding: 'ieee-p1363' } : key,
  );
  return `${input}.${signature.toString('base64url')}`;
}
const failure = (message, extra = {}) =>
  Object.assign(Error(message), { pushFailure: true }, extra);
async function jsonResponse(response) {
  const reader = response.body?.getReader();
  if (!reader) throw failure('The push provider returned no response.', { uncertain: true });
  let size = 0,
    chunks = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > 16384)
        throw failure('The push provider returned an invalid response.', { uncertain: true });
      chunks.push(Buffer.from(next.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw failure('The push provider returned an invalid response.', { uncertain: true });
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export class PushProviders {
  constructor({
    apns,
    fcm,
    fetcher = fetch,
    http2Connect = connect,
    testEndpoints = {},
    timeoutMs = 12000,
  } = {}) {
    this.fetcher = fetcher;
    this.http2Connect = http2Connect;
    this.timeoutMs = timeoutMs;
    this.testEndpoints = testEndpoints;
    if (apns) {
      if (
        !/^[A-Z0-9]{10}$/.test(apns.keyId) ||
        !/^[A-Z0-9]{10}$/.test(apns.teamId) ||
        !/^[a-zA-Z0-9.-]{1,180}$/.test(apns.topic) ||
        !['development', 'production'].includes(apns.environment)
      )
        throw Error('Check the Apple push server settings.');
      const key = createPrivateKey(apns.key);
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
        throw Error('Use an Apple P-256 push signing key.');
      this.apns = { ...apns, key };
    }
    if (fcm) {
      if (
        !/^[a-z][a-z0-9-]{4,62}$/.test(fcm.projectId) ||
        !/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.gserviceaccount\.com$/.test(fcm.email)
      )
        throw Error('Check the Firebase push server settings.');
      const key = createPrivateKey(fcm.key);
      if (key.asymmetricKeyType !== 'rsa')
        throw Error('Use the Firebase service account signing key.');
      this.fcm = { ...fcm, key };
    }
  }
  status() {
    return { ios: !!this.apns, android: !!this.fcm, desktop: true };
  }
  async send(device, event, { id, workspaceId, signal } = {}) {
    const title = device.preview ? String(event.title).slice(0, 100) : 'Relay';
    const body = device.preview
      ? String(event.body).slice(0, 240)
      : 'You have an update. Open Relay to see it.';
    const data = { relayWorkspace: workspaceId, relayNotice: event.id };
    if (device.platform === 'ios')
      return this.apple(
        device.token,
        {
          aps: { alert: { title, body }, sound: 'default', 'thread-id': 'relay-updates' },
          ...data,
        },
        id,
        event.id,
        signal,
      );
    if (device.platform === 'android')
      return this.google(device.token, { title, body }, data, event.id, signal);
    throw failure('Push is not configured for this device.');
  }
  async apple(token, payload, id, eventId, signal) {
    if (!this.apns) throw failure('Apple push is not configured on this server.');
    const now = Math.floor(Date.now() / 1000);
    if (!this.apnsToken || now - this.apnsIssued > 2700) {
      this.apnsToken = jwt(
        { alg: 'ES256', kid: this.apns.keyId },
        { iss: this.apns.teamId, iat: now },
        this.apns.key,
        'sha256',
      );
      this.apnsIssued = now;
    }
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > 4096) throw failure('The notification is too large.');
    const endpoint =
      this.testEndpoints.apns ||
      (this.apns.environment === 'production'
        ? 'https://api.push.apple.com'
        : 'https://api.sandbox.push.apple.com');
    return new Promise((resolve, reject) => {
      let session,
        request,
        dispatched = false,
        settled = false,
        status = 0,
        response = '';
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        request?.destroy();
        session?.destroy();
        error ? reject(error) : resolve(value);
      };
      const abort = () =>
        finish(failure('Push delivery was interrupted.', { uncertain: dispatched }));
      const timer = setTimeout(abort, this.timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) return abort();
      try {
        session = this.http2Connect(endpoint);
        session.on('error', () =>
          finish(
            failure('Could not reach Apple push.', {
              uncertain: dispatched,
              retryable: !dispatched,
            }),
          ),
        );
        session.once('connect', () => {
          if (settled) return;
          request = session.request({
            ':method': 'POST',
            ':path': `/3/device/${token}`,
            authorization: `bearer ${this.apnsToken}`,
            'apns-topic': this.apns.topic,
            'apns-push-type': 'alert',
            'apns-priority': '10',
            'apns-id': id,
            'apns-collapse-id': digest(eventId),
            'apns-expiration': String(now + 3600),
            'content-type': 'application/json',
          });
          request.on('response', (headers) => {
            status = Number(headers[':status']);
          });
          request.on('data', (chunk) => {
            response += chunk.toString('utf8');
            if (Buffer.byteLength(response) > 16384) abort();
          });
          request.on('error', () =>
            finish(
              failure('Apple push did not confirm the notification.', { uncertain: dispatched }),
            ),
          );
          request.on('end', () => {
            if (status === 200) return finish(null, { accepted: true });
            let reason;
            try {
              reason = JSON.parse(response).reason;
            } catch {}
            finish(
              failure(
                status === 403
                  ? 'Apple rejected the server push credentials.'
                  : 'Apple did not accept this notification.',
                {
                  invalidDevice: [
                    'BadDeviceToken',
                    'DeviceTokenNotForTopic',
                    'Unregistered',
                  ].includes(reason),
                  retryable: status === 429 || status >= 500,
                },
              ),
            );
          });
          dispatched = true;
          request.end(body);
        });
      } catch {
        finish(failure('Could not prepare the Apple notification.', { uncertain: dispatched }));
      }
    });
  }
  async accessToken(signal) {
    if (this.fcmToken && this.fcmExpires > Date.now() + 60000) return this.fcmToken;
    const now = Math.floor(Date.now() / 1000);
    const assertion = jwt(
      { alg: 'RS256', typ: 'JWT' },
      {
        iss: this.fcm.email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      },
      this.fcm.key,
      'RSA-SHA256',
    );
    let response;
    try {
      response = await this.fetcher(
        this.testEndpoints.oauth || 'https://oauth2.googleapis.com/token',
        {
          method: 'POST',
          redirect: 'error',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion,
          }),
          signal,
        },
      );
    } catch {
      throw failure('Could not authenticate Firebase push.', { retryable: true });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw failure('Firebase rejected the server push credentials.', {
        retryable: response.status === 429 || response.status >= 500,
      });
    }
    let result;
    try {
      result = await jsonResponse(response);
    } catch {
      throw failure('Firebase returned an invalid authentication response.', { retryable: true });
    }
    if (
      typeof result.access_token !== 'string' ||
      !result.access_token ||
      /[\s\r\n]/.test(result.access_token) ||
      result.access_token.length > 8192 ||
      !(result.expires_in > 0)
    )
      throw failure('Firebase returned an invalid authentication response.');
    this.fcmToken = result.access_token;
    this.fcmExpires = Date.now() + Math.min(result.expires_in, 3600) * 1000;
    return this.fcmToken;
  }
  async google(token, notification, data, eventId, signal) {
    if (!this.fcm) throw failure('Firebase push is not configured on this server.');
    const combined = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
      : AbortSignal.timeout(this.timeoutMs);
    const access = await this.accessToken(combined);
    combined.throwIfAborted();
    let response;
    try {
      response = await this.fetcher(
        this.testEndpoints.fcm ||
          `https://fcm.googleapis.com/v1/projects/${this.fcm.projectId}/messages:send`,
        {
          method: 'POST',
          redirect: 'error',
          signal: combined,
          headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: {
              token,
              notification,
              data,
              android: {
                priority: 'HIGH',
                ttl: '3600s',
                collapse_key: digest(eventId).slice(0, 32),
                notification: {
                  channel_id: 'relay_updates',
                  tag: digest(eventId),
                  sound: 'default',
                },
              },
            },
          }),
        },
      );
    } catch {
      throw failure('Firebase did not confirm the notification.', { uncertain: true });
    }
    const result = await jsonResponse(response);
    if (response.ok && typeof result.name === 'string') return { accepted: true };
    const invalidDevice = result.error?.details?.some(
      (d) =>
        d['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError' &&
        d.errorCode === 'UNREGISTERED',
    );
    throw failure(
      response.status === 401 || response.status === 403
        ? 'Firebase rejected the server push credentials.'
        : 'Firebase did not accept this notification.',
      { invalidDevice, retryable: response.status === 429 || response.status >= 500 },
    );
  }
}
export function pushProvidersFromEnvironment(env = process.env) {
  let apns, fcm;
  try {
    if (env.RELAY_APNS_KEY_PATH)
      apns = {
        key: readFileSync(env.RELAY_APNS_KEY_PATH, 'utf8'),
        keyId: env.RELAY_APNS_KEY_ID,
        teamId: env.RELAY_APNS_TEAM_ID,
        topic: env.RELAY_APNS_TOPIC || 'org.relay.assistant',
        environment: env.RELAY_APNS_ENVIRONMENT || 'development',
      };
    if (env.RELAY_FCM_SERVICE_ACCOUNT) {
      const j = JSON.parse(readFileSync(env.RELAY_FCM_SERVICE_ACCOUNT, 'utf8'));
      fcm = { key: j.private_key, email: j.client_email, projectId: j.project_id };
    }
    return new PushProviders({ apns, fcm });
  } catch {
    throw Error(
      'Push settings could not be loaded. Check the server signing-key files and identifiers.',
    );
  }
}
