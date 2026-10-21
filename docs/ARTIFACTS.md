# Results you can keep

Ask a connected model to make a document, spreadsheet, slide deck, or interactive page. Its result card opens a separate page. Preview, edit, choose a saved version, or download the file there. Navigation and editing do not add messages to your chat. **Files → New result** also lets you create one yourself without a model. This feature requires the Relay server; the static sample does not pretend to generate Office files.

The reading view keeps **Download / Save file** and **Ask about this** together, with a 44-pixel edit pencil beside the title. **Back to chat** and **All files** share one navigation row. A version selector appears only when another saved version exists; one-sheet and one-slide previews do not display selectors that cannot change anything. The sheet name remains readable, and editing still exposes sheet/slide creation controls.

An unsaved edit is labeled **Draft**. Download and Ask are hidden while editing or previewing unsaved changes, so those actions cannot accidentally use the older saved bytes. Save a new version or discard the edits to restore them. Drafts survive reloads and older versions remain accessible. Results arriving after navigation initialize from their saved content when it becomes available instead of keeping an empty editor.

| Result           | Editing and download                                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document         | Markdown editor; DOCX with headings, paragraphs, emphasis, links, lists, code and tables. Images are recorded as references, not fetched or embedded. |
| Spreadsheet      | Editable cells and multiple sheets; actual XLSX with typed values, cached calculation results and a frozen first row.                                 |
| Slide deck       | Slide titles, bullet points and speaker notes; editable PPTX with a restrained Relay layout.                                                          |
| Interactive page | Self-contained HTML/CSS/JavaScript source; interactive web/Mac preview, a separate native-mobile preview, stop/restart, and HTML download.            |

The preview is a readable view of the same source, not a pixel-exact Office renderer. Uploaded DOCX/XLSX/PPTX files now have readable text previews and a paginated model reader. Ask the assistant to revise their content into a new result while retaining the original. Original-layout editing and full Office rendering are not implemented; see [Office source files](OFFICE_FILES.md). The document renderer supports the listed Markdown structures, not every Markdown extension. Slide generation currently supports text and notes, not charts, photos, arbitrary layouts or video. No publication or public sharing is performed.

## Spreadsheets

