# Specialist handoffs

With a model connected and at least one specialist saved, ask naturally: **“Ask Mochi to review this plan, then use the review to improve it.”** The model can discover saved roles and send a specific request with up to eight saved file IDs. In a direct conversation, Relay creates a side conversation for the receiving assistant and a progress card in the originating chat. In a group, a text request to another participant stays in the same transcript, attributed to its sender and recipient. Main remains the everyday conversation; a handoff does not create another Main or a workspace page in the transcript.

The specialist uses its own role and memories. Its first message visibly says who sent the request. A private handoff transfers only the handed request and chosen file references; a group recipient also sees the existing group conversation. The originating assistant's private conversation and memories are not copied. Files, apps and the computer are already shared owner resources. Roles are organization within one owner's workspace, not separate user accounts or security tenants. Generated handoff text cannot become a learned owner preference.

`list_groups` exposes only groups the sending assistant belongs to. `ask_assistant` can name one with `groupId`; both assistants must already be members of an active group. A request sent from another conversation leaves an **Open group** receipt at its origin. Bot-to-group requests are text-only; a request with attachments uses a private specialist conversation. Group members can ask further participants for help, with ancestry and limits applying across both destinations.

## Questions, results and control

If the specialist asks a question in a private handoff, its choices and custom-answer field appear inside the originating chat's card. In a shared group, its question appears once under its own name in the transcript; **View reply** jumps to its result. Answering continues the specialist's request and preserves the original composer draft. **Open conversation** shows its full work, files and reviews; **Back to main chat** returns to Main. Side chats keep their own drafts through navigation and reload.

When the specialist finishes, Relay queues one continuation of the original request with the returned text, saved file IDs and review references. The card exposes returned files directly. Failed work returns its failure, rather than a success placeholder. Unfinished computer jobs, website-access decisions, questions and delegated tasks keep the handoff waiting. External actions still require their existing exact owner reviews in the specialist conversation; a handoff is never approval.

**Stop request** stops queued/running specialist work and its downstream requests, dismisses their pending questions, rejects unexecuted reviews and suppresses the root's automatic continuation. In a group, ownership is per handoff: independent messages, questions and tasks in the same transcript continue. Active computer jobs are stopped through the existing job API, and a late job or website continuation cannot revive a stopped request. It does not undo completed work or an already executing approved external action. Stopping an inner request reports cancellation to its still-active coordinator, which can explain or recover the original task. Stopping the root also cancels any queued return and an unfinished handoff announcement.

The original request, role and selected model connection remain frozen across a return. Child follow-up runs retain the specialist role and the same model binding while the handoff is active. Connections cannot be edited or removed while a handoff is waiting; choosing another model for new work remains possible. Routine restrictions follow nested handoffs. Owner computer takeover continues to pause agent work under the existing computer-control rules.

## Persistence and bounds

A handoff record, request message, queued run and visible receipt commit in one SQLite transaction. The same operation identity cannot start duplicate work or be reused with different instructions. Completion and the single return run commit together. Background processing does not require an open browser window. A restart at an `ask_assistant` tool boundary recovers the committed request using its immutable operation identity. Other interrupted ambiguous tool actions still require inspection.

A request may involve at most four assistants in an ancestry chain, with no repeated assistant in that chain, eight total handoffs per original request and twenty active handoffs in the workspace. A returned text is capped at 24,000 characters and twenty saved-file references; full work remains in the specialist conversation. Role discovery uses bounded previews. These limits prevent endless assistant-to-assistant loops; reaching a limit leaves saved work available for review.

Archiving the source conversation suppresses its automatic return. Archiving a specialist side conversation does not stop its existing background work; restore it to answer its questions. Use Stop request to end work explicitly.

## Reference and remaining scope

The behavioral reference is [Grok Bot's asynchronous handoff documentation](https://docs.x.ai/grok-bot/chat-and-collaboration), checked October 10, 2026. Relay's state model, worker reconciliation, prompts and UI are independently authored.

This implements asynchronous requests between saved assistants, including shared group transcripts, directed recipients and nested bot-to-group handoffs. Human team membership remains open. Model judgment about when to delegate and the quality of the returned work require live-provider acceptance; controlled tests establish application behavior and transport.

`tests/handoffs.test.mjs` covers atomic/idempotent creation, limits, scope, frozen context, recovery, exactly-once return, questions, wait states, failure and nested cancellation. `scripts/test-handoffs-ui.mjs` uses a real Relay server, SQLite worker and controlled HTTP model to check discovery, handoff, inline answers, returned file bytes, both drafts, cancellation, accessibility and viewport fit on desktop, phone browser and packaged Mac. Native phone handoff acceptance is separate from the existing iOS preview/export component tests.

`tests/group-handoffs.test.mjs` covers shared-transcript identity, ancestry, scoped results/cancellation, explicit destinations, attachment handling, recovery, late computer callbacks and a full nested HTTP worker pipeline. `npm run groups:handoffs:test:ui` exercises nested requests, a single inline question, returned files, result jumps, drafts and scoped cancellation on desktop/phone layouts. Set `RELAY_GROUP_HANDOFFS_NATIVE=true` for the packaged Mac renderer. See [GROUPS.md](GROUPS.md) for recipient routing and remaining differences.

A handoff started inside a group reply thread stays in that thread when its recipient is already a participant. Nested results, questions, files and computer continuations retain the thread’s identity; the parent transcript receives only its reply-count link. See [REPLY_THREADS.md](REPLY_THREADS.md).
