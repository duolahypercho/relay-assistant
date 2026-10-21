# Saved email files

Attach an `.eml` file or open one from Files. Relay shows its decoded subject, sender, recipients, date and message body in the existing file preview. An attachment opens inside that preview, with **Back to email**, download and full file-preview controls. Opening an enclosed file keeps a copy in Files; it does not send a chat message or call the assistant. The original email and your draft stay intact.

Repeated opens reuse the extracted copy when it still has the original bytes. If you edit that copy, opening the source attachment creates a fresh original while preserving your edit. Removing a saved copy permits a later extraction again. This is file extraction, not execution or installation.

The assistant's `read_file` tool reads the email's decoded headers/body and attachment index. `import_email_attachment` saves one enclosed file, which the assistant can then read with the ordinary file tools. The source content and sender details are explicitly untrusted; email text cannot approve actions or create owner instructions. No mail account is needed to read a saved email. Sending a reply still uses existing separate reviewed mail actions and requires a connected account.

## Bounds and behavior

- `.eml` / `message/rfc822` is supported. Outlook `.msg`, mail archives, encrypted message decryption and signature authentication are not implemented.
- MIME transfer encoding, international headers, quoted-printable/base64 bodies and declared character sets are decoded. Empty plain-text alternatives fall back to their HTML body. Nested emails remain separate attachments.
- HTML becomes plain text. Scripts, styles and image references are omitted; links are displayed as text. The preview creates no remote image, tracking or script requests. It does not reproduce the original HTML layout. Complex HTML limits insert an explicit omission notice.
- Application files remain limited to 8 MiB. Parsing permits 200 MIME parts, nesting depth 20 and 128,000 header bytes; it uses a bounded worker with a ten-second timeout and at most two active email parses. Readable bodies are bounded to two million characters and returned in 12,000-character sections with a content hash. Long header display is bounded to 16,000 characters. Malformed or excessive files remain downloadable even when preview fails.
- Attachment bytes are MIME-decoded. The MIME library normalizes calendar attachments to UTF-8 text; download the original EML when exact original message representation matters. Embedded files are never opened as active HTML within the email view.
- Previews require the Relay server. Frozen approval-attachment snapshots retain their original download but do not use the current stored email's preview. Cancellation stops pending parsing. Extraction checks the source hash and the current file before committing, and rejects stale or lost-authority requests.

## Verification

`npm run files:email:test:ui` checks desktop and phone browsers. `npm run files:email:test:mac` checks the packaged Electron client. `npm run files:email:test:ios` creates an isolated iPhone Simulator with a temporary HTTPS certificate. The fixtures are original emails and an independent controlled HTTP model; they do not demonstrate live-model judgment or real mail-provider compatibility. Latest completed runs, native limitations and saved-artifact checks are in VERIFICATION.md and `../relay-evidence/email-*-acceptance.json`.

The Node suite covers international headers, character sets, HTML-only messages, empty alternatives, nested emails, paging/content hashes, attachment bytes, idempotent extraction, preserved edits, source deletion/authority races, bounds, cancellation, model tools and authenticated HTTP access. Browser tests cover genuine upload/download, preview and attachment controls, reload, malformed-message recovery, model → email → attachment reads, no remote requests, unchanged history/drafts, accessibility and viewport fit.

## References and dependencies

[Grok Bot's files documentation](https://docs.x.ai/grok-bot/files-and-results) includes email attachments and reviewable file results. The authorized native app inspection showed Library as a separate conversation-detail tab; no messages or remote-computer input were sent during this inspection. Relay keeps its existing separate Files page and original preview design.

Email parsing uses the general-purpose [PostalMime](https://github.com/postalsys/postal-mime) library (MIT-0); HTML conversion uses [html-to-text](https://github.com/html-to-text/node-html-to-text) (MIT). Their licenses and dependency notices are included in THIRD_PARTY_NOTICES.md. No competitor implementation or assets were copied.

## Drafts prepared for review

Ordinary requests for email wording stay in chat. An explicit request to prepare an email for review uses `prepare_email` to create a pending review card. A mail account is not required to prepare it; sending remains a separate owner decision with the existing account and exact-review checks. Relay withholds an unsupported success claim when the requested review does not exist.

For direct English/Chinese review requests, the host preserves unambiguous quoted `Subject: "…"` and `Body: "…"` fields (also `主题必须是「…」` / `正文必须是「…」`). Internal line breaks, punctuation and quoted code survive model transcription. The current owner message supplies the literals; content from files, other chats, examples and quoted instructions cannot supply them. A bare recipient clarification may retain the original literals. More complex corrections, repeated labels, escaped delimiters and unsupported wording use the normal model drafting path. Leading/trailing whitespace and field limits retain the existing mail validation.

When required information is missing, `ask_question` can now omit choices and show a single text input in the existing chat card. A typed answer resumes the original request once while preserving the separate composer draft. Two to five meaningful choices remain available; the tool need not invent possible email addresses. A bounded plain-text question asking for a missing recipient is also converted into this durable card, so a legitimate clarification is not mistaken for an unsupported completion. This fallback rejects already-supplied addresses, completion claims and requests for credentials; complex questions still use the normal question tool.

An unfinished answer stays on that device through page navigation, reload and native app termination. It is scoped to the question and its creation time, independently of the main message draft, and is not sent to the assistant until **Send answer**. The displayed card clears its local copy when answered or dismissed. Failed submissions keep the text. If device storage is blocked or full, the current editor remains usable but restart recovery is unavailable. Unsent question answers do not synchronize between devices.

This preservation never creates a review by itself, chooses a recipient, adds attachments, or sends mail. It applies only while executing the existing preparation tool for the matching request. Recipient validation, attachment snapshots and durable recovery remain in force. It does not certify that an arbitrary model-composed email satisfies its request.

`tests/email-review-completion.test.mjs` covers literal preservation, ambiguity, quoted/fenced content, source scope, clarification, invalid payloads and durable replay alongside the existing completion checks. `scripts/test-email-review-live.mjs` exercises actual local inference and the Mac renderer for inline wording, a review with a saved attachment, Chinese text and a required-recipient clarification. Its synthetic recognized text does not test microphone or speech generation. Each acceptance receipt records the result and cleanup; failures remain retained.

The protocol investigation did not introduce forced tool selection. [OpenAI documents required tool choice](https://developers.openai.com/api/docs/guides/function-calling#tool-choice), while [Ollama's compatibility source marks `tool_choice` unsupported](https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx). The change instead clarifies the draft destination and preserves owner literals using the existing guarded tool path. No model or connection default changes.

The aggregate `../relay-evidence/email-draft-actions-verification.json` records the exact tested source, build inputs, model outcomes and retained failed attempts. Earlier trials exposed flattened body text, an invented reused recipient and legitimate prose questions rejected by the completion check. Those failures remain evidence; a later targeted pass does not establish general model reliability.

`node scripts/test-email-clarification-ui.mjs` checks a missing-recipient question, partially typed answer, separate composer draft, page navigation, recovery and one exact pending review. `--android` uses the installed APK on an explicitly selected dedicated emulator, actual Android input, five reloads, full process relaunch and crash logs. `node scripts/test-email-clarification-native.mjs` creates its own iPhone Simulator and checks native keyboard input and full relaunch over HTTPS. These use an original controlled HTTP model with the real agent, worker, commands and SQLite; they extend platform acceptance, not model intelligence or physical-device certification. Receipts and failures are retained under `../relay-evidence/native-email-clarification`.