Type a formula starting with `=`. Supported expressions use numeric same-sheet references (including `$A$1`), `+ - * / ^`, parentheses, and `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, `ROUND`. Ranges such as `B2:B10` work inside aggregate functions. Cycles, division by zero, non-finite results, unsupported functions, cross-sheet references and external connections are rejected before a save. This is a bounded calculator, not the complete Excel formula language. Exported formulas retain their calculated values and request recalculation on opening.

To keep a number or leading `=` as plain text, start with an apostrophe. A literal string remains a string in XLSX. Range aggregates ignore nonnumeric cells; standalone formula arithmetic requires numeric cells. Empty references evaluate as zero. Calculations use JavaScript floating point rather than financial decimal arithmetic.

Model source example:

```json
{
  "sheets": [
    {
      "name": "Budget",
      "rows": [
        ["Item", "Cost"],
        ["Train", 25],
        ["Tea", 8],
        ["Total", { "formula": "SUM(B2:B3)" }]
      ]
    }
  ]
}
```

Presentation source example:

```json
{
  "slides": [
    {
      "title": "A slower Saturday",
      "bullets": ["Walk by the river", "Bring a book"],
      "notes": "Leave the afternoon free."
    }
  ]
}
```

## Versions and storage

### Completion requires a saved result

For recognized direct English or Chinese requests to create a Word document, spreadsheet, slide deck or interactive page, Relay checks for a real result from the current request before publishing completion text. An older file, another request’s result, a missing export or a filename in prose does not satisfy this check. A successful artifact save, an actual computer export, or a completed specialist handoff with a bound file receipt can supply the result. Earlier continuations of the same request and assistant are recognized without recreating their files. Required questions still stop normally, and a follow-up can replace the file request with ordinary chat.

If the model stops before saving, Relay gives it one private correction and continues the same request. The correction and tool history survive restart. If no result is saved after that correction, chat shows an honest inline failure with the existing **Try again** action. It does not display the unbacked completion claim or create a pretend file. Retry preserves the draft and original request. Models explicitly detected as chat-only receive a capability error for these action requests.

This is deliberately a conservative direct-request check, not a general intent classifier or semantic proof of file contents. Advice, how-to questions, code examples, generic chat drafts, quoted instructions and explicitly selected app workflows keep their existing paths. Complex wording and other languages still depend on model behavior. Content, calculations, page counts and revision fidelity need their own verification.

`npm run artifacts:test:completion` exercises a controlled model failure, automatic correction, inline error, reload, explicit retry and working interactive result through the actual worker/API in desktop and phone-browser views. Add `-- --mac` for the packaged Mac connected to the isolated test backend. These checks are separate from live-model, bundled-backend and native-mobile acceptance.

### Model input and content checks

The `save_artifact` tool accepts direct Markdown/HTML source, structured `sheets`/`slides` arrays, and a `csv` shortcut for a single spreadsheet. The shortcut supports quoted commas, line breaks and escaped quotes. Numeric values become numbers; a leading `=` becomes a bounded formula; a leading apostrophe keeps text literal. Leading-zero codes and identifiers over 15 digits remain text. CSV trims outer cell whitespace and ignores entirely empty rows; use structured rows when those distinctions matter. `sheetName` optionally names the CSV sheet. Supplying competing formats is an error instead of silently choosing one. Existing JSON-string sources, stored revisions and the HTTP editor contract remain compatible.

Successful model saves return a bounded content check beside the bound owner request (up to 6,000 characters, with truncation marked). Unrelated chats and assistant-authored messages cannot supply that request. Spreadsheet feedback distinguishes actual editable formulas and their computed values from text starting with `=`, and warns about uneven rows without changing the cells. It includes at most three sheets, eight rows/columns, eight formula details per sheet and 96 characters per text cell, with omitted/truncated content identified. Slide feedback shows counts/titles/note presence. Documents return a 1,200-character source excerpt; interactive pages return up to 12,000 characters so normal event handlers remain visible. HTML generation and review describe the actual opaque-origin preview: no network, external resources or persistent browser storage; use in-memory state and accessible names for the requested controls. The model is asked to preserve supplied identifiers, dates, times, amounts and units unless the owner requests a transformation, and to revise mismatches before reporting completion. This helps the model inspect its work; it is not a semantic validator or a guarantee that a model will correct a mistake. Malformed arguments include a format-specific retry hint. Relay's workspace files need no Google connection, and unavailable command terminals are omitted from the tool list and cannot create unusable review cards. Supported file creation uses the built-in renderer directly.

Before saving an interactive result, Relay parses its HTML and syntax-checks inline classic scripts plus common inline event handlers. A syntax failure returns a repair error without creating a file or changing a previous revision. Checks are capped at 200,000 source characters and 256 checked script/handler bodies. Comments, text areas, data-script bodies, external sources and `nomodule` bodies are not executed or compiled; module scripts are counted as unchecked. A replay of an older saved result can report a failed syntax check without deleting or modifying that file. The normal model tool loop can correct the source and retry.

The checker uses [htmlparser2’s parser callbacks](https://github.com/fb55/htmlparser2#usage) and [Node’s compilation APIs](https://nodejs.org/api/vm.html#new-vmscriptcode-options); it never runs generated code, imports modules, opens a browser or grants a VM context. Syntax success does not verify browser APIs, storage, CSS, event behavior or semantic correctness. The isolated browser preview remains the execution boundary; runtime acceptance must still click the actual controls.

For a small revision, the model can supply `edits: [{find, replace}]` with the existing result ID and version read. Relay applies 1–20 exact replacements against that immutable source. Each match must occur once; missing/ambiguous text, conflicting full-source inputs, malformed results and stale versions fail without saving partial work. Other source text and older exports remain unchanged. A full rewrite still uses the complete source. Recent Main and side-chat context includes its own saved file/task references, separately from assistant prose, so follow-ups can locate results without asking the owner to paste IDs.

Model saves with an existing same-kind title must use the existing result ID and current version. The check runs again inside the save transaction so concurrent creates cannot bypass it. Case and Unicode presentation differences do not create separate names. File reads return the exact revision ID, source version, kind and title; the expected version is the version read, not the next version. A requested separate copy needs a distinct title; the owner's explicit **New result** editor retains its current behavior. Replaying a successful operation still returns its original result, and no existing content is silently replaced.

Run `npm run artifacts:test:live` with `RELAY_ARTIFACT_TEST_MODEL` and `RELAY_LOCAL_MODEL_TEST_MODELS` pointing to an already installed model and an isolated test weight folder. It sends ordinary requests through desktop/phone chat, opens the actual result cards, reads back exported Office bytes, exercises generated JavaScript and revises an existing document. No artifact or model response is injected. `RELAY_ARTIFACT_REPLY_MODE=default` tests the existing Model default setting; omission uses the normal new-connection preference. The harness records failures as well as a complete passing receipt. Synthetic-only transport diagnostics retain raw responses, finish reasons and token usage to distinguish adapter defects from model mistakes. Revisions must preserve the entire source except the requested replacement, and normal replies must not echo internal result IDs. Add `-- --revision` for the narrower document-and-revision check; its receipt explicitly identifies those two scenarios and is not evidence that the full workflow passed. Add `-- --mac` to use the packaged Mac client connected to the isolated backend alongside the phone browser. That mode uses Electron’s actual download, automating only the destination path. It does not test physical mobile devices or the Mac bundled backend’s local-model setup. Live-model quality remains bounded by the chosen model and tested requests; see VERIFICATION.md.

Every save creates an immutable source revision and a separate downloadable file in SQLite. The previous bytes remain unchanged. Chat cards open the version delivered in that message; Files shows the latest version. A revision requires the version number it started from; two concurrent edits cannot silently overwrite each other. An open editor stays pinned to its original revision when another client saves. Unsaved edits are kept in that browser tab's session storage and survive reloads; they are not synchronized to another device.

Save operation IDs make identical retries idempotent. Model tool IDs include the run, round and tool position. The server validates and generates before a transaction, then checks the run guard and version again before committing. The `read_artifact` tool pages long sources in 12,000-character chunks pinned to a saved version. It accepts either the artifact ID or the exact file ID delivered in a result card. A file ID resolves only to its bound saved version, never silently to the latest version; a conflicting version or mismatched file binding is rejected. The returned revision target supplies the canonical artifact ID and expected version for editing. Models must retrieve every chunk before revising. This protocol supports careful revisions; it does not certify a model's interpretation or editing quality.

**Manage result → Remove result** removes all versions and their files with an inline confirmation. Active tasks block removal. Already prepared email reviews keep their frozen attachment copy. Recent removal records prevent replaying the last 1,000 removed save operations. Deleting older records beyond that retention window is not an indefinite replay guarantee.

Limits: 200,000 source characters, 2 MB per export, 50 results, 20 versions per result, and 12 MB for generated source/export state per workspace. Spreadsheets allow 10 sheets, 200 rows, 50 columns and 10,000 cells total. Decks allow 30 slides, six 180-character bullets per slide and 4,000 characters of notes. Split larger work into smaller results; removing a result frees its quota.

## Interactive preview boundary

The mobile result page keeps an empty sandbox permission set inside the main app. **Open interactive preview** presents a separate native screen with Back, Stop and Restart. Its plain WKWebView (iOS) or WebView (Android) never receives a Capacitor bridge or app URL handler. Generated content still runs inside an opaque frame. iOS uses a nonpersistent website store and a WebKit rule blocking HTTP(S) resources. Android disables file/content access, local storage and network loading, intercepts resource requests and rejects navigation. Both reject popups, media permission requests and script dialogs. Stop removes the web view; Restart creates a fresh one. Older native builds report that an app update is needed. See the dated verification record for tested platforms; source availability alone is not a device pass.

Generated code never executes in the Relay Node server. It runs in an iframe with only `allow-scripts`: no same-origin grant, forms, popups, downloads, or top navigation. A policy placed before generated markup blocks network fetches, external images/fonts/scripts, nested frames, objects, forms and base URL changes. The parent page restricts frames to its own origin so a preview cannot navigate to an external document to discard its content policy. Browser tests exercise these boundaries against two local origins.

This is a browser content boundary, not an operating-system sandbox or comprehensive network firewall. It does not promise isolation from CPU exhaustion, every browser networking feature, or browser vulnerabilities. Keep previews self-contained and use Stop preview to unload them. Downloads include the content policy, but opening a downloaded file in another application is outside the in-app iframe boundary. No credentials, native bridge, host filesystem or connected-account access is supplied to generated content.

## Independent implementation and verification

The product pattern comes from [Muse's rich outputs](https://introducing.muse.ai/) and [Grok Bot's files and results](https://docs.x.ai/grok-bot/files-and-results). Relay's schemas, renderer integration, version store, chat cards, page and tests are independently implemented. The general-purpose `docx`, `exceljs` and `pptxgenjs` dependencies are MIT licensed; their dependencies retain their own licenses and notices. Competitor source and artwork are not product dependencies.

Run `npm test`, `npm run build`, then `npm run artifacts:test:ui`. Add `-- --mac` to exercise the packaged Mac client against the isolated production backend, including real downloads with only the OS destination choice automated. `RELAY_EVIDENCE_DIR` can keep a run’s receipts and captures in a separate folder. The browser acceptance harness uses a controlled provider and real worker/tools/storage/export code, not a live hosted-model account. Actual iPhone Simulator UI acceptance now verifies all four generated formats through the system Files picker, including exact saved bytes, cancellation, interactive preview and relaunch. Browser phone checks alone do not establish native behavior; physical iOS devices and Android exports remain unverified. Native preview/save commands and delivery limits are in [mobile results](MOBILE_RESULTS.md). See [the verification record](VERIFICATION.md) for completed runs and remaining delivery gaps.

A direct “update that same Word document” request with one preceding result in the current chat now requires a saved revision of that result before reporting completion. The equivalent supported spreadsheet, slide-deck and web nouns use the same check. Reading it or saving another document cannot satisfy the check. One recovery attempt asks the model to perform the missing edit; repeated false completion fails explicitly. Voice requests expose both read and save schemas immediately for this bound revision. The recognizer is deliberately narrow: quotes, explanations, examples, ambiguous results and other chats do not choose an edit target. It checks identity, current-request provenance and a new version, not arbitrary semantic correctness of the edit.

## Referring to the result being revised

For a recognized “update that same Word document” request with one preceding generated result, the assistant may use `id: "current"` in `read_artifact` and `save_artifact`. Relay resolves it from this owner request and conversation. It is not a workspace-wide latest-file shortcut or a fuzzy ID match. Normal artifact and file IDs keep their existing behavior. The request's tool definitions advertise this reference only when the existing revision recognizer establishes one target.

Reading `current` without a version returns the latest saved source. Its `revisionTarget` retains `id: "current"`, kind, title and the actual `expectedVersion`. An explicit read version pins pagination to that saved source; a file ID still refers only to its own saved version. Saving uses the existing exact-edit or full-source protocol, version checks, immutable prior exports and durable operation identity. A newer owner edit rejects a stale save. The server resolves the reference again before committing an export and rejects a changed or removed target. A shortened internal ID fails with a hint to the bound reference; it is never silently repaired into an identifier.

Quoted or ambiguous requests, missing preceding results, unrelated conversations, an unbound run/source and selected-app workflows cannot use this shortcut. They retain ordinary discovery and exact IDs. The reference removes fragile copying from a supported conversational flow; it does not expand the recognizer to arbitrary language, infer editing intent from document contents, or certify the model's requested text changes.

`tests/artifact-reference.test.mjs` covers exact same-result edits, all four result types, preserved old-version pagination, stale-save rejection, changed requests during export, missing/shortened targets, scoped tool descriptions, typed and voice execution, and a SQLite checkpoint reopen without another save. `scripts/test-artifact-reference-live.mjs --mac` uses an actual local model and packaged Mac renderer to create a Word file and revise it twice. Every revision must preserve the same result identity and change only the requested text in Word XML. Successful tool receipts must also prove that the model exercised the short reference for reading and saving. Synthetic text represents recognized speech; it does not test audio input or output.

The actual Qwen 3.5 9B Quick Mac run in `../relay-evidence/artifact-reference/live-9b-final/acceptance.json` passes creation and two consecutive revisions. Both saved versions retain the original result identity and exact Word XML except for the requested replacement. Recorded successful tool receipts prove reads and saves through `current`; the normal exact-ID route also remains supported. The three model-driven steps took 15.3, 20.3 and 14.3 seconds in this observation, not a controlled latency benchmark.

The earlier `artifact-reference/live-9b` run passed all three content checks but failed an overly strict harness assertion requiring every save to use the shortcut. One valid revision used its full artifact ID after correcting an omitted target. The harness now requires successful short-reference read/save receipts while preserving all semantic assertions and allowing the supported ordinary-ID path. That failed harness receipt remains available. The earlier broader 9B failures from `voice-fast-model` remain unresolved model-quality evidence; this targeted pass does not certify general assistant reliability.
