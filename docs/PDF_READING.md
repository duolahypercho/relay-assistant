# Reading PDF documents

Attach a PDF and ask about it, or open an existing PDF and choose **Ask about this**. There is no new setup page. Page navigation and zoom remain in the file preview; the preview now supports keyboard scrolling. Viewing a document never sends it to a model. Explicit Send starts the assistant request.

The assistant's `read_file` extracts PDF text with page headings, page references, existing AcroForm field names/types and supported saved values. Long text uses the existing `offset`/`nextOffset` and `contentHash` convention. A changed document invalidates the cursor. Pages with no extractable text are identified rather than silently treated as blank content.

For a scan, table, diagram or visual layout, `read_pdf_page` renders one numbered page and supplies its image to the configured model, alongside any extractable text. It requires the hash from the document read. The model must support images. This is visual model input, not a built-in OCR engine or a guarantee of transcription accuracy. Answers should cite inspected page numbers and disclose unreadable content. Multiple page images requested together are delivered together after their tool replies, within a 12-million-character image budget; an omitted image is explicitly reported for a separate request. The assistant does not modify the original or save extra page-image files. Reading several parts of the same document leaves one file card in the reply.

Editable PDF forms can now be filled directly from supplied chat details and returned as a separate copy; see [PDF forms](PDF_FORMS.md). The existing task-based flow remains available. Text extraction does not make a scanned form editable, preserve arbitrary signatures, or implement XFA. Scripts, links and embedded files are not opened. Source text, form values and page pixels are untrusted content; they cannot grant permissions or approve actions.

## Implementation and bounds

An original reader uses the existing Apache-licensed PDF.js dependency and MIT-licensed native canvas renderer. Native canvas is now an explicit production dependency so packaged local servers include it. Existing pdf-lib provides the editable field catalog. No reference-product code or assets are incorporated.

Decoding runs in a disposable Node worker with a 192 MiB JavaScript heap limit, a 20-second deadline and at most two concurrent readers. Cancellation terminates the worker before freeing its slot. The limit does not constitute OS process isolation or a hard bound on native renderer allocations. Diagnostics are drained without logging source text. PDF.js uses bundled local fonts/character maps/WASM, disables evaluation/XFA, and receives bytes rather than a remote URL.

Limits are 8 MiB per input, 500 pages, one million extracted characters per document, and 200,000 per page. Each text response contains at most 12,000 characters and complete continuation metadata. The field catalog is limited to 100 fields/12,000 serialized characters with an explicit truncation flag. A page image has a maximum side of 1,600 pixels and at most 2 MiB of JPEG data. Images over 16 million source pixels are skipped by the decoder; warnings disclose this. Small text and unusual encodings/fonts can require a clearer source. Password-protected documents require an unlocked copy.

Four recently decoded text documents are cached by their exact source-byte hash in server memory. Page images are not cached. Lost execution authority, cancellation or a source change during decoding prevents delivery to the model. The bundled fictional permission PDF has deterministic timestamps so repeated reads/downloads retain the same bytes across restarts.

## Verification

- `node --test tests/pdf-reader.test.mjs`: actual text, accented characters, field values, pagination, scanned-page pixels, source hashes, malformed/encrypted/oversized/over-page-limit files, cancellation, source/authority races, inert JavaScript/external links, batched page images and duplicate file-card prevention.
- `npm run files:pdf:test:ui`: desktop/phone PDF preview and page controls, Ask about this, draft/reload, explicit Send, independent HTTP model → document text → scanned-page image, source preservation, accessibility and viewport fit.
- `npm run files:pdf:test:mac`: the same journey in packaged Electron against the isolated test server.
- `npm run files:pdf:test:local-mac`: the packaged local backend itself loads the PDF worker and native canvas from the app archive, sends decoded source text and real scan pixels to an independent model, and preserves the original upload.
- `npm run files:pdf:test:ios`: native WebKit HTTPS, PDF page controls, Ask about this, full relaunch, draft retention and the complete document/image model chain in a disposable iPhone Simulator.

See VERIFICATION.md for completed runs. Controlled model assertions validate the content and pixels transmitted, not a commercial model's reading accuracy. Physical devices, Android runtime, signed distribution, difficult multilingual/font samples, a general OCR service, arbitrary form editing and large-file parity remain open.

The feature closes the basic PDF-source gap identified against [Grok Bot's supported files](https://docs.x.ai/grok-bot/files-and-results) and [Muse's artifact-oriented conversation](https://introducing.muse.ai/). Decoder APIs were checked against [PDF.js documentation](https://mozilla.github.io/pdf.js/examples/) and its [Node rendering example](https://github.com/mozilla/pdf.js/blob/master/examples/node/pdf2png/pdf2png.mjs); our reader and workflow are independently implemented.
