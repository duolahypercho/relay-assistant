# Assistant profiles

Main is the everyday conversation. Optional specialists add a persistent role when separate context is useful. Open **Show chats → Manage assistants → New assistant**, enter a name and role, and choose **Create & chat**. Creation opens an empty conversation. Profile management stays on its own page and does not insert navigation messages.

Profiles store a name, character or picture, color, instructions, response style and skill selection. Main's name/style controls and profile editor update the same record. Concurrent edits require the latest profile revision. A profile draft survives page navigation and reload; saving or cancelling clears it. Chats keep independent drafts, including their last keystroke, and the current chat survives reload within the window. New windows start at Main.

## Context and shared resources

Each specialist owns its home conversation and optional side chats, memories, learning controls and routines. The model receives only that conversation's history and that assistant's memories. Memory learning validates the exact current owner quote and the owning run. A remembered preference can be used across that assistant's side chats. Turning off learning, correcting a note or forgetting it invalidates pending extraction for that assistant only. Model tools reject another assistant's memory or routine IDs.

Files, connected apps, skills, the private computer, goals and other workspace resources remain shared. These roles are organization within one owner's workspace, not separate users or security tenants. The owner can review every profile. Skill selection limits new slash requests, skill reads/updates and new routine skill selection. A previously saved routine retains its frozen method until the owner explicitly updates it. Role instructions and skills never grant additional external-action permission.

Queued chats, scheduled runs, clarification continuations and delegated tasks retain the initiating role snapshot. Editing a profile changes new requests; it does not silently change work already queued. Personal notes are refreshed within the initiating assistant's scope as tools run.

## Visibility and duplication

Pinning sorts a specialist first. Hiding removes it from the normal sidebar; its chats, pending work and routines remain. **Hidden assistants** on the management page restores it. Main stays available.

Duplicating copies the name (with a “copy” suffix), instructions, style, color, appearance, enabled-skill selection, learning preference and non-archived routine configurations. Copied routines start paused for review. The new assistant has no copied chat history, learned memories, attachments, results, pending jobs or email-trigger cursor. A copied routine's frozen skill omits its source-message link. Shared files and connected apps are still workspace resources, not copied credentials.

Share setup now supports reviewed template downloads, revocable links and fresh imports; see [assistant templates](ASSISTANT_TEMPLATES.md). Character choices, cropped picture uploads and portable appearance templates now work; see [assistant appearance](APPEARANCE.md). Asynchronous cross-assistant requests now return results to their original chat; see [specialist handoffs](HANDOFFS.md). Profile deletion, group chats and prompt-generated avatar images remain open.

## Reference and independent implementation

The behavioral reference is [Grok Bot's Bots documentation](https://docs.x.ai/grok-bot/bots): persistent roles, separated conversational context, shared computer/files, pin/hide and configuration-only duplication. Relay's duplication additionally pauses copied routines for owner review. Relay implements its own data model, commands, prompt boundaries and UI; no reference source or artwork is incorporated.

## Verification

`tests/assistants.test.mjs` covers persistence, stale edits, memory provenance and isolation, role snapshots, disabled skills, hidden routines, duplication and delegated/clarification context. `scripts/test-assistants-ui.mjs` drives a real Relay HTTP server and background worker against a deterministic local compatible model endpoint on desktop, phone browser and (with `RELAY_ASSISTANTS_NATIVE=true`) packaged macOS.

These controlled tests validate application behavior and transport. They do not certify response quality for every hosted model or constitute physical iOS/Android device acceptance.
