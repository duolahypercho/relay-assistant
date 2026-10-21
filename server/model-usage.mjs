// SPDX-License-Identifier: MIT
import { randomUUID } from 'node:crypto';

const processId = randomUUID();
const count = (n) => (Number.isSafeInteger(n) && n >= 0 && n <= 1e12 ? n : null);
const optional = (n) => (n === undefined || n === null ? 0 : count(n));
const sum = (...values) =>
  values.every((n) => n !== null) ? count(values.reduce((a, b) => a + b, 0)) : null;
const usageFields = [
  'input_tokens',
  'output_tokens',
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'promptTokenCount',
  'candidatesTokenCount',
  'thoughtsTokenCount',
  'totalTokenCount',
  'cachedContentTokenCount',
];
const detailFields = ['cached_tokens', 'cache_write_tokens', 'reasoning_tokens', 'thinking_tokens'];
function counters(source, fields) {
  if (!source || typeof source !== 'object') return {};
  return Object.fromEntries(
    fields
      .filter((key) => Object.hasOwn(source, key))
      .map((key) => [key, source[key] == null ? source[key] : (count(source[key]) ?? NaN)]),
  );
}

// All supported streams report cumulative counters, never increments. Keep
// missing values unknown and never add cache/reasoning subsets a second time.
export function usageCollector(protocol, report = () => {}) {
  let raw = {},
    value = null;
  return {
    get value() {
      return value;
    },
    accept(frame) {
      const incoming =
        protocol === 'gemini'
          ? frame.usageMetadata
          : protocol === 'responses'
            ? frame.response?.usage || frame.usage
            : protocol === 'anthropic'
              ? frame.message?.usage || frame.usage
              : frame.usage;
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return;
      // Retain only known numeric fields, not arbitrary provider metadata.
      raw = { ...raw, ...counters(incoming, usageFields) };
      for (const key of [
        'input_tokens_details',
        'output_tokens_details',
        'prompt_tokens_details',
        'completion_tokens_details',
      ]) {
        if (Object.hasOwn(incoming, key))
          raw[key] = { ...raw[key], ...counters(incoming[key], detailFields) };
      }
      const inputTokens =
        protocol === 'anthropic'
          ? sum(
              count(raw.input_tokens),
              optional(raw.cache_creation_input_tokens),
              optional(raw.cache_read_input_tokens),
            )
          : count(
              protocol === 'gemini'
                ? raw.promptTokenCount
                : protocol === 'responses'
                  ? raw.input_tokens
                  : raw.prompt_tokens,
            );
      const outputTokens =
        protocol === 'gemini'
          ? sum(count(raw.candidatesTokenCount), optional(raw.thoughtsTokenCount))
          : count(protocol === 'chat' ? raw.completion_tokens : raw.output_tokens);
      const total = protocol === 'gemini' ? raw.totalTokenCount : raw.total_tokens;
      const next = {
        inputTokens,
        outputTokens,
        totalTokens: total == null ? sum(inputTokens, outputTokens) : count(total),
        cachedTokens: count(
          protocol === 'gemini'
            ? raw.cachedContentTokenCount
            : protocol === 'anthropic'
              ? raw.cache_read_input_tokens
              : protocol === 'responses'
                ? raw.input_tokens_details?.cached_tokens
                : raw.prompt_tokens_details?.cached_tokens,
        ),
        cacheWriteTokens: count(
          protocol === 'anthropic'
            ? raw.cache_creation_input_tokens
            : protocol === 'responses'
              ? raw.input_tokens_details?.cache_write_tokens
              : raw.prompt_tokens_details?.cache_write_tokens,
        ),
        reasoningTokens: count(
          protocol === 'gemini'
            ? raw.thoughtsTokenCount
            : protocol === 'anthropic'
              ? raw.output_tokens_details?.thinking_tokens
              : protocol === 'responses'
                ? raw.output_tokens_details?.reasoning_tokens
                : raw.completion_tokens_details?.reasoning_tokens,
        ),
      };
      if (Object.values(next).every((n) => n === null)) return;
      if (JSON.stringify(next) !== JSON.stringify(value)) {
        value = next;
        report(next);
      }
    },
  };
}

