// SPDX-License-Identifier: MIT
import { randomBytes } from 'node:crypto';
import { encrypt, decrypt } from './google.mjs';

const ALIAS = /relay_cookie_[a-f0-9]{48}/g;
const cookieName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const cookieValue = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;
const fail = (message) => Object.assign(new Error(message), { status: 409 });
// Known-value filtering covers common transport encodings; arbitrary secret
// transformations still require taint tracking and an independent policy layer.
function decoded(value) {
  return String(value)
    .replace(/\\u([\da-f]{4})/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/(?:%[\da-f]{2})+/gi, (part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    })
    .replace(/\+/g, ' ');
}
function originOf(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw fail('A complete HTTPS website address is required.');
  }
  if (url.protocol !== 'https:' || url.username || url.password)
    throw fail('Private browser sessions require HTTPS without credentials in the address.');
  return url.origin;
}

/** Private broker state. Never put this object or storageState in workspace state.
 * Cookies in Chromium are random surrogates. Real values leave this vault only
 * for a concrete request to the exact origin which issued that surrogate.
 */
export class BrowserVault {
  constructor(store, key) {
    this.store = store;
    this.key = key;
    this.read();
  }
  read() {
    const raw = this.store.secret('trusted-browser-vault');
    if (!raw)
      return {
        version: 1,
        revision: 0,
        generation: 0,
        cookies: [],
        logins: [],
        storage: undefined,
      };
    try {
      const value = decrypt(raw, this.key);
      value.generation ??= 0;
      value.privateInputs ??= [];
      if (
        value.version !== 1 ||
        !Number.isSafeInteger(value.revision) ||
        value.revision < 0 ||
        !Number.isSafeInteger(value.generation) ||
        value.generation < 0 ||
        !Array.isArray(value.cookies) ||
        value.cookies.length > 2048 ||
        !Array.isArray(value.logins) ||
        value.logins.length > 50 ||
        !Array.isArray(value.privateInputs) ||
        value.privateInputs.length > 100 ||
        value.privateInputs.some(
          (entry) =>
            !entry ||
            originOf(entry.origin) !== entry.origin ||
            typeof entry.value !== 'string' ||
            !entry.value ||
            entry.value.length > 4096,
        ) ||
        value.cookies.some(
          (c) =>
            !c ||
            typeof c.origin !== 'string' ||
            originOf(c.origin) !== c.origin ||
            !/^relay_cookie_[a-f0-9]{48}$/.test(c.alias) ||
            !cookieName.test(c.name) ||
            typeof c.value !== 'string' ||
            !cookieValue.test(c.value),
        ) ||
        value.logins.some(
          (l) =>
            !l ||
            typeof l.origin !== 'string' ||
            originOf(l.origin) !== l.origin ||
            typeof l.username !== 'string' ||
            typeof l.password !== 'string' ||
            !l.password,
        )
      )
        throw Error();
      return value;
    } catch {
      throw fail('Saved browser sessions could not be unlocked. Restore the vault key.');
    }
  }
  write(state) {
    state.revision++;
    this.store.secret('trusted-browser-vault', encrypt(state, this.key));
  }
  /** Preserve the browser's Set-Cookie parsing and scope rules, but give it no real token. */
  sealCookies(origin, headers) {
    origin = originOf(origin);
    const state = this.read();
    const result = [];
    for (const header of Array.isArray(headers) ? headers : [headers]) {
      if (typeof header !== 'string' || header.length > 16384 || /[\r\n]/.test(header)) continue;
      const separator = header.indexOf(';');
      const pair = separator < 0 ? header : header.slice(0, separator);
      const equals = pair.indexOf('=');
      if (equals < 1) continue;
      const name = pair.slice(0, equals).trim();
      let value = pair.slice(equals + 1).trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (!cookieName.test(name) || !cookieValue.test(value)) continue;
      const suffix = separator < 0 ? '' : header.slice(separator);
      // Keep aliases stable when a server reissues the same cookie. Old aliases
      // may still be in a valid path/domain cookie jar after a rotation.
      let entry = state.cookies.find(
        (c) => c.origin === origin && c.name === name && c.value === value,
      );
      if (!entry) {
        if (state.cookies.length >= 2048)
          throw fail('The browser cookie vault is full. Clear an unused session first.');
        entry = { alias: `relay_cookie_${randomBytes(24).toString('hex')}`, origin, name, value };
        state.cookies.push(entry);
      }
      result.push(`${name}=${entry.alias}${suffix}`);
    }
    if (result.length) this.write(state);
    return result;
  }
  materialize(value, origin, encoding = 'raw') {
    const state = this.read();
    origin = originOf(origin);
    return String(value).replace(ALIAS, (alias) => {
      const credential = state.cookies.find((c) => c.alias === alias);
      if (!credential || credential.origin !== origin)
        throw fail('A browser credential cannot be used at this destination.');
      return encoding === 'url' ? encodeURIComponent(credential.value) : credential.value;
    });
  }
  request(input) {
    const origin = originOf(input.url);
    const raw = `${input.url}\n${JSON.stringify(input.headers || {})}\n${input.body ? Buffer.from(input.body).toString('latin1') + '\n' + Buffer.from(input.body).toString('utf8') : ''}`;
    const representations = [raw, decoded(raw)];
    const state = this.read();
    for (const secret of [
      ...state.cookies,
      ...state.logins.map((l) => ({ origin: l.origin, value: l.password })),
      ...(state.privateInputs || []),
    ]) {
      if (
        secret.origin !== origin &&
        secret.value &&
        [
          secret.value,
          encodeURIComponent(secret.value),
          Buffer.from(secret.value).toString('base64'),
        ].some((value) => representations.some((text) => text.includes(value)))
      )
        throw fail('A browser credential cannot be used at this destination.');
    }
    const url = this.materialize(input.url, origin, 'url');
    if (new URL(url).origin !== origin)
      throw fail('Credential replacement changed the destination.');
    const headers = Object.create(null);
    for (const [name, value] of Object.entries(input.headers || {})) {
      // The broker supplies transport headers. Referrers must not carry private
      // navigation details, including opaque credential aliases, across sites.
      if (
        /^(?:host|connection|content-length|accept-encoding|proxy-.*|referer|upgrade|te|trailer|transfer-encoding|keep-alive)$/i.test(
          name,
        )
      )
        continue;
      headers[name.toLowerCase()] = this.materialize(value, origin);
    }
    let body = input.body ? Buffer.from(input.body) : undefined;
    if (body) {
      // Replace ASCII alias bytes without a UTF-8 round trip of uploaded files.
      const encoding = String(headers['content-type'] || '').includes(
        'application/x-www-form-urlencoded',
      )
        ? 'url'
        : 'raw';
      const latin = body.toString('latin1');
      body = Buffer.from(this.materialize(latin, origin, encoding), 'latin1');
    }
    return { ...input, url, headers, body };
  }
  saveLogin(origin, { username, password }) {
    origin = originOf(origin);
    if (
      typeof username !== 'string' ||
      typeof password !== 'string' ||
      !password ||
      username.length > 512 ||
      password.length > 4096
    )
      throw fail('Enter a username and password within the supported limits.');
    const state = this.read();
    state.logins = state.logins.filter((entry) => entry.origin !== origin);
    if (state.logins.length >= 50) throw fail('The browser login vault is full.');
    state.logins.push({ origin, username, password });
    state.generation++;
    this.write(state);
  }
  login(origin) {
    return this.read().logins.find((entry) => entry.origin === originOf(origin));
  }
  rememberPrivate(origin, value) {
    origin = originOf(origin);
    if (typeof value !== 'string' || !value || value.length > 4096)
      throw fail('This private input exceeds the supported limit.');
    const state = this.read();
    state.privateInputs ??= [];
    if (state.privateInputs.some((entry) => entry.origin === origin && entry.value === value))
      return;
    if (state.privateInputs.length >= 100)
      throw fail('The browser private-input vault is full. Clear a session first.');
    state.privateInputs.push({ origin, value });
    this.write(state);
  }
  saveStorage(storage) {
    if (Buffer.byteLength(JSON.stringify(storage)) > 8_000_000)
      throw fail('The browser session exceeds its storage limit.');
    const state = this.read();
    state.storage = storage;
    this.write(state);
  }
  storage() {
    return this.read().storage;
  }
  clear() {
    const previous = this.read();
    this.write({
      version: 1,
      revision: previous.revision,
      generation: previous.generation + 1,
      cookies: [],
      logins: [],
      privateInputs: [],
      storage: undefined,
    });
  }
  generation() {
    return this.read().generation;
  }
  redact(value, extra = []) {
    const state = this.read();
    const secrets = [
      ...extra,
      ...state.cookies.flatMap((c) => [c.alias, c.value]),
      ...state.logins.flatMap((l) => [l.username, l.password]),
      ...(state.privateInputs || []).map((entry) => entry.value),
    ].filter((v) => typeof v === 'string' && v.length);
    const variants = [
      ...new Set(
        secrets.flatMap((v) => [v, encodeURIComponent(v), Buffer.from(v).toString('base64')]),
      ),
    ].sort((a, b) => b.length - a.length);
    let text = String(value);
    text = text.replace(/[^\s"'<>/:?&#=]+/g, (part) => {
      if (!/%[\da-f]{2}|\\u[\da-f]{4}|\+/i.test(part)) return part;
      const normalized = decoded(part);
      return variants.some((secret) => normalized.includes(secret)) ? '[private]' : part;
    });
    for (const secret of variants) text = text.replaceAll(secret, '[private]');
    return text;
  }
}
