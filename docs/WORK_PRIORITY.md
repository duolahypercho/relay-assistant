# Your message comes first

Send normally in Main or a side chat. Relay keeps capacity available for your reply while other work is running. Background requests wait at a safe boundary and resume automatically when direct replies finish. There is no priority setting, dialog or extra step. A background chat briefly shows **Waiting while I answer your message**; this status is not added to its history.

This independently implements the direct-message priority described in [Grok Bot’s messaging guide](https://docs.x.ai/grok-bot/chat-and-collaboration), checked October 12, 2026. No reference implementation is included.

## What waits

The server starts at most four background work entries, keeping one of its five work slots available for an owner request. Direct requests are considered first. New scheduled runs, delegated tasks, trackers, suggestions, mail checks and unstarted reviews wait while a direct reply is pending. Existing background agent runs wait before model attempts, tools and final publication. Explicitly shared teaching recordings can still be drafted while the owner holds computer control.

Explicit **Queue follow-up** requests retain their deferred behavior. Ordinary direct sends, accepted suggestions, explicitly run skills and direct answers to an assistant’s question get priority. Generated continuations and group requests keep their background routing. Priority is inferred from saved owner-message provenance, not words such as “urgent” in model or website output. A paused queue does not block other work.

Earlier requests in the same chat remain ordered. A prerequisite inherits the pending reply’s priority so a fixed reminder or earlier queued request cannot deadlock the chat. Sending a correction to an active request still follows [the existing follow-up behavior](FOLLOW_UPS.md).

## Completed work stays completed

An already-started tool finishes through its existing outcome rules. Its result and the next tool position are saved before yielding. A restart resumes the checkpoint; an interrupted action with an unknown outcome is not replayed. An approved external write already dispatched to its provider can finish and record its receipt. Priority never rolls it back or sends it again.

After another direct request has had attention, pending computer plans are re-evaluated against current state. This also covers a quick direct reply that finishes before background work reaches its next boundary. Completed tool receipts remain in context; old, unexecuted computer plans receive explicit non-execution results.

**Stop now** remains available while background work is waiting. Cancellation and job-status reconciliation use control entries outside the five work slots, so they can settle during a long direct reply.

## Limits

Priority does not suspend an already-running detached process or undo an accepted external action. A provider request already in progress may finish before its run yields. Repeated direct requests can delay background work, and requests in the same chat preserve their earlier dependencies. Owner computer takeover still holds live agent work until handback. This is the single-server worker policy; it does not provide distributed scheduling or group steering.

## Verification

- `node --test tests/work-priority.test.mjs`: provenance, queue dependencies, saturation, tool boundaries, actual SQLite reopen, Stop while waiting and stale computer plans after a quick reply.
- `npm run chat:priority:test:ui`: desktop and phone layouts with four held HTTP model requests, direct attention, waiting status, four notes saved once, separate pages, draft recovery and accessibility.
- `npm run chat:priority:test:mac`: the same journey in the packaged Mac renderer against an isolated server.
- `npm run chat:priority:test:ios`: real iPhone Simulator keyboard, HTTPS sign-in, direct priority, automatic continuation, navigation and full relaunch.
- `npm run chat:priority:test:computer`: real isolated Docker shell work, preserved bytes, skipped stale action, automatic replan and cleanup of the fixture computer and volumes.

These use controlled model decisions. Live model quality, physical devices and Android runtime require separate acceptance.
