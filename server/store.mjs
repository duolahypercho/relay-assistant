// SPDX-License-Identifier: MIT
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import { pruneIdeas } from '../shared/ideas.mjs';
import { createWorkspace } from '../shared/seed.mjs';
export class Store extends EventEmitter {
  constructor(path, { sample = true } = {}) {
    super();
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (digest TEXT PRIMARY KEY, expires INTEGER NOT NULL);',
    );
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS voice_memos (id TEXT PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, transcript TEXT NOT NULL, audio BLOB NOT NULL, created_at TEXT NOT NULL)',
    );
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS agent_checkpoints (run_id TEXT PRIMARY KEY, phase TEXT NOT NULL, body TEXT NOT NULL)',
    );
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS computer_file_attachments (operation_key TEXT PRIMARY KEY, input_hash TEXT NOT NULL, file_id TEXT NOT NULL, fingerprint TEXT NOT NULL)',
    );
    if (!this.db.prepare('SELECT id FROM workspace WHERE id=1').get())
      this.db
        .prepare('INSERT INTO workspace VALUES (1,0,?)')
        .run(JSON.stringify(createWorkspace({ sample })));
  }
  read() {
    return JSON.parse(this.db.prepare('SELECT body FROM workspace WHERE id=1').get().body);
  }
  mutate(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    let state, result;
    try {
      const row = this.db.prepare('SELECT version,body FROM workspace WHERE id=1').get();
      state = JSON.parse(row.body);
      result = fn(state);
      if (result && typeof result.then === 'function')
        throw new Error('Storage mutations must be synchronous.');
      pruneIdeas(state);
      state.revision = row.version + 1;
      this.db
        .prepare('UPDATE workspace SET version=?,body=? WHERE id=1')
        .run(state.revision, JSON.stringify(state));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.emit('change', state);
    return result;
  }
  secret(name, value) {
    if (value === undefined)
      return this.db.prepare('SELECT value FROM secrets WHERE name=?').get(name)?.value;
    if (value === null) this.db.prepare('DELETE FROM secrets WHERE name=?').run(name);
    else
      this.db
        .prepare(
          'INSERT INTO secrets VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value',
        )
        .run(name, value);
  }
  close() {
    this.db.close();
  }
  voiceMemo(id) {
    return this.db.prepare('SELECT * FROM voice_memos WHERE id=?').get(id);
  }
  voiceMemoForSource(key) {
    return this.db.prepare('SELECT id, transcript FROM voice_memos WHERE source_key=?').get(key);
  }
  // Called within mutate() so the audio and its chat card commit together.
  putVoiceMemo({ id, sourceKey, transcript, audio, createdAt }) {
    this.db
      .prepare('INSERT INTO voice_memos VALUES (?,?,?,?,?)')
      .run(id, sourceKey, transcript, audio, createdAt);
  }
  exportVoiceMemos() {
    return this.db
      .prepare('SELECT id,transcript,audio,created_at FROM voice_memos')
      .all()
      .map(({ audio, ...memo }) => ({
        ...memo,
        mime: 'audio/wav',
        base64: Buffer.from(audio).toString('base64'),
      }));
  }
}
