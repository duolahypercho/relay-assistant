# Install local AI from Relay

The default empty setup is **Connect AI → Use a local model → Set up & use**. One explicit action installs Ollama if needed, starts it, downloads the named **Qwen 3.5 · 4B** model and connects it to chat. The screen shows approximately 4 GB for the model and, on a Mac without Ollama, the 167 MB runtime before starting. A phone performs setup on its connected Relay computer, not on iOS or Android. The primary action fits above the dock at 320×568 and 390×675.

Existing Ollama and model downloads are reused. A single progress view offers **Cancel setup**, inline recovery and **Continue setup**. Leaving Settings or reopening a client restores progress while the server keeps working. Server quit interrupts the operation; reopening never resumes an interrupted install/download or activates a model without another explicit action. Ollama itself can restart with Relay when the chosen startup preference is on.

Success returns to the original chat and retained draft when entered through Connect AI. It never sends that draft or inserts setup messages. Ordinary Settings visits remain in Settings. Cancellation preserves the active model; completed downloads are kept. A running service is never stopped just because setup was cancelled. An unfinished startup that Relay owns is cancelled through its existing supervisor. If the AI connection changes on another device during setup, Relay keeps that choice and asks for review instead of activating the downloaded model late. Opaque vault revision checks detect switching away and back as well as editing a saved connection.

**Choose another model** opens the existing manual flow, including LM Studio, local-model selection, individual installer/start/download controls, and custom connection details. An existing individual operation keeps its own progress view; combined setup cannot take it over. Individual install, download and startup mutations are locked while combined setup runs. Reading status and choosing another active AI connection remain possible. The combined operation is owner-only, same-origin protected, request-ID deduplicated and unavailable as an agent tool.

## Download and storage

The implementation is original Relay code. It downloads the official Ollama runtime as an optional third-party dependency; it does not incorporate source or assets from another assistant. This version pins the universal Apple Silicon/Intel `ollama-darwin.tgz` from [Ollama 0.40.3](https://github.com/ollama/ollama/releases/tag/v0.40.3). The [published assets](https://github.com/ollama/ollama/releases/expanded_assets/v0.40.3) give its SHA-256:

```
a2d1d906a2c8febd9cb18f5c183854d0a6db5dc522940d68b0c0ed048e8dfdea
```

Relay verifies the exact 167,455,486-byte length and digest before extraction. It accepts only the fixed release URL and HTTPS redirects to GitHub's release-asset host, with a 15-minute deadline and two-minute stall limit. Client input cannot choose a URL, executable, destination, archive or command. Owner authentication and same-origin write protection apply; assistant tools have no installation action.

The package is staged beneath `<data directory>/runtimes/ollama`, inspected, then moved to `v0.40.3`. It retains upstream bundled licenses. Native tar runs without a shell, inherited tar options, owner changes or administrator access, and only after the pinned digest succeeds. Entry names, file count, expanded byte budget, regular executable and internal symbolic links are checked. A private receipt records the verified release. Partial files are removed after cancellation/failure; a stage interrupted by a process crash is removed on the next explicit retry. Unrelated directories and existing runtime destinations are never replaced.

An explicitly installed private copy is used first; otherwise existing system Ollama is located as before. Starting it uses the existing loopback-only supervisor, filtered environment, startup preference and child cleanup. Cold startup has a cancellable 60-second deadline. No system application, login item, shell profile, shared model cache or global service is overwritten. Relay's data folder must still be protected as executable application state; a compromised operating-system account is outside this boundary.

## Verification commands

`npm test` includes installer lifecycle, integrity, redirects, access control, restart, stale-request and filesystem tests. The browser/native suites use the actual official archive and real local inference, with explicit isolated data folders and an existing model cache. The combined-flow pull test uses an isolated copy of cached blobs with no model manifest, then calls the real Ollama registry pull and performs inference. Cached blobs avoid downloading another set of model weights; registry metadata is fetched normally.

Set `RELAY_OLLAMA_TEST_ARCHIVE` to the pinned `.tgz`, `RELAY_LOCAL_MODEL_TEST_MODELS` to an isolated existing cache and `RELAY_LOCAL_MODEL_TEST_ID` to its model tag, then run:

- `npm run models:quick:test:ui`: single-action desktop/phone setup, installer cancellation/retry, client reload, cached-model reuse, draft return and actual inference.
- `npm run models:quick:test:pull`: the same journey with a real Ollama registry pull using an isolated cache.
- `npm run models:quick:test:ios`: native iPhone Simulator progress after relaunch, cancellation, one-action continuation and actual inference.
- `node scripts/test-local-model-quick-mac.mjs`: packaged Mac’s own backend, official HTTPS private install, one-action setup of the default Qwen 4B, inference and full quit/relaunch.
- `node scripts/test-local-model-quick-layout.mjs`: production suggestion, 320/390/1365-pixel layout, accessibility and manual choices without starting any installation.
- `npm run models:install:test:ui`: desktop and phone layouts, cancellation/retry, leave/reload recovery, draft return and real inference.
- `npm run models:install:test:mac`: packaged Mac client against the isolated real runtime fixture.
- `npm run models:install:test:ios`: an independently created iPhone Simulator, protected HTTPS, native keyboard, cancellation/relaunch and real inference.
- `npm run models:install:test:live`: official HTTPS release delivery through the production downloader, plus the browser journey.
- `npm run models:install:test:local-mac`: the packaged Mac's own backend downloads the official release, uses its private executable, performs inference, quits and reopens. Because the host already has system Ollama, this test explicitly invokes the owner install API; empty-machine UI is covered separately.

Completed runs and receipts are in VERIFICATION.md. Native iPhone tests exercise a Mac server; they do not install or execute Ollama on iOS. The UI remains usable against older servers without this capability.

## Remaining scope

In-app installation currently supports macOS only, with actual execution acceptance on arm64. The archive includes Intel code, but Intel execution is not certified here. Linux/Windows installation, LM Studio installation, automatic runtime updates, runtime removal and OS-signed Relay distribution remain open. Linux/Windows users can follow [Ollama's official installation documentation](https://docs.ollama.com/quickstart) and connect an existing service. Physical devices and Android runtime acceptance remain separate gates. This change is one step toward simpler self-hosted setup, not complete Muse/Grok feature parity.
