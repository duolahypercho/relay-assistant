# Group chats

Relay keeps Main as the default. Open the chat sidebar and choose **New group chat**, select two to six saved assistants, optionally name the group, and start. Groups are optional side chats, not separate human accounts or shared workspaces.

Type `@` or tap the mention button to choose participants. A selection becomes a removable recipient chip backed by a validated assistant ID; `Everyone` selects the current members. A normal message lets the configured model select the smallest useful set of responders. Replies run in order, so later participants can read earlier results. In sample mode the first participant answers; the interface continues to identify sample mode.

Replying to an assistant’s bubble targets that author. A question’s answer returns to the assistant who asked it, retaining the original request, attachments and model connection. A single transcript shows each sender, result files and questions. Draft text and chosen recipients survive navigation and reload. The group header opens the participant editor. Search finds the group by name; archive and restore use the existing side-chat controls.

## Identity and work

Participants see the group transcript and use their own role, skills and private memories. Other assistants’ output is labelled as source context, not owner instructions. Saved skills must be enabled for every selected recipient (or every group member when routing is automatic). Memory learning uses the current owner message and responding role. Questions, delegated tasks, background computer jobs and website continuations keep that role and its model binding. Existing external-action reviews still apply.

Routing is read-only. Its validated selection is committed with the queued replies in one SQLite transaction, ahead of later requests. A crash can retry an unfinished routing call without duplicating committed replies. Stopping routing discards late model results. Stopping a running reply preserves existing queue-pause behavior; remaining replies wait for explicit resumption. Provider failures produce an error in chat; there is no silent live-model fallback to a different participant.

Membership cannot change during queued replies, unanswered questions, unfinished tasks, pending handoffs or computer waits. Finish, stop or dismiss the relevant work first. Renaming remains available. Original speaker names remain on historical messages after an assistant is renamed or removed.

## Scope and reference

This independent implementation follows the optional-group, directed-message and reply-to-author interaction described in [Grok Bot’s official messaging documentation](https://docs.x.ai/grok-bot/chat-and-collaboration), reviewed October 10, 2026. No reference implementation or artwork is included.

Assistants can hand text requests to another participant directly in the transcript. A compact progress card shows the recipient, state and Stop request; the specialist’s question appears once and its result is reachable with View reply. Nested requests return to their original coordinators. An assistant can also discover another group it belongs to and send a request there, leaving an Open group receipt at the origin. Files use private specialist requests. Independent work in the same group is unaffected when a handoff is stopped. See [HANDOFFS.md](HANDOFFS.md).

Known differences remain: there are no human team permissions, shared reactions or mentions of connectors/routines/groups. Voice calls and scheduled routines currently require an individual assistant conversation. Dictation, files, inline questions and the private computer are available from groups. Relay retains its existing review cards in group conversations; this differs from the reference’s private-review behavior.

## Verification

`npm test` covers recipient validation, atomic routing, restart recovery, frozen identities, question/reply attribution, private-memory isolation, computer continuation context, HTTP model routing and late-response cancellation. `npm run groups:test:ui` uses an isolated real Relay server, SQLite worker and a controlled HTTP model to exercise desktop and phone layouts. `RELAY_GROUPS_NATIVE=true npm run groups:test:ui` exercises the packaged Mac renderer against the same server fixture. These checks establish application behavior; they do not establish hosted-model judgment, native phone interaction or physical-device acceptance.

Reply threads keep feedback on one original message in a separate view. They inherit the group’s participants; an unmentioned reply goes to the original assistant, and an explicit mention can address another participant. Participant changes wait for work in the group and its reply threads. See [REPLY_THREADS.md](REPLY_THREADS.md).
