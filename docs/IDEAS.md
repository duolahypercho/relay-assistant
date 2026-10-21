# Personal ideas

Relay can ask the selected chat model for up to three useful next steps grounded in current workspace context. This is original code. The interaction follows the [Muse design discussion](https://introducing.muse.ai/): ideas should connect to real context, stay out of the way, and only interrupt for something worth seeing. Its judgment still depends on the connected model; exact source quotes are checked mechanically, while usefulness and urgency are not independently proven.

## Use

Connect a model in Settings, open Ideas, and choose **Check for ideas**. Sources expand in place. **Make a little progress** opens an editable request on the same page; **Send to Main chat** starts the assistant. The existing Main draft stays saved. Checking, navigating, dismissing and restoring do not create chat messages. Sample mode keeps clearly labeled examples; live mode does not substitute sample results when a model fails.

Background suggestions are off by default. Quiet checks at most every six hours and permits at most one model-marked urgent nudge per day. Regular checks hourly and permits at most one important or urgent nudge every six hours. The server must remain running. Checks skip an unchanged context fingerprint; the current day also participates so upcoming dates can be reconsidered. No native push is implemented by this feature. Manual checks put results only on the Ideas page.

The model receives a bounded selection of open goals and tasks, upcoming 14-day events, twelve inbox messages, thirty saved preferences, twelve recent owner messages, and ten completed task titles. Projections clip long text. They exclude credentials, file bytes, assistant messages and generated idea requests. This uses the selected provider like a normal model request and may incur that provider's charges. It uses already synchronized workspace data; it does not itself fetch new email or external sources.

## State and boundaries

`server/ideas.mjs` makes a single model call with no tools, a two-minute request timeout and a durable three-minute claim. JSON validation checks field limits, stable topic syntax, importance, and one to three distinct source references with exact quotes. The constrained path never permits more citations than the number of supplied sources; each ref is cited once. Invalid output produces an inline retry state. Error messages do not echo provider bodies or credentials.

Detected local Ollama connections in supported Quick mode now use a bounded JSON response schema for this read-only check. It constrains topic IDs, field lengths, source-reference choices and the zero-to-three-item list. The normal reasoning mode and other providers retain their existing transport. Exact quotes, current-source signatures and notification policy are still checked on the server; a schema does not prove that a suggestion is useful. Empty results use `{"ideas":[]}`. The instructions distinguish an optional goal from a real deadline and avoid assuming the owner’s availability or schedule.

Sources carry a signature. A changed, deleted, archived, expired or out-of-window source invalidates an unsent suggestion. A source change during generation prevents the response from committing. Removing a preference also prunes its unsent quotations and associated notices. Previously accepted work remains in conversation history, as ordinary owner-started work does.

Suggestions use a hash of the model's stable topic plus source IDs for deduplication. Dismissals survive reload; Restore makes a topic eligible again. Accepted topics are not repeated while their receipt is retained. The model sees previous, dismissed and accepted topics, but semantic deduplication across arbitrarily renamed topics is not guaranteed. Limits are twenty visible suggestions, one thousand dismissal receipts and one thousand acceptance receipts. New dismissal fails visibly at the limit rather than silently dropping the oldest decision.

Accepting a current suggestion is an atomic command with an idempotent receipt. Its generated source context is marked as untrusted data. Generated requests and subsequent clarification answers cannot create learned personal memories. Normal action-review controls still apply to external writes. This feature does not authorize autonomous purchases or messages.

The worker checks suggestions after other queued work, without a browser. Owner computer takeover pauses dispatch and aborts an ongoing check. Manual requests survive a graceful stop; an expired claim can recover after a crash. Mode changes invalidate in-flight checks. Background failures back off. Optional Main nudges contain generic wording and a dynamic card, so invalidated source details are not embedded in the notification history.

## Verification

`tests/ideas.test.mjs` covers thirteen cases: validation, real stored state, no-chat manual checks, accepting once with draft preservation, memory restrictions through clarification, source invalidation, dismissal/restore, in-flight changes, notice throttling, failure handling, worker takeover/restart, expired leases/context bounds, service reuse, forgetting and authenticated HTTP boundaries. Some cases cover multiple behaviors.

`node scripts/test-ideas-ui.mjs` uses production UI and a controlled HTTP endpoint through the saved model connection and real worker. It checks desktop and phone editing, source navigation, history/drafts, reload, dismissal/restore, provider failure/retry, mode persistence, stale source removal, accessibility and overflow. These are browser flows, not native phone or hosted-provider quality certification. The packaged Mac check is documented in the verification record.

## Actual local-model acceptance

`npm run ideas:test:live` exercises the production phone UI, real worker/SQLite and an independently owned local model process. Set `RELAY_IDEAS_TEST_MODEL` to an installed model, `RELAY_LOCAL_MODEL_TEST_MODELS` to a dedicated acceptance cache, and optionally `RELAY_EVIDENCE_DIR`. Port 41334 must be free; the harness leaves an existing owner service on 11434 alone and closes only its own runtime.

Its synthetic cases cover optional suggestions, explicit edit/send with retained draft, dismissal across reload, completed work, instructions embedded in a newsletter and a genuine six-hour deadline. Quiet-mode notification runs through the background worker, with one nudge and no repeat inference for unchanged context. It records actual requests/replies, source quotes, timings and screenshots. Structural checks and separate manual semantic review are complementary; neither establishes universal model judgment or physical push delivery.
