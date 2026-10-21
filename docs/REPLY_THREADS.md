# Reply threads

For a quick **inline reply**, swipe a text bubble to the right on a touch screen. Its reply arrow appears as you move; release past the threshold to put the quote above the composer and open the keyboard. Your existing text and files stay in place. **Cancel reply** removes only the quote. Nothing is sent until **Send**. On desktop, or with a keyboard or screen reader, use the message's **Reply to message** button. Group replies retain the original author's routing.

Short, leftward, retracted, cancelled, multi-finger and held gestures do not select a reply. Vertical scrolling, pinch zoom, selected text, links, reaction/quote buttons, media and horizontal code/table scrolling keep their own behavior. Screen-edge swipes remain available to the operating system. Return animation follows reduced-motion preferences. The shortcut applies to text bubbles; file/result cards keep their existing controls. It uses the current inline quote state, so changing chats or reloading still clears the selected quote while ordinary text/file drafts persist.

This follows the interaction described in [Apple's Messages guide](https://support.apple.com/guide/iphone/send-and-reply-to-messages-iph82fb73ba3/ios), independently implemented in Relay. It does not connect to iMessage. A quick inline quote and a separate reply thread serve different purposes:

Hover a message on desktop, or tap its message-actions button on mobile, and choose **Reply in thread**. The thread opens as a separate chat view with an expandable original message. **Back to conversation** returns to that exact message; its reply-count link reopens the same thread. Opening a thread alone creates no messages or model work.

Each thread keeps its own text, unsent attachments, questions and work queue. Text and attachments survive immediate reload and navigation, with durable workspace saves and a tab-local recovery buffer. A reply never clears the parent draft or appends its discussion to the parent transcript. Search can open a particular reply. The sidebar keeps Main, assistants and optional side/group chats; it does not list every reply thread. Archiving or restoring a parent includes its threads, with one entry in Settings.

In groups, an ordinary reply goes to the assistant who wrote the original message. Select an explicit mention to address another current participant. User-authored originals use ordinary group routing. Participant changes propagate from the parent and wait for outstanding work, questions, handoffs, jobs or website permissions in its threads. A thread does not have a separate membership editor.

The model receives a frozen original message and its saved result references, followed by that thread’s own discussion. Unrelated parent messages and other branches are not included. Current action-review state is context, never approval; revising an external action requires a new exact review. Quoted originals cannot become new owner memory evidence. Shared workspace files remain available through existing file tools; PNG/JPEG/WebP/GIF reads now provide bounded image bytes to a vision-capable model instead of treating them as text.

Questions, nested group handoffs, saved results and private-computer continuations use the thread’s durable conversation identity. Stopping a reply retains the existing queue-pause behavior for that thread. Main and other conversations can continue independently. This is one level of threading: replies inside a thread remain in the same discussion.

## Reference and limits

The independent behavioral reference is [Grok Bot’s chat and collaboration documentation](https://docs.x.ai/grok-bot/chat-and-collaboration), reviewed October 10, 2026: feedback on one result or approval can stay in its thread, and group replies address their author. Relay’s implementation and visual assets are its own. This feature does not establish full Muse/Grok/Dot parity or human team collaboration.

A frozen original is a bounded snapshot, not a second live copy of all original controls. Open the original message to act on its existing review. Generated replacement actions have their own reviews. Workspace file access follows the existing shared workspace model; this is not per-person authorization. Hosted model judgment, physical-phone interaction and native mobile notifications remain separate acceptance gates.

## Verification

`node --test tests/reply-threads.test.mjs` covers 13 cases: atomic opening, independent drafts and queues, archive/membership propagation, model context, owner-memory boundaries, pinned questions, computer identity, SQLite reopen, image transport, a nested HTTP worker handoff and scoped stop/resume. The full Node suite passes 274 tests.

`npm run replies:test:ui` runs isolated real-server/SQLite journeys on desktop and phone layouts with a controlled HTTP model. Set `RELAY_REPLIES_NATIVE=true` to test the packaged Mac renderer. The journeys cover message controls, text and attachment recovery, browser history, separate pages, inline questions/files, original-author and explicit group recipients, search, parent archive/restore, narrow bubble controls, light/dark accessibility, viewport fit and JavaScript errors. See [VERIFICATION.md](VERIFICATION.md) for the current receipts and native-test scope.