const columns = {
  inputTokens: 'input_tokens',
  outputTokens: 'output_tokens',
  totalTokens: 'total_tokens',
  cachedTokens: 'cached_tokens',
  cacheWriteTokens: 'cache_write_tokens',
  reasoningTokens: 'reasoning_tokens',
};
export class ModelUsage {
  constructor(store) {
    this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS model_usage (
      id TEXT PRIMARY KEY, process_id TEXT NOT NULL, started_at INTEGER NOT NULL,
      finished_at INTEGER, connection_id TEXT NOT NULL, connection_name TEXT NOT NULL,
      model TEXT NOT NULL, protocol TEXT NOT NULL, purpose TEXT NOT NULL, status TEXT NOT NULL,
      input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
      cached_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER
    ); CREATE INDEX IF NOT EXISTS model_usage_started ON model_usage(started_at);`);
  }
  begin(record, purpose = 'assistant', now = Date.now()) {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO model_usage
      (id,process_id,started_at,connection_id,connection_name,model,protocol,purpose,status)
      VALUES (?,?,?,?,?,?,?,?, 'running')`,
      )
      .run(
        id,
        processId,
        now,
        String(record.id || 'environment').slice(0, 200),
        String(record.name || 'Model').slice(0, 80),
        String(record.model).slice(0, 200),
        record.protocol,
        purpose,
      );
    return {
      report: (value) =>
        this.db
          .prepare(
            `UPDATE model_usage SET
        input_tokens=?,output_tokens=?,total_tokens=?,cached_tokens=?,cache_write_tokens=?,reasoning_tokens=? WHERE id=? AND status='running'`,
          )
          .run(...Object.keys(columns).map((key) => count(value[key])), id),
      finish: (status) =>
        this.db
          .prepare(`UPDATE model_usage SET status=?,finished_at=? WHERE id=? AND status='running'`)
          .run(
            ['completed', 'failed', 'cancelled'].includes(status) ? status : 'failed',
            Date.now(),
            id,
          ),
    };
  }
  summary(period = '7d', now = Date.now()) {
    const periods = { '24h': 1, '7d': 7, '30d': 30 };
    const days =
      typeof period === 'string' && Object.hasOwn(periods, period) ? periods[period] : null;
    if (!days)
      throw Object.assign(new Error('Choose the last 24 hours, 7 days or 30 days.'), {
        status: 400,
      });
    const since = now - days * 86400000;
    const selection = `COUNT(*) AS requests,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled,
      SUM(CASE WHEN status='running' AND process_id=? THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN status='running' AND process_id<>? THEN 1 ELSE 0 END) AS interrupted,
      SUM(CASE WHEN total_tokens IS NULL THEN 1 ELSE 0 END) AS unreported,
      SUM(CASE WHEN purpose='connection-test' THEN 1 ELSE 0 END) AS connectionTests,
      ${Object.entries(columns)
        .map(([key, col]) => `SUM(${col}) AS ${key}, COUNT(${col}) AS ${key}Reports`)
        .join(',')}`;
    const clean = (row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          value === null && !Object.hasOwn(columns, key) ? 0 : value,
        ]),
      );
    const totals = clean(
      this.db
        .prepare(`SELECT ${selection} FROM model_usage WHERE started_at BETWEEN ? AND ?`)
        .get(processId, processId, since, now),
    );
    const models = this.db
      .prepare(
        `SELECT connection_id AS connectionId,connection_name AS name,model,protocol,${selection}
      FROM model_usage WHERE started_at BETWEEN ? AND ? GROUP BY connection_id,connection_name,model,protocol
      ORDER BY requests DESC,model LIMIT 100`,
      )
      .all(processId, processId, since, now)
      .map(clean);
    const modelCount = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM
      (SELECT 1 FROM model_usage WHERE started_at BETWEEN ? AND ? GROUP BY connection_id,connection_name,model,protocol)`,
      )
      .get(since, now).n;
    return {
      period,
      since: new Date(since).toISOString(),
      until: new Date(now).toISOString(),
      trackingSince: this.db.prepare('SELECT MIN(started_at) AS n FROM model_usage').get().n,
      totals,
      models,
      modelCount,
    };
  }
}
