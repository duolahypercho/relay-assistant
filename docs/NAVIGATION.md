# Finding things in Relay

## Easier phone controls

Chats, Search, assistant details, companion Pause, model status, notifications and chat options have larger touch areas on phones. The attachment, dictation, send/voice and message-action controls also accept taps around their compact icons. The messenger appearance stays compact; message actions wrap when needed. English and Chinese headers use the same responsive behavior. No extra menu, setup step or chat message is introduced. Run `chat:touch:test:ui` and `chat:touch:test:ios` for edge-tap, draft and native-frame acceptance.

Failed replies show **Try again** directly beneath the bubble when safe recovery is available. The button becomes **Trying again…** without navigation or a dialog, preserving the draft and saved cards. See [CHAT_RETRY.md](CHAT_RETRY.md).

## File previews have their own page

Open a saved file or an attachment to see a dedicated preview page. **Back to chat** returns to the originating conversation; **All files** opens the list. Browser Back/Forward follows the actual visit history. Preview links preserve the file and originating chat through reload, without adding a message or making a model request. A missing/deleted file explains what happened and keeps both return paths available. Generated result pages keep their existing version links; frozen attachments in action reviews keep their separate, immutable review view.

Downloads, PDF page/zoom controls, photos, Office text, email attachments and media playback remain available. Leaving the preview stops its media and releases object URLs. A keyboard-opened chat attachment regains focus when returning to chat. Long file names wrap on narrow screens.

Text edits survive switching between **Edit text** and **Preview**. The preview displays the current unsaved text, labels it **Unsaved changes**, and offers **Save changes**. Ask about this stays hidden until saved. Leaving the file page or reloading discards unsaved file edits; the chat draft has its separate durable storage. Viewing, page navigation and download never save an edit automatically.

Run `npm run files:pages:test:ui` and `files:pages:test:mac` for dedicated page/history/reload, side-chat identity, draft retention, exact downloads, inline deletion, missing-file recovery, accessibility and 320px layout. File-format and native acceptance remain in their existing commands below; see VERIFICATION.md for completed runs.

## Ask about a saved file

Open a saved file and choose **Ask about this**. Relay returns to the current conversation with that file attached and the composer focused. The unfinished message, selected apps and other attachments stay in place. It reuses the existing file and never sends until you choose Send. The shortcut also works for a saved result, using the exact version on screen.

Repeated taps do not duplicate attachments. A full eight-file draft or an upload still in progress leaves the preview open with an explanation. The action stays hidden while a text file or result has unsaved edits, and is absent from frozen review attachments. Drafts stay separate between Main and side chats and survive reload or app relaunch.

Design audit for this refinement: preserve the off-white surfaces, sage accents, rounded message bubbles, animated companion, Manrope/DM Sans type and five-item dock. The current page structure and collapsed chat sidebar already keep the conversation focused. The gap was the trip from file preview back to an attached question; one contextual action removes the need to upload again or type a filename. This is an original Relay convenience, not a claim of matching a competitor's implementation.

`npm run files:ask:test:ui`, `files:ask:test:mac` and `files:ask:test:ios` verify the shortcut, draft preservation and an actual assistant file read through an independent controlled HTTP model. Browser/Mac checks also cover full drafts, pending uploads, exact result versions and unsaved edits. Native acceptance uses an iPhone Simulator; Android and physical devices remain unverified.

Clear page requests now take the short path: type **show my files**, **open tasks**, **take me to my calendar**, or **open settings** in the composer. An inline **Open …** preview appears; Enter, its button, or the arrow opens that page immediately. The request is cleared without creating a chat message, task, or model request. **Ask Relay instead** explicitly sends the original text when you want the assistant to respond. This is a small, exact English phrase matcher, not natural-language intent inference: questions, filtered requests (such as “show my files from yesterday”), quoted text and multiple instructions still send normally. Context-bearing drafts (attachments, shared items, selected apps, groups and replies) and ongoing assistant/voice input keep their normal Send behavior.

Every workspace page, including an individual Settings category, offers **Back to chat** in the same place. It returns to the conversation you came from, including a side chat. Settings categories also retain **All settings**. Opening a page changes no settings or computer control. Other chats’ drafts remain intact.

