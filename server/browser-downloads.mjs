// SPDX-License-Identifier: MIT
import { command } from '../shared/domain.mjs';

const fail = (message) => new Error(message);
const header = (headers, name) => {
  const value = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name)?.[1];
  if (Array.isArray(value)) throw fail('The downloaded file has ambiguous headers.');
  return String(value || '');
};
export function downloadName(disposition, hint = '') {
  let name = hint;
  let decoded = false;
  const extended = disposition.match(/(?:^|;)\s*filename\*\s*=\s*UTF-8'[^']*'([^;]*)/i);
  const plain = disposition.match(/(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/i);
  if (extended) {
    try {
      name = decodeURIComponent(extended[1].trim());
      decoded = !!name;
    } catch {
      /* Fall back to filename. */
    }
  }
  if (!decoded && plain) name = (plain[1] ?? plain[2]).replace(/\\(.)/g, '$1');
  name = String(name)
    .split(/[\\/]/)
    .at(-1)
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim();
  name = name.replace(/^\.+/, '').slice(0, 180);
  return name || 'download';
}

// A download is saved only by the broker after the exact request has completed.
// The file and its action association commit together; repeating an action never fetches it again.
export class BrowserDownloads {
  constructor(store, vault) {
    this.store = store;
    this.vault = vault;
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS trusted_browser_downloads (source_id TEXT PRIMARY KEY, action_id TEXT NOT NULL, file_id TEXT NOT NULL, bytes INTEGER NOT NULL, created TEXT NOT NULL)',
    );
  }
  save({ sourceId, actionId, response, hint = '', guard }) {
    guard();
    if (
      response.status < 200 ||
      response.status >= 300 ||
      response.status === 204 ||
      response.status === 206 ||
      header(response.headers, 'content-range')
    )
      throw fail('The website did not return a complete file.');
    const encoding = header(response.headers, 'content-encoding');
    if (encoding && encoding.toLowerCase() !== 'identity')
      throw fail('This download uses an unsupported content encoding.');
    if (!(response.body instanceof Uint8Array) || response.body.byteLength > 8_000_000)
      throw fail('Download files of 8 MB or less.');
    const name = downloadName(header(response.headers, 'content-disposition'), hint);
    const mime = header(response.headers, 'content-type').split(';')[0].trim().toLowerCase();
    const text = Buffer.from(response.body).toString('utf8');
    // Known browser secrets must not escape through the general Files library.
    // This is not content classification, archive inspection, or general taint tracking.
    if (
      this.vault.redact(name) !== name ||
      this.vault.redact(mime) !== mime ||
      this.vault.redact(text) !== text
    )
      throw fail(
        'This file contains a known private browser value and cannot be shared with Relay.',
      );
    return this.store.mutate((state) => {
      guard();
      const prior = this.store.db
        .prepare('SELECT file_id FROM trusted_browser_downloads WHERE source_id=?')
        .get(sourceId);
      if (prior) return prior.file_id;
      const action = this.store.db
        .prepare('SELECT phase FROM trusted_browser_actions WHERE id=?')
        .get(actionId);
      if (action?.phase !== 'running') throw fail('This browser action is no longer running.');
      const used = this.store.db
        .prepare(
          'SELECT count(*) AS count, COALESCE(sum(bytes),0) AS bytes FROM trusted_browser_downloads WHERE action_id=?',
        )
        .get(actionId);
      if (used.count >= 4 || used.bytes + response.body.byteLength > 8_000_000)
        throw fail('This action reached its download limit: four files and 8 MB total.');
      const file = command(state, 'file.add', {
        name,
        mime: /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)
          ? mime
          : 'application/octet-stream',
        base64: Buffer.from(response.body).toString('base64'),
        ...(/^(text\/|application\/json$)/.test(mime) ? { text } : {}),
      });
      file.size = response.body.byteLength;
      file.source = 'Private browser';
      this.store.db
        .prepare('INSERT INTO trusted_browser_downloads VALUES (?,?,?,?,?)')
        .run(sourceId, actionId, file.id, file.size, file.createdAt);
      return file.id;
    });
  }
  list(actionId) {
    const rows = actionId
      ? this.store.db
          .prepare('SELECT file_id FROM trusted_browser_downloads WHERE action_id=? ORDER BY rowid')
          .all(actionId)
      : this.store.db
          .prepare('SELECT file_id FROM trusted_browser_downloads ORDER BY rowid DESC LIMIT 6')
          .all();
    const files = this.store.read().files;
    return rows.flatMap(({ file_id }) => {
      const file = files.find((f) => f.id === file_id);
      return file ? [{ id: file.id, name: file.name, mime: file.mime, size: file.size }] : [];
    });
  }
}
