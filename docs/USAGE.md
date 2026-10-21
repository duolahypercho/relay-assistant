# Model usage

Open **Settings → Usage**, or search for **usage**. The page shows requests and provider-reported tokens for the last 24 hours, 7 days or 30 days. Expand a model for its input, output, cache and reasoning figures. Reading this page makes no model calls or chat messages. Returning to Chat keeps the draft.

Figures refresh every 15 seconds while the page is visible. Refresh checks immediately. A failed read retains the last figures with an explicit warning and retry; changing the period never relabels stale figures from another period.

## What is counted

Recording starts with this version of the Relay server. Earlier activity cannot be reconstructed. Each dispatched model request is counted once, including separate calls around tools, backup-model attempts and connection checks. Connection checks are labeled in the expanded model row. Local validation failures, model discovery, opening pages and sample replies do not count as model completions.

OpenAI Responses, compatible Chat Completions, Anthropic Messages and Gemini adapters read usage from streaming and non-streaming responses. Cumulative stream counters replace previous values; repeated frames do not add tokens again. Cached input and reasoning are subsets, not extra totals. Anthropic input includes reported cache reads and cache writes; Gemini output includes reported thinking tokens. A total is derived from complete input and output counters only when the provider omits its total.

Missing or invalid values remain **Not reported**. A reported zero stays zero. Totals sum available reports; the page identifies requests without reported totals. Failed, cancelled and interrupted requests may have consumed more tokens than their last report shows. A request left unfinished by an earlier server process is shown as interrupted after restart. These counts are not an invoice.

Removing a saved model does not erase its usage history. A renamed connection or changed model is shown under the label recorded when each request began. Up to 100 model groups are shown; overall totals include all groups. The time filter uses request start time, not provider billing boundaries.

## Compatible endpoints

Chat Completions requests include `stream_options.include_usage` by default. If a custom endpoint rejects that option, edit its connection, expand **Connection details**, and turn off **Request token usage**. This changes future requests only; counters returned voluntarily can still be recorded. For the read-only server-environment connection, set `RELAY_MODEL_REPORT_USAGE=false`.

## Storage and limits

The server stores usage in a separate table in its existing SQLite database. Rows contain request identity, timestamps, connection/model labels, purpose, outcome and numeric counters. They do not store prompts, replies, provider URLs or keys. The authenticated owner API exposes aggregates at `GET /api/usage?period=7d`; it does not change workspace history. Usage is retained in the server database across app and server restarts. Workspace JSON export does not currently include this separate table; a database backup preserves it.

Provider account allowances, subscription percentages, reset schedules, prices and charges are not supplied by these model-response APIs. Relay does not invent those figures. Usage from other apps, speech services and image-generation services is not included. Live provider-account reconciliation, a dedicated usage export and account-level quota integrations remain open work.

## Verification

The backend suite includes 16 usage cases across all four protocols, actual controlled HTTP responses, malformed/missing counters, cumulative updates, cancellation, backup attempts, connection checks, SQLite restart, authentication and period validation. Ten desktop/phone browser checks and five packaged Mac checks cover the separate page, actual worker/tool calls, counts, time filters, recovery, drafts, light/dark accessibility and 320px layout. One native iPhone Simulator XTest verifies two controlled HTTP calls, 240 reported tokens and retained counts/draft after full app relaunch. These are fixture-based checks, not live provider billing or physical-device certification.

Run `npm test`, `npm run usage:test:ui`, `npm run usage:test:mac` and `npm run usage:test:ios`. Build first; the Mac command needs the current desktop package and the iOS command needs synced web assets, Xcode and the tested Simulator runtime. See [completed verification](VERIFICATION.md).

Protocol references: [OpenAI Chat streaming](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events), [OpenAI Responses streaming](https://developers.openai.com/api/reference/resources/responses/streaming-events), [Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), [Anthropic Messages](https://platform.claude.com/docs/en/api/typescript/messages), and [Gemini generateContent](https://ai.google.dev/api/generate-content).