Relay opens on the continuing chat. The sidebar has a labeled **New side chat** action beside your side conversations. It opens an empty composer ready to type, leaving the Main draft intact. Repeated shortcuts during creation are ignored. The assistant roster appears once you add a specialist; **More → Assistants** remains available for creating one. The header’s **Search** button works on every page. **⌘/Ctrl K** opens the same search. Search includes messages, files, tasks, routines, skills, goals and visible assistant profiles. It also opens pages and Settings categories: try **dark mode**, **voice**, **archived chats**, or **computer**. Empty search offers five common destinations. Type and press Enter to open the first result, or use Down/Up to choose a result. Escape closes search and restores focus to the header button.

When the computer is under your control, the pause notice offers **Give back to Relay** directly in chat. It resumes the existing queued work without navigating or creating a message. Failed handback leaves control and drafts intact and allows an explicit retry. **Open computer** remains available for inspection.

The bottom bar still opens Chat, Files, Ideas, Tasks and More. Each destination has its own page and makes no chat messages or model requests. The redundant page selector has been removed. On narrow phones the computer shortcut is available through More and search, leaving the character and header controls room to work. An active task’s computer links remain in its chat card.

More also has an inline **Find a feature or setting** field. It filters pages and Settings categories in place: “dark mode” opens Appearance & personality directly, and “reminders” finds Routines. Enter opens the first match; Escape or Clear restores the list. It opens no search dialog, changes no settings, and adds nothing to chat. The existing page names and shortcuts are unchanged.

Drop individual files anywhere in the chat, paste an image into the composer, or use **Attach files**. Ordinary text paste stays unchanged. Up to eight files can wait in a draft, with an 8 MiB limit per file. Count and size errors are explained before uploading. A failed batch keeps files already attached and stops later files; it does not silently retry. Uploads finishing after you switch chats still belong to the original conversation. The Files page accepts the same drops. Folders are not supported.

You can attach a file and press Send without typing a caption. Until Send, the attachment remains a draft, including across page navigation and reload. Relay records the neutral caption “Shared with you.” and queues one request with the selected files. An empty message without attachments still cannot be sent. This does not grant permission for external actions.

Photos are visible in the draft, sent messages and returned image cards. Multiple photos share a compact grid in messages and a horizontal strip in the composer. Tap a thumbnail for the full image and download/save action; close the preview to return to the same draft. Keyboard focus returns to the attachment that opened it. The × removes an attachment from the draft without deleting its file. Incoming shared photos use the same preview. Damaged images explain that the preview is unavailable and retain the original download. SVG and other unsupported image formats remain normal file attachments.

Settings starts with nine categories: Appearance & personality, Memory, AI models, Usage, Voice, Notifications, Connected apps, Archived chats, and Data & devices. A category opens a focused page. **Back to chat** and **All settings** share the top toolbar, keeping both return paths visible while leaving more room for the controls. **All settings** returns to the list; **Chat** returns directly to the unfinished conversation. Categories have stable links such as `#settings?section=voice`, and browser Back/Forward works. An invalid category returns to the Settings list.

Unfinished forms stay mounted while switching between Settings categories, so a half-written model connection or preference does not disappear. Hidden controls are inert. Categories do not load their services until opened. Leaving the entire Settings page or reloading still discards unsaved settings edits; ordinary chat drafts have separate durable storage. Opening a new category or navigating never saves a form automatically. Hidden audio previews pause.

App setup starts with one address and **Continue**, automatically routing to tool review or an inline sign-in offer. The app name is filled for you and can be changed during review. Checking a link opens no popup, saves no connection and adds no chat messages; only choosing browser sign-in opens the provider. See [connected apps](APP_CONNECTIONS.md).

Setup links from dictation, voice calls, model-backed ideas, teaching and Google connections open the relevant category directly. The model status badge opens AI models. Permissions and external-action reviews retain their existing behavior.

Usage opens its own focused page with a period selector and expandable model details. Search for **usage** or **tokens** to open it directly. Reading counts adds nothing to chat and makes no model calls. See [usage behavior](USAGE.md).

## Keyboard navigation and focused search

The existing Search dialog has three scopes: **Everything**, **This chat**, and **Chats**. Changing scope keeps the query and focuses the search field. This chat searches only the current conversation (including a reply thread when opened), filters before the result limit, and jumps to the exact matching message. Chats lists active conversations and visible assistants without mixing in messages, files or settings. Everything retains workspace and page search. Search for **keyboard shortcuts** to open More, where the guide expands inline.

