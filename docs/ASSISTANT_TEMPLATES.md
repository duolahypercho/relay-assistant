# Sharing assistant templates

Open **Your assistants → Share setup** on a profile. Edit the template name, role and style, inspect included skills and routines, and leave out anything unnecessary. **Use current setup** refreshes the draft from the profile. Editing this draft does not change the original assistant. The draft survives reload and page navigation.

Choose **Review template**, then **Download template** or **Create public link**. The second step shows the exact normalized configuration that will be published. A changed payload or access choice invalidates its review digest. Sharing creates no conversation messages and does not send the link to anyone automatically.

## What travels

A `relay.assistant-template` contains only profile settings, explicitly exported enabled skills, and non-archived routine configurations. Skill and routine text is editable before sharing. There are no conversation IDs, message provenance, learned memories, attachments, outputs, pending jobs, model/audio endpoints, API credentials, website grants or account sessions in this format. Unknown fields are rejected, rather than copied into the recipient workspace.

Preparation removes recognized credential patterns and private URLs from text. Email sender filters are replaced with `choose-sender@example.invalid`. Review the remaining role, method and routine text for private or customer information. Pattern checks cannot recognize every secret, internal hostname or personal fact, and are not a substitute for that review. Imports and publication reject remaining recognized credential/private-URL patterns. Templates are bounded to 256 KB of UTF-8 data, 100 skills and 50 routines.

## Links and updates

Public links can be read and downloaded by anyone holding the link. They show the reviewed configuration on a standalone page with no access to the creator's workspace. **Signed-in workspace owner** requires authentication to this same Relay server; it is unavailable when the server has no access key. This is not a team-membership permission system.

**Copy link** copies it to the clipboard. **View template details** opens its preview. **Update template** edits the currently shared version; choose **Use current setup** to bring in later profile changes. Publishing an update requires a fresh review and the current link revision. Updating the source profile alone never changes a published template.

**Stop sharing** revokes the link immediately. Old public JSON and download routes stop returning the configuration. Revoked links cannot be reactivated; create a new link if needed. Revocation cannot recall files already downloaded or copies already imported. Links are stored durably in the owner's SQLite database, outside normal workspace state and model context. Public pages use no-store/no-referrer headers, HTML escaping, a nonce-based script policy and no external scripts or assets. Only public template reads receive permissive CORS; owner APIs retain authentication, origin and host checks.

A self-hosted server must be reachable by the recipient. Set `RELAY_PUBLIC_URL` to its HTTPS origin to generate the intended links. Creating a link on localhost does not deploy Relay or expose the computer to the internet.

## Importing

On a public preview, choose **Open in Relay**. An already connected Mac or mobile app opens the shared setup for review on its own page. Choose **Add assistant** to create the copy; **Edit before adding** is optional. The app keeps its selected server and Main chat draft. No server address, pasted link, manual load step or chat message is needed.

Without the native app, expand **Use a browser instead**, enter your Relay server and choose **Review in my Relay**. The existing **Import template** page also accepts JSON files or links: load, review, then add. HTTP is supported only for loopback development links; remote links require HTTPS. Cross-server reads omit credentials, disallow redirects and enforce response limits. Configuration is never fetched by the server on behalf of an arbitrary supplied URL.

The result is a new specialist with an empty conversation and no learned memories. Imported skills get new IDs and nonconflicting shortcuts; existing local skills are never overwritten. Only the imported skills are enabled for new requests. Frozen routine methods stay with their routine. Imported routines are paused with no pending runs, email cursors or last results. Review dates, time zones and sender filters before enabling them. An expired one-time routine requires a future date. Adding a template never approves an external action.

Downloaded files and imported copies are independent. Later updates or revocation on the source server do not change them. Version 2 adds the assistant’s character or normalized picture; version 1 imports remain supported. The review displays the picture, which can be replaced with Sprout before sharing. Native phone file saving uses Relay's existing system export bridge. A marketplace and team access remain open.

The `relay-assistant://template?url=…` scheme stages only a bounded Relay template URL. It carries no recipient credentials or destination-server override. Pending reviews survive cold start and are scoped to the selected server. Cancel and successful import clear the matching receipt; a late acknowledgement cannot clear a newer link. Durable workspace receipts prevent replay of an already committed import after a lost response or app restart. Opening the same shared link again creates a new review and can intentionally add another independent copy.

The Mac bundle and iOS/Android manifests register the scheme. Debian desktop-entry source declares `%u` and the scheme MIME handler. Android native intent/lifecycle behavior, Linux handler dispatch, Windows registration and physical phones require platform acceptance; standalone Java parser checks are not an Android runtime pass. This is a custom scheme, not a universal/app link tied to every self-hosted domain. A fresh phone app keeps the link pending until it is connected to a server; sample-only mode does not import it.

## Reference and checks

The reference behavior is [Grok Bot sharing](https://docs.x.ai/grok-bot/bots): a previewable configuration template, share visibility, explicit updates and a fresh recipient copy without the creator's computer or conversation history. Relay uses independently written schema, validation, storage, endpoints and UI. No competitor implementation or artwork is included.

`tests/assistant-templates.test.mjs` covers structural stripping, recognized secret redaction, strict schema and UTF-8 limits, atomic import, ID/shortcut isolation, paused/expired schedules, exact review digests, concurrent edits, restart persistence, authorization, public CORS, revocation and escaped public HTML. `scripts/test-assistant-templates-ui.mjs` drives desktop/phone browsers and the packaged Mac renderer through two isolated real Relay servers: review, download, public preview, cross-server import, update, revoke, malformed/file import and draft preservation, with light/dark accessibility and overflow checks. Browser downloads are verified; native template downloads are not covered by that browser acceptance pass. The macOS clipboard check verifies the native clipboard contents through a bounded write-only bridge restricted to the trusted main workspace frame. Test links contain fictional data on loopback servers. No external template is published by these tests.

The native bridge follows the current [Electron clipboard API](https://www.electronjs.org/docs/latest/api/clipboard), awaiting writes before reporting success.

## Standalone skill metadata

Template v2 optionally includes validated `documentMeta` on skills: license, compatibility, author/other flat text metadata and informational tool requests. These survive frozen methods and import; they do not grant tools. Older Relay builds with strict field validation need updating to read these extended templates. See [skill files](SKILL_FILES.md).

## Native-link acceptance

`tests/assistant-template-links.test.mjs` checks URL bounds, protocols, credentials, paths and ports; private persistent desktop storage; stale acknowledgements; workspace scoping; and durable SQLite import receipts. `templates:test:links-mac` exercises the packaged Electron application with cold-start arguments, its actual native URL event/bridge, public-page navigation, pending review across relaunch, response-loss replay, explicit Add, paused routines, immediate slow-load cancellation, revocation, draft retention and accessibility. `templates:test:links-ios` drives a disposable HTTPS iPhone Simulator through Apple's URL-opening test API, native parser tests and the same review/import lifecycle. Receipts and screenshots live in `../relay-evidence/template-links/`. See VERIFICATION.md for the last completed results.

Native routing follows [Apple's custom-scheme lifecycle](https://developer.apple.com/documentation/xcode/defining-a-custom-url-scheme-for-your-app) and [Android intent-filter guidance](https://developer.android.com/training/app-links/create-deeplinks). The implementation and tests are Relay's own.
