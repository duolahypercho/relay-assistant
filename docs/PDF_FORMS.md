# Fill a PDF in chat

Attach an editable PDF, say what to fill, and send. Relay reads its exact field names and uses the details you supplied, then returns a **filled-** copy as an ordinary file card. Open it to review both the saved values and the rendered pages. The original stays in Files. No extra task form is needed when the message already contains the information; the assistant should ask only for genuinely missing details.

Text fields, checkboxes, radio groups, dropdowns and multiple-selection lists are supported. Unmentioned fields retain their values. Partial fills identify remaining required fields. The output stays an interactive PDF; it is not flattened. Creating the local copy does not send it anywhere. Email remains a separate reviewed action, and signing is not supported.

This requires a model that can use assistant tools. `read_file` supplies field names, types, options, existing values, read-only/required flags and the document hash. Protected field values are withheld. `fill_pdf_form` accepts named changes against that hash. Stale sources, cancellation or lost authority prevent publication. Repeated identical changes reuse the saved copy. Unsupported values fail before any file is added.

## Supported documents and limits

The independently implemented filler uses the existing MIT-licensed pdf-lib dependency. It checks the canonical AcroForm tree against page widgets, rejects ambiguous/orphaned widgets and verifies saved values and nonempty appearances after reopening the output. It does not attempt to repair broken forms. XFA is detected before pdf-lib can strip it. Signed or certified documents, password fields, read-only fields, scanned forms and forms without editable fields require another source or editor.

Text appearances use Helvetica. Characters outside that font's supported encoding fail explicitly; broad multilingual font preservation is not implemented. Dropdown/list option labels with unsupported glyphs can likewise require a different PDF. Forms are limited to 8 MiB, 500 pages and 200 fields; one call accepts up to 100 named changes and 20,000 characters. A disposable Node worker enforces a 20-second deadline, 192 MiB JavaScript heap and two concurrent fills. This is not OS process isolation or a hard native-memory bound.

## Verification

- `node --test tests/pdf-forms.test.mjs`: real PDF values, original preservation, required fields, malformed field trees, invalid options/types, unsupported fonts, signed/XFA/protected forms, duplicate saves, source races, cancellation and the complete agent tool chain.
- `npm run files:forms:test:ui`: desktop/phone chat to filled PDF, both rendered pages, exact download, accessibility, retained draft and clean navigation history.
- `npm run files:forms:test:mac`: the same journey in packaged Electron against an isolated real Relay server.
- `npm run files:forms:test:local-mac`: read/fill workers inside the packaged app’s own backend, exact saved fields, both rendered pages and a native download.
- `npm run files:forms:test:ios`: native iPhone Simulator HTTPS, send, rendered PDF page controls, separate-page navigation and full relaunch.
- `npm run files:forms:test:live`: set `RELAY_PDF_FORM_TEST_MODEL` and `RELAY_LOCAL_MODEL_TEST_MODELS` to an installed tool-capable Ollama model and a dedicated test cache. An isolated runtime uses actual model replies to fill the fictional form; no owner configuration is changed.

The controlled model fixtures verify the software path. Actual model-quality evidence and independent pypdf/Poppler checks are recorded in VERIFICATION.md. Physical phones, Android runtime, arbitrary form layouts/fonts and general model accuracy remain separate acceptance work.

The interaction takes inspiration from [Muse's document-oriented conversation](https://introducing.muse.ai/). The implementation follows [pdf-lib's form API](https://pdf-lib.js.org/docs/api/classes/pdfform); it uses no reference-product source or assets.
