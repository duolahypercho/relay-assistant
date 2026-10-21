# Relay

[![Verify Relay](https://github.com/duolahypercho/relay-assistant/actions/workflows/ci.yml/badge.svg)](https://github.com/duolahypercho/relay-assistant/actions/workflows/ci.yml) · [MIT license](LICENSE) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

An independently built personal assistant with one continuing chat, optional side chats, an original animated companion, and a private computer for delegated work. Source code is MIT licensed.

**Early development release.** Relay is usable for local development and experimentation; model reliability, natural voice latency, physical-device acceptance and signed app distribution remain open. In the latest six-case local-model check, five passed; the calendar case answered without reading the calendar. See the [verification record](docs/VERIFICATION.md) for passing checks and retained failures.

Get started with Node.js 24 or newer:

```sh
git clone https://github.com/duolahypercho/relay-assistant.git
cd relay-assistant
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. Try the sample workspace immediately, then connect your provider in **Settings → AI models** for real assistance. See [model setup](docs/MODELS.md) and [desktop/mobile setup](#desktop-and-mobile-applications).

The active direction is a **JARVIS-style personal assistant**: natural voice interaction, useful memory, proactive help, and verified work across apps and its private computer, accessible from desktop and phone. See the [product goal and acceptance milestones](docs/JARVIS_GOAL.md). This describes the target; the verification record identifies what currently works.

To prepare a shareable source archive, run **`npm run release:source`**. It uses the reviewed file list and includes checksums and build instructions. **`npm run release:source:verify`** rebuilds it in a clean folder. See [release preparation](docs/RELEASE.md) for scope and remaining desktop/mobile signing gates.

For a Linux server that stays available to your phone, see [Keep Relay online](docs/HOSTING.md). An administrator can attach a [separate computer VM](docs/REMOTE_COMPUTER.md) for the assistant through mutual TLS, with the same Computer page on desktop and phone.

Supported Mac servers offer **Settings → Voice → Set up voice**, which enables local listening and installed Mac speech together. Packaged Linux servers offer **Set up local listening**: an explicit download (~202 MB on Mac, ~148 MB on Linux) enables on-server dictation and voice-chat recognition without an audio-service account. Phones use the same Relay server. See [local listening](docs/LOCAL_LISTENING.md) for limits and verification.

Your direct messages now get attention while background work waits and resumes automatically. No priority setting or popup is needed. Completed actions are retained. See [direct-message priority](docs/WORK_PRIORITY.md) for behavior and limits.

Send **Stop now** in a direct chat to halt its current and delegated work, pause queued follow-ups, and retain completed results. See [stopping from chat](docs/STOP_WORK.md) for scope and recovery.

Send a correction while Relay is replying to update the current direct-chat request, or choose **Queue follow-up** to handle it afterward. Finished tool results stay available. See [follow-ups during work](docs/FOLLOW_UPS.md) for behavior and limits.

A personal assistant built around one continuing **Main chat**. Send a message, attach a file, follow a task, and review an action in the same chat. **Show chats** opens a collapsible sidebar with the pinned Main chat and optional **Side chats**. **New side chat** creates a side chat; each has a way back to Main chat. A new window starts in Main chat; reloading the same window keeps the selected chat and explicit page link. Each conversation keeps its own draft and history. Optional specialist assistants have their own role, chats, memories, enabled skills and routines; manage them on the separate **Your assistants** page. See [assistant profiles](docs/ASSISTANTS.md). **Share setup** creates a reviewed configuration template; recipients import it into a fresh assistant with paused routines. [Sharing details](docs/ASSISTANT_TEMPLATES.md).

Relay is an independent implementation. It does not fork, import, vendor or depend on OpenMuse or Muse code, styles, logos or artwork. The reference study is separate from this repository. Relay’s application code is MIT licensed; its standard dependencies keep their own licenses.

Navigation opens separate pages for tasks, files, calendar, spending, skills, routines and computer controls without adding messages or model runs. Results requested in conversation and necessary questions remain in chat. Page-created action reviews stay on the task page. Returning to chat preserves the draft, selected attachments and the message you were reading. Main and side chats remember their own reading positions through reload and app restart on this device; **Latest messages** returns to the live conversation. The five-button shortcut strip opens Main chat, files, ideas, tasks and More. The original anime sprout companion blinks, walks, waves when greeted and reacts to work state. Tap, drag or use the arrow keys to move it; its pause control and reduced-motion support keep the chat comfortable.

**Search** is one tap away in the header (or ⌘/Ctrl K). Find messages and files, or jump straight to a control with “dark mode,” “voice,” or “archived chats.” Settings opens a short category list; only the selected category shows its controls. Unfinished forms stay intact while you move between Settings categories. [Navigation details](docs/NAVIGATION.md).

Drop files into the chat or paste an image into the composer. Photos appear as thumbnails in the draft and conversation; tap one to inspect or download the original. Models with image support can answer about these photos even without tools, and follow-up questions retain the pictures in the same chat. Attachments stay in the draft until **Send**, even when you switch chats during an upload. The Files page also accepts drops. On the private computer, **Add files from your device** or a drop onto the desktop copies files into its current folder, keeping both when names match. [Computer file transfers](docs/COMPUTER.md#files-and-actions). Select text on the computer and choose **Copy** to use it on your device; normal desktop Copy/Cut/Paste shortcuts work too. [Clipboard details](docs/COMPUTER.md#copy-and-paste).

Personal ideas connect open goals and current context to useful next steps. Check manually, inspect sources, edit a request inline, or opt into occasional Main chat nudges. Background checks are off by default. See [Ideas](docs/IDEAS.md).

Choose **+ → Teach a task** in chat to show Relay a workflow on its computer. Its review opens on a separate page; the test returns to the original chat with the unfinished message and attachments intact. Review the captured steps, edit the generated method, then save and test it as a skill. Screenshots reach the model only when you request a draft. See [Teaching](docs/TEACHING.md).

Relay's visual identity uses warm cream, seafoam, grouped message bubbles with curved tails and the original sprout. Message actions offer local reactions and quoted replies that preserve the draft; swipe a text bubble right on a touch screen, or use its ellipsis button. Right-click and double-click also reveal message actions. New messages have a brief reduced-motion-aware arrival animation. Dark mode uses forest tones. The interactive character lives in the chat header, leaving the conversation and composer clear. Reference products inform the interaction structure; their graphics and styles are not shipped.

When a necessary choice is missing, the assistant can offer buttons inside its message. Choose one or type your own answer; your main draft stays untouched. Questions and answers survive a restart. You can also start a task from one field in **My tasks**, with optional context and no creation popup.

Saved methods are available from chat: choose **+ → My skills**, or save a helpful reply as a skill. Type `/` to select one. Routines can use a saved method and keep its version until you explicitly update it.

Mobile apps include incoming sharing: iOS accepts text, links, photos and files through a native chat picker. Android import supports text, photos and multiple files, with scoped emulator acceptance recorded in [Android testing](docs/ANDROID_TESTING.md). Attached items wait beside the selected chat’s composer, preserving your draft until you send. See [mobile sharing](docs/MOBILE_SHARING.md) for setup and actual test coverage.

Videos can also be inspected from chat: the assistant can sample timestamped frames and transcribe soundtrack segments through your listening service. Install current FFmpeg/ffprobe on the server for this capability; mobile uses the same server. Original files stay intact. [Video setup and limits](docs/MEDIA_FILES.md).

## Run it

Use Node.js 24 or later. The default binds to your computer’s loopback address.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. A fictional sample mailbox, editable PDF, calendar, goals and transaction import are included. No messages leave the sample mailbox.

For a production build:

```sh
npm run build
npm start
```

Open **http://127.0.0.1:4173**. The Node server stores the workspace in `data/relay.sqlite` and runs a background worker. Keep the server running for work and trackers to continue after closing the browser.

A static build can be served from `dist/`. It runs a clearly labeled sample workspace in that browser’s IndexedDB. Its tasks and trackers operate while the page is open. A static preview cannot connect a real model, Google account or remote computer; those integrations belong to the supplied server.

## Desktop and mobile applications

The desktop app runs the same SQLite server in an Electron utility process. Closing its window leaves background work running; **Quit Relay** stops it. Build and launch it with:

```sh
npm run build
npm run desktop:dev
npm run desktop:test
npm run desktop:package
```

The package is created under `release/desktop/`. Its native menu opens chats, search, preferences and a shared-server connection screen. The default workspace lives inside the app's user-data directory. Add chat models in Settings. Optional environment settings can also go in `server.env` there. The native source and refreshed packaged macOS arm64 app have passed window-close, scheduled-reminder, restart and persistence checks. Quitting Relay leaves its virtual desktop open while Docker remains up; **Stop computer** closes its apps and jobs. A local Debian installer and isolated native Linux acceptance harness are also available; see [Linux desktop](docs/LINUX_DESKTOP.md) for exact scope and results. Windows, other Linux distributions and signed/notarized distribution remain unverified.

The iOS and Android projects use the same conversation UI through Capacitor. Results include a native **Save file** action and a separate interactive preview screen; see [mobile results](docs/MOBILE_RESULTS.md) for platform verification limits. In the mobile app, **Settings → Data & devices → Connect your devices** opens a native server-address form. Connect to the same HTTPS Relay server as desktop to share work. A device-local sample is also available. No server access key is stored in the connection form; authenticate with the chosen server after connecting. Native iPad Simulator checks now cover landscape/portrait, retained photo drafts and control of the same computer after relaunch. See [tablet verification](docs/VERIFICATION.md#ipad-landscape-portrait-and-native-computer--october-11-2026); physical tablets and window multitasking remain unverified.

```sh
npm run mobile:sync
npm run mobile:ios
# or
npm run mobile:android
```

Xcode builds the iOS project. Android requires a JDK and Android SDK. The iOS simulator build and initial launch are verified; the native form rejects insecure remote URLs, connects to a development server, and sends a message that is persisted by the server. HTTPS sign-in, interrupted-session recovery and synchronization with an independent TLS client now pass on iPhone Simulator; see [connection recovery](docs/CONNECTION_RECOVERY.md). Scoped Android builds and emulator journeys are recorded in [Android testing](docs/ANDROID_TESTING.md); physical-device acceptance remains outstanding. `RELAY_MOBILE_SERVER_URL` can set a default URL during sync; production devices need an HTTPS server reachable from that device. Loopback HTTP is for local development only. Physical microphone/device checks, physical push delivery and release signing remain on the [parity checklist](docs/PRODUCT_PARITY.md).

## Connect an AI model

Open **Settings → AI models**. **Connect OpenRouter** offers browser sign-in. **Use a local model** finds models in Ollama or LM Studio on your Relay computer. An empty setup offers **Set up & use**: install Ollama if needed, start it, download the displayed model and connect it to chat. Existing model choices and manual setup remain available. No address or key typing is needed; you can choose to start Ollama with Relay next time. **Add a model** supports provider API keys and custom endpoints. You can keep multiple named connections and switch between them without editing files or adding messages to chat. See [model setup](docs/MODELS.md).

**Settings → Usage** shows model requests and reported tokens by model and period. Search for “usage” to open it directly. Missing counts stay unknown; provider subscription limits and charges are not available. [Usage details](docs/USAGE.md).

Optional **Backup models** lets you choose up to three saved connections for provider outages. It is off by default and discloses context sharing and provider charges. Unfinished requests keep their approved order; new requests start on the primary. See [model connections](docs/MODELS.md) for boundaries and test coverage.

OpenAI Responses, compatible Chat Completions, Anthropic Messages and Gemini are implemented independently. Presets include OpenRouter, xAI, DeepSeek, Groq, Mistral, Together AI, Ollama and LM Studio; custom endpoints can use any supported format. Keys are encrypted on the Relay server and never returned to the UI or workspace export. Existing environment configuration remains available as a read-only connection. See [setup, security and compatibility limits](docs/MODELS.md).

The live assistant can read connected context, inspect files, calculate spending, research public pages, learn sourced preferences, create goals, delegate work and prepare action reviews. It cannot approve its own actions. Choose a model with tool calling for workspace actions and vision for computer screenshots. Controlled transport and worker tests verify the adapters; every hosted model has not been individually tested.

Without a model, the sample assistant routes a bounded set of example requests to real local workflows. It explicitly identifies itself as the sample assistant. Its generic planning output is a scaffold, not invented research or completed work.

## Personal memory

Relay can learn stable preferences from your messages with a connected model. Saved notes include a source link and quote. Edit or forget them in **My memories**, or turn **Learn from our chats** off to save only explicit requests. Your edits stay active until you choose whether to accept a proposed update. See [memory behavior and limits](docs/MEMORY.md).

## Voice input

Choose the microphone beside the composer, or press Cmd/Ctrl+D while typing. Missing listening opens Voice setup directly; once configured, a fresh tap starts recording inline. Choose **Done** to stop and transcribe directly into the current draft, then edit or send whenever you are ready. The cancel button discards the recording. No recording dialog or automatic message send is involved. Recording stops after two minutes, when the app goes into the background, or when the microphone ends. The recording stays in memory until transcription or dismissal; Relay does not save it to files or chat.

In **Settings → Voice → Set up listening**, enter your audio endpoint, model ID and optional API key. Expand **Test this connection** to upload a short recording and check the transcript, then save. Alternatively, use these server environment settings:

```dotenv
RELAY_TRANSCRIPTION_BASE_URL=https://api.openai.com/v1
RELAY_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe
RELAY_TRANSCRIPTION_API_KEY=your-own-key
```

These values are independent of the chat model. A local compatible speech service can use loopback HTTP. The interface shows the destination before you choose Done. Saved API keys remain encrypted on the server; the client sends audio to its signed-in Relay server, which forwards only the recording and model parameters. Provider retention depends on that service. Relay does not retry automatically. If a request fails, the local preview remains available for an explicit retry; closing it cancels the request and releases capture.

Voice input requires a secure browser context and microphone permission. Electron asks for microphone access only for the main workspace; iOS and Android include microphone usage declarations and retain OS permission prompts. Browser and packaged Mac checks use synthetic microphone audio and a local controlled speech endpoint. Live transcription quality, real microphones, physical devices and Android recording/calls remain unverified. Live voice conversations use a compact bar below the chat heading and are checked with synthetic audio in browsers, the packaged Mac renderer and native iPhone Simulator; see [voice calls and setup](docs/VOICE_CALLS.md). The static sample explains that a configured server is required.

## Voice replies

On a Mac, choose **Settings → Voice → Use Mac voice** for the installed system voice, with no speech-service account or API fields. Preview it inline, then listen to a reply on the Mac or a phone connected to it. The first request can take a moment; cancellation and Off remain available. This supplies speaking only—listening still uses its own connection. See [Mac system voice](docs/SYSTEM_VOICE.md).

Choose **Create voice memo** on a completed assistant reply, or explicitly ask your configured model for a voice memo. The player stays in the message: play/pause, seek, download and expand the exact transcript. Only one recording plays at a time; backgrounding pauses playback. Audio and transcript persist in SQLite across restarts. The label identifies the voice as AI-generated. This is saved audio, not a live voice call.

To use a speech provider instead, open **Settings → Voice → Set up speaking**, enter your audio endpoint, model and voice IDs, and optional key. Preview the voice and save. Alternatively, use these server environment settings:

```dotenv
RELAY_SPEECH_BASE_URL=https://api.openai.com/v1
RELAY_SPEECH_MODEL=gpt-4o-mini-tts
RELAY_SPEECH_API_KEY=your-own-key
RELAY_SPEECH_VOICE=coral
```

Only the selected reply or requested memo text goes to that service. The endpoint must return WAV, up to 8 MB; text is limited to 4,096 characters. Failures remain inline and require an explicit retry. Cancelling prevents a late audio result from being saved. Authenticated audio downloads support byte ranges; ordinary chat state updates include metadata only, while explicit workspace export includes audio. Provider-adapter tests use a generated tone and local service. Mac system-voice acceptance instead generates real speech and verifies playback and storage; neither establishes subjective voice quality.

## Google Mail and Calendar

Create your own Google OAuth web client and enable the Gmail and Calendar APIs. Set its client ID and secret on your server. Configure this exact redirect URI for the development server:

```text
http://127.0.0.1:5173/api/google/callback
```

Use your configured `RELAY_PUBLIC_URL` with `/api/google/callback` for another deployment. Generate a token encryption key:

```sh
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64')+'\n')"
```

Set it as `RELAY_TOKEN_ENCRYPTION_KEY`, restart, then connect in **Settings → Connected apps**. Read-only scopes are the default connection option. Reviewed write access is a separate connection choice. Sync Mail or Calendar explicitly. Mail sync fetches at most 25 messages per request and retains at most 250 locally. Calendar sync fetches at most 100 events within the selected range. Pagination limits are disclosed. Recurring events are displayed but edited in Google Calendar.

Email reviews freeze recipients, subject, body and attachment bytes. Calendar reviews preserve provider identity, calendar identity and ETag. Approval is tied to the connected account generation, expires after 30 minutes, and can be consumed once. A transport failure after an external write may have an unknown outcome; Relay records that warning and never resends automatically. Inspect the provider before preparing another review.

Google integrations are contract-tested with controlled API responses. No real Google account was connected during this build’s verification.

## Public research and tracking

Provide public URLs in a research request to read and save source excerpts. A configured model can synthesize those excerpts. Optionally set `BRAVE_SEARCH_API_KEY` for sourced web searches. Search is an optional provider dependency; a missing key is reported honestly.

Track page text changes, specific text or a USD price threshold. The first change observation establishes a baseline. Availability and price trackers alert on a transition into a match, rather than on every check. Errors back off, paused trackers discard stale observations, and observations persist in SQLite. Dynamic or authenticated pages may require a different connector. The built-in `relay://workshop` fixture lets you test alerts without an external service.

## Browser and command workspace

Install Chromium once for the persistent public browser:

```sh
npx playwright install chromium
```

Or set `RELAY_BROWSER_CHANNEL=chrome` to use an installed Google Chrome. Relay launches a separate profile inside its data directory. It does not use your personal browser cookies. Open a public URL in Computer, inspect the screenshot and page text, then choose **Take control** to click, type, scroll or press a supported key. The public browser blocks outbound writes and private-network destinations. It is not a logged-in purchasing or payment agent.

For isolated terminal commands, install and run Docker, then build the included workspace image:

```sh
docker build -f docker/workspace.Dockerfile -t relay-workspace:local .
```

Set `RELAY_COMPUTER_ENABLED=true`. Approved commands run as a non-root user in a read-only, offline container with CPU, memory, PID, time and output limits. Its writable `/workspace` is a named Docker volume. Host folders, keys and the Docker socket are not mounted into the command container. Existing containers are checked for the required isolation settings before reuse. Commands never fall back to a host shell. The application’s Files library is stored in SQLite; it is distinct from that container’s volume.

The server controller needs Docker access; run that controller on the host when using terminal commands. The separate application Dockerfile includes the persistent browser, but does not grant the app Docker socket access. The Docker/Colima computer now has real-runtime acceptance checks; see [computer verification and its limits](docs/COMPUTER.md).

## Publish and protect your own installation

The workspace's `.openai/hosting.json` identifies its private static preview. It is optional deployment metadata and is omitted from the downloadable source archive. An independent installation can serve `dist/` for the sample or run the supplied Node server for integrations and background execution.

Relay is a single-owner app. Keep loopback binding for local use. To expose the server, use the [Linux HTTPS deployment](docs/HOSTING.md), or set a `RELAY_ACCESS_KEY` of at least 24 characters (also available through `RELAY_ACCESS_KEY_FILE`) and a correct `RELAY_PUBLIC_URL`, and put it behind HTTPS. Remote binding without a sufficiently long key is refused. The shared key is not a multi-user authentication system. Google tokens are AES-GCM encrypted; workspace content itself is not encrypted at rest. Use disk encryption and access controls on the host as appropriate.

Stop the server before copying its data directory for backup. Export in **Settings → Data & devices** gives you workspace JSON without server secrets; that export is for inspection and backup, not an automatic restore format. Back up the token encryption key separately if you need to restore a connected account.

## Test and contribute

```sh
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

The Node suite requires OpenSSL on PATH for temporary HTTPS certificates. The optional `npm run computer:test:browser-authority`, `npm run computer:test:trusted-browser` and `npm run computer:test:browser-ui` also require installed Chrome. They check the experimental credential/request core, browser runtime/owner API, Computer Browser view and assistant tools. The runtime is off by default. `npm run computer:test:browser-isolation` additionally uses the actual Docker/Colima engine; `npm run computer:test:browser-ios` uses an isolated iPhone Simulator plus actual Docker. Both pass, along with desktop/phone browser and packaged Mac remote-client journeys. The page review now groups its same-origin rendering resources within one bounded action; `npm run computer:test:page-loads` exercises this scope and its exclusions in Chromium. The production opt-in browser now uses its own restricted container with pipe-only control and no direct networking; run the container checks listed in the guide. Broader task-sensitive review, taint/credential coverage, live-account/physical-device/Android acceptance remain unfinished. The mobile web assets and local iOS Simulator app have been refreshed. The Mac bundle is current. See [the tested scope and remaining work](docs/TRUSTED_BROWSER.md).

The browser suite uses isolated sample workspaces and temporary server data. It checks desktop and mobile chat, queue and draft behavior, PDF downloads and actual filled field values, approvals, notes, calendar, goals, tracking, preferences, responsive layout and accessibility. API tests include sessions, cross-origin writes, host validation, storage rollback, provider contracts, background work and a real process restart.

See [the feature matrix](docs/FEATURES.md), [parity checklist](docs/PRODUCT_PARITY.md), [architecture](docs/ARCHITECTURE.md), [reference study](docs/REFERENCE_STUDY.md), [verification report](docs/VERIFICATION.md), [contributing guide](CONTRIBUTING.md) and [security notes](SECURITY.md). The parity checklist keeps the complete Muse/Grok Bot/Dot scope visible, including features and platform checks that remain unfinished.

The routines page is available through **+ → My routines**. Schedule assistant work or a direct reminder, inspect the next run in an explicit time zone, test it, then enable it. The server handles due work with no browser open; the static sample requires the app to stay open. See [features](docs/FEATURES.md#routines-and-reminders) for pause, history, restart and daylight-saving behavior.

### React to incoming email

From **My routines**, choose **When a matching email arrives**, enter a sender or subject filter, and save. Test it against a matching synced email before enabling. Connected Google triggers check about once a minute while your server runs; they start after the first successful baseline check. Results and action reviews appear in chat. See [feature details](docs/FEATURES.md#incoming-email-routines) for failure recovery, queue bounds and account changes. Live Google-account verification is still required.

### Private agent computer

Relay now includes an independently built Linux desktop with persistent files, agent screenshots and input, and an owner takeover control. Fresh Apple silicon Macs running macOS 14+ can install a private VM directly from **Computer → Set up computer**; see [installation requirements and limits](docs/COMPUTER_INSTALLATION.md). The same **Stop computer** button gracefully stops a Relay-installed VM and releases its memory; **Start computer** reopens the saved workspace. Shared engines keep their existing behavior; see [computer power controls](docs/COMPUTER_POWER.md). With an existing Docker (or Colima plus the Docker CLI on macOS) running, choose **Computer → Set up computer**, then **Start computer**. Relay prepares its original workspace, verifies it, and saves setup without a server restart. Progress, cancellation and retry stay on the Computer page. The operator CLI `npm run computer:setup` remains available. **Computer care** prepares a bundled workspace update without interrupting the desktop, then reviews its restart. Error states offer **Recover computer**. Both preserve saved files and leave Relay paused for owner review; unsaved work and running jobs close. Failed updates attempt to restore the previous software. **Restore points** saves a dated workspace/profile copy and restores it after an inline review, retaining an automatic **Before restore** point for undo. These copies stay on the same Docker engine; chat history and software versions stay current. The computer starts without website permissions. An inline **Allow & continue** card grants a website connection for up to one hour and resumes the saved request; the separate Computer page manages revocation. Direct guest networking remains disabled. Agent commands and their detached apps freeze during takeover and resume on handback, while the desktop browser stays available. Click the desktop and type directly, or drag to move windows and select text. Input stays ordered while the view updates; Tab leaves the screen. Phones also keep the separate keyboard field. Network grants include forms/uploads and do not replace exact transaction reviews; see the documented boundaries. See [computer setup](docs/COMPUTER.md) and [research and remaining gaps](docs/COMPUTER_RESEARCH.md). Longer jobs return progress cards, survive a Relay service restart while the same guest stays alive, and continue the original request once after completion. Stop them from chat or Computer. Interactive programs can receive replies, interruption or EOF through their job details; the agent can answer them through PTY tools. Input receipts prevent duplicate keystrokes after an interrupted response. Run `npm run computer:test:restart`, `npm run computer:test:interactive`, `npm run computer:test:interactive-ui`, `npm run computer:test:jobs`, `npm run computer:test:jobs-ui`, `npm run computer:test:runtime`, `npm run computer:test`, `npm run computer:test:web` and `npm run computer:test:web-ui` for real-container acceptance, rather than relying on mocked runtime checks.

Assistant work pauses while you control the private computer. Waiting messages stay in their own bubbles, and handback resumes work without repeating saved tool steps. A server restart during an uncertain tool action asks for inspection instead of replaying it. See [computer handoff and recovery](docs/COMPUTER.md).

## Generated results

Ask your model for a document, spreadsheet, slide deck or interactive page. Open its chat card to preview, edit, save a new version or download DOCX/XLSX/PPTX/HTML. You can also start in **Files → New result**. Original versions stay available; editing and navigation add no chat messages. See [result formats, limits and preview boundaries](docs/ARTIFACTS.md).

Live voice chat is available beside dictation in the empty composer. Configure chat, transcription and speech services, then speak naturally, interrupt a reply, mute or end the call. [Voice call behavior and limits](docs/VOICE_CALLS.md).

## Connect your apps

Use **More → Connect apps** to add an app address, sign in through its website, select tools and choose which assistants may use it. Tokens and advanced client details are optional, collapsed settings; expiring OAuth credentials refresh automatically before a tool runs. Read tools can be allowed explicitly; other actions use an inline review and resume the original request after confirmed success. [Setup and current limits](docs/APP_CONNECTIONS.md).

## A simpler everyday flow

Chat is the starting point. **+** attaches files directly; the labeled bottom bar opens Files, Ideas and Tasks as separate pages. **More** collects Calendar, Mail, Routines, Goals, Spending, Computer, Skills, Assistants, app connections and Settings. Browsing these pages keeps drafts and attachments and adds no messages. The sidebar’s labeled **New side chat** button opens straight into typing. Empty assistant-management controls stay out of the sidebar; add a specialist from More when needed. A paused assistant can be resumed with **Give back to Relay** in chat.

Desktop/mobile notification preferences live in **More → Settings → Notifications**. [Setup, delivery behavior and limits](docs/NOTIFICATIONS.md).

Open the chat header and choose **Personalize** to pick a character, crop your own picture, or **Create with AI**. The optional image service is connected once; describe a character, preview it and use it in the profile. Connection details stay collapsed and the chat history stays clear. [Appearance setup and current limits](docs/APPEARANCE.md).

With the experimental private browser enabled, approved website downloads go straight to **Files** and the assistant's result card. The browser keeps a shortcut to the latest download; **All files** opens its own page. [Supported downloads and boundaries](docs/TRUSTED_BROWSER.md#downloads-into-files).

Search now supports **Everything**, **This chat**, and **Chats** while keeping your query. Use **⌘/Ctrl F** to find a message, **⌘/Ctrl I** to return to your current draft, and **⌘/Ctrl 1–9** to switch chats. The Mac app exposes commands in its Conversation menu; **More → Keyboard shortcuts** shows the full guide inline. See [navigation](docs/NAVIGATION.md) for browser/keyboard scope and verification limits.

PDF requests now read page-labeled text and saved form values. An image-capable model can inspect scanned pages and diagrams; multi-page reading leaves one file card in the reply. Open a PDF and choose **Ask about this**, or attach it directly to your message. [PDF reading and limits](docs/PDF_READING.md).

Office attachments now open with a readable text preview. The assistant can read DOCX paragraphs/tables, XLSX cells and cached formulas, and PPTX slides/speaker notes before producing a revised downloadable result. Originals are preserved. This is content extraction and generation, not a full Office layout editor; [supported content and limits](docs/OFFICE_FILES.md) are documented.

Choose connected apps directly in a message with `@`. Selections stay with each chat draft, appear on the sent message, and remain attached to the original request through follow-ups and action reviews. See [connected apps](docs/APP_CONNECTIONS.md).

Reusable skills can include scripts, references and templates in one reviewed ZIP. Run the saved skill from chat; Relay can prepare its files and execute helper scripts in the private computer. See [skill packages and limits](docs/SKILL_FILES.md).

Local setup offers a single Set up & use action with the model and download size shown first, inline progress, cancellation and recovery. Choose another model keeps individual installation, startup, download and connection options available. On phones, downloading still happens on the Relay server computer. See [model setup](docs/MODELS.md) and [verification](docs/VERIFICATION.md) for supported models and tested surfaces.

Model setup now reports local Ollama abilities. Text-only models can chat without tool errors; saved ability overrides support other compatible providers. Files, apps, computer actions and image handling still require the relevant model support. See [model abilities](docs/MODELS.md) for boundaries.

Attached text, PDF, DOCX, XLSX, PPTX and EML files can be discussed directly by models without tools through the usual composer; see [document chat and limits](docs/MODELS.md#document-chat-without-assistant-actions).

A paused chat can **Start & resume** its sleeping virtual computer directly, with progress, cancellation and readiness-checked handback beside the composer. See [computer recovery](docs/COMPUTER.md#resume-directly-from-chat).

Open **Computer → Restore points** to save an [encrypted backup](docs/COMPUTER_BACKUPS.md) to your device or import one. Import opens a review before restoring; the command-line workflow remains available.