On Mac use Command; on Windows/Linux use Control:

- K: workspace search; F: find in the visible chat; Shift F: find chats and assistants.
- N: new side chat; B: show/hide the sidebar outside text editing.
- I or L: return to the current chat and focus its existing draft.
- 1–9: choose chats in active sidebar order (Main, side chats/groups, visible assistants, with duplicates removed).
- Control Tab / Control Shift Tab: cycle that order, including on Mac. Alt Up/Down does the same outside text fields.
- [ / ]: back/forward through visited pages and conversations.
- Shift M (also Shift W): connected apps; Shift comma: conversation details; comma: Settings.
- Enter: submit the current draft from the visible chat page. It never submits a hidden draft from another page or an open dialog. Ordinary composer Enter sends, Shift Enter adds a line, and primary-modifier D opens dictation.

Electron exposes the main commands in its File and Conversation menus. Native zoom/fullscreen remain in View. Browser-reserved shortcuts may stay with the browser; all destinations remain available through normal controls. Relay yields app shortcuts to the focused virtual computer/private-browser input and open dialogs. Composition, AltGraph and repeated DOM shortcut events do not create chats or submit drafts. Alt-arrow text movement and formatting keys keep text-editing behavior. This is Relay's implementation of the reference interaction pattern, not a guarantee about every OS or external keyboard layout.

## Verification

`tests/browser/workspace.spec.ts` covers one-tap search, keyboard focus/selection/dismissal, focused categories, browser navigation, deep-link reload, invalid routes, unsaved preferences, persistent chat drafts, unchanged message history, accessibility and narrow-screen fit. Existing model, voice, app and notification acceptance scripts use the new navigation and test real controlled HTTP service interactions.

`npm run navigation:test:easier` exercises the inline finder, direct category links, no-match behavior, retained drafts and attachment-only sending through a real worker with a controlled local HTTP provider on desktop and phone browser sizes. It checks no messages or model requests occur before Send, one attached request is sent, accessibility and viewport fit. This is browser acceptance, not native-device certification.

`npm run navigation:test:easier-mac` runs the same journey in the existing packaged Mac app connected to an isolated current server. It uses the native window's initial navigation and checks the rendered file input, not the operating-system file chooser. It does not rebuild or certify the packaged local backend.

`npm run navigation:test:desktop` exercises the packaged Mac app with a disposable local workspace and checks every Settings category with Axe. `npm run navigation:test:ios` exercises native WebKit search, category changes and retained drafts on a disposable iPhone Simulator. Run a production build and `npx cap sync ios` first. It creates and deletes only its own Simulator. Android and physical-device acceptance remain separate release gates.

`npm run files:test:ui` runs actual server/worker and Docker file-transfer journeys on desktop and phone browser sizes. `npm run files:test:mac` runs them in the packaged Mac remote client. These use DOM drag/paste events and rendered file inputs, not Finder or an operating-system picker. Exact bytes, count/size limits, partial failure, cross-chat upload completion, attachment-only Send, retained history and duplicate guest names are checked.

The native iPhone Simulator journey also exercises a real OS image paste and full relaunch. A foreground debug-only source places the test image on the Simulator pasteboard; the native Paste menu and production upload/draft code perform the intake. Physical-device and cross-app permission acceptance remain separate.

`npm run photos:test:ui` exercises image decoding, preview/focus return, original downloads, removal, retained per-chat drafts, blob cleanup, sent/returned photos, actual HTTP image-tool payloads, damaged files, shared photos and light/dark accessibility. `npm run photos:test:mac` runs it in the packaged Mac client and verifies Electron download bytes using a disposable destination; it does not exercise the OS save dialog.

`npm run photos:test:tablet` runs those photo checks at landscape and portrait tablet sizes. `npm run computer:test:direct-ipad` uses a disposable native iPad Simulator and an actual isolated Docker desktop. It verifies touch/keyboard computer control, handback directly from chat, search, focused Settings, side-chat drafts and native image paste/preview. Rotation and full app relaunch retain the desktop, caption and attachment. These checks pass on iPad Air 11-inch (M4), iOS 26.5; physical iPads, window multitasking and external input devices remain unverified.

