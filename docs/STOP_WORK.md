# Stop work from chat

In a direct chat, send **Stop now**, **Stop**, **Please stop**, or **Cancel that** to stop the conversation's current work. Relay handles the whole message as a control without asking the model what it means. Simplified and Traditional Chinese equivalents such as **现在停止** and **請停止** are supported. The existing Stop reply button remains available for an individual active reply.

The message receives an inline acknowledgement. Queued owner follow-ups remain paused and can be resumed explicitly. Current replies and tasks are cancelled, pending questions dismissed, and pending or approved-but-undispatched reviews rejected. Delegated work belonging to the conversation is stopped too. Completed results remain available. Drafts typed after the stop survive navigation, reload and native relaunch.

An external action already dispatched keeps its actual outcome receipt. Stopping does not undo it or report it cancelled. The acknowledgement identifies this situation when one exists. A completed source request cannot wake again through its old website, app, computer-job or specialist continuation after Stop.

## Computer work and recovery

The stop boundary is committed before the server aborts active work. A durable acknowledgement tracks cancellation of the affected foreground and detached computer work. Relay waits for its normal cancellation guards and job-stop receipts before displaying completion. If the computer cannot confirm a stop, the existing bubble explains that it is still checking and retries. Restarting the server resumes that check; it does not restart cancelled work. Cancellation also works while the computer is under owner control.

The same action does not stop another conversation's independent work, remove files, change saved routine schedules, or disable future triggers. A new request remains possible. Group conversations retain their routing behavior; this shortcut applies to direct chats. Selecting Queue follow-up deliberately queues the text instead. Internal/generated messages, quoted examples such as `"Stop now"`, shared source contents, and longer instructions such as “stop by the shop” do not activate the control. Only the owner-authored whole-message text is matched.

## Evidence and reproduction

- `node --test tests/chat-stop.test.mjs tests/connectors.test.mjs` covers exact matching, scope, drafts, queues, cancellation races, delayed providers, delegated work, questions, reviews, database reopen and deferred continuations.
- `npm run chat:stop:test:ui` exercises desktop and phone browsers with an independent HTTP model and SQLite worker.
- `npm run chat:stop:test:mac` uses the packaged Mac app against an isolated server.
- `npm run chat:stop:test:ios` creates its own iPhone Simulator and tests native text entry, Stop, relaunch and explicit queue resumption.
- `npm run chat:stop:test:computer` stops actual foreground and detached processes in an isolated Docker computer while preserving another chat's job and saved bytes.

This is an independent implementation of the direct stop behavior described in [Grok Bot's messaging guide](https://docs.x.ai/grok-bot/chat-and-collaboration). No reference code, prompts or assets were copied. See VERIFICATION.md for exact results and remaining product/platform gaps.