`npm run navigation:test:shortcuts` checks exact-message scoped search (including a match beyond 30 unrelated messages), retained queries/drafts, numeric/cycle/history navigation, page-only send, dialog/guest-focus boundaries, composition/repeat protection, inline help, accessibility and a real controlled HTTP model request. It runs on desktop and phone browser layouts. `npm run navigation:test:shortcuts-mac` runs the same journey in the rebuilt packaged Mac remote client and invokes its real native menu callbacks. These do not certify all physical OS-reserved keys. The native iPhone navigation test checks all three search scopes preserve typed queries.

## Chat list controls

Each conversation now has a small options button. Pin side chats, mark a chat read/unread, or archive directly from its row. Main chat stays first; number and cycle shortcuts follow the visible pin order. See [Chat organization](CHAT_ORGANIZATION.md) for persistence, notification behavior and verification.

## A draft survives an app restart

Each keystroke is staged in this origin's session and persistent browser storage while the normal workspace save is pending. This preserves the final text when a native app terminates before the 450 ms save delay. The key includes the chat's ID and creation timestamp; it is read only when that workspace opens. A successful matching save removes both temporary copies. Storage failures retain the other available path. This is a local pending-text recovery copy, not an offline message outbox or permission to send; attachments keep their existing server-backed draft behavior.

## Computer recovery in chat

A paused chat shows **Start & resume** when its configured virtual computer is asleep. It wakes the existing runtime and hands back after readiness, with progress and cancellation beside the composer. **Open computer** remains available for inspection. This shortcut preserves the current draft and creates no navigation/setup messages. A running computer keeps the direct **Give back to Relay** action. See COMPUTER.md for control-race and restart behavior.

## First conversation and AI setup

An unconfigured self-hosted chat offers **Connect AI** at the point of use. Its separate AI models page remembers the originating chat in a bounded local route parameter. Only explicit activation returns to that chat; drafts and attachments stay unsent. Normal settings, failed activation, background refreshes and leaving the page do not trigger navigation. Sample examples remain available under an explicit disclosure. See MODELS.md.

## Voice setup from chat

The microphone and **⌘/Ctrl D** open Voice settings directly when listening is missing. The waveform button opens Voice settings when listening or speaking is missing; if both are ready and only AI is missing, it opens AI models with the original chat as the return destination. **Connect AI** from the ready local-voice panel uses the same return flow. No empty call bar or additional “open settings” step is needed.

These setup gestures allocate no microphone or call. Completing setup does not start recording: return to chat and tap the microphone or waveform when ready. The existing Back to chat action, draft storage and per-chat attachments remain in use. Browser reload preserves the setup page; the native iPhone app reopens chat after full termination and retains its draft. A late missing-configuration state during capture still has its recovery explanation.

## Pick up where you were reading

Main and side chats each remember the visible message and its position on this device. Switching chats, opening a separate page, reloading, or reopening the app restores that place. New results can arrive without pulling you away from older messages. **Latest messages** returns to the live end; explicit search/message links still open the requested message. Sending a new message keeps its existing follow behavior.

Positions are bounded to 80 conversations, scoped by workspace/thread creation, and contain only message IDs and geometry—not message text. The current window keeps its own session copy, with a device-local fallback after a full restart. Reading positions are not synchronized to another device. Storage failures fall back to memory. Font loading is allowed to settle before restoration completes; scrolling, touching or typing takes precedence. This introduces no setting, popup or chat-history entry.

## Quieter message controls

The existing **Message actions** button sits beside each bubble with a 44-pixel phone target. Closed controls no longer reserve a separate row. Tap the button for inline reactions, copy and reply; desktop hover and keyboard focus on the action controls also reveal the toolbar. An outside click closes it after the destination control receives that click, so opening a file or playing a voice memo cannot lose the tap to a collapsing row. Focus on message links, attachments and cards does not expand unrelated controls.

Swipe right to reply, stored reactions, quoted replies, drafts and separate pages keep their existing behavior. No new dialog or setting is introduced. `npm run chat:actions:test:ui` checks four widths in light and dark mode; `npm run chat:actions:test:mac` runs the same action journey in the packaged Mac client against an isolated backend. The native phone touch journey also checks reaction/reply actions and full-relaunch persistence.
