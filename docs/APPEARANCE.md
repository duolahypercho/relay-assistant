# Assistant appearance

Open the conversation header, then **Personalize**. The current assistant's profile opens on its own page. **Settings → Change character** opens Main's profile. Any existing unfinished profile draft is kept. There is no new chat message or extra image dialog.

Choose Relay's original anime Sprout or an independently drawn Pebble, Puff or Star character. Color changes the shape and the assistant accent. Tap the large preview to greet it. Save the profile to use its appearance in the conversation header, empty-chat greeting, profile list and sidebar. Each specialist keeps its own look; the default Sprout retains its small initial marker. The normal message bubbles remain uncluttered.

## Your own picture

**Choose picture** accepts PNG, JPEG and WebP up to 10 MB and 24 megapixels. It centers a square crop immediately. **Adjust picture** reveals zoom and horizontal/vertical positioning; these are optional. The cropped preview is the picture that will be saved. Selecting a character replaces the picture; choosing Sprout restores the original character. Invalid uploads leave the current choice intact.

Cropping happens in the client. The original file and its filename are not uploaded. The app renders the crop to a PNG up to 256 × 256, reducing dimensions to meet the 128 KB bound. Shared validation checks PNG structure, checksums, dimensions, decompression length and scanline filters. It strips ancillary metadata and rejects foreign critical chunks, invalid pixel data and trailing bytes. SVG and remote image URLs are not accepted as saved appearances. Uploaded pictures are saved as static pixels. The server persists only the normalized image with the owner's profile, protected by the existing workspace authentication. The profile image is not included in the model prompt or role snapshot.

The saved profile draft includes the cropped picture and survives reload. Reload does not retain the original full-size file or its crop controls; choose the file again to recrop. Concurrent saves use the existing profile revision guard. A duplicate receives an independent appearance value. The workspace export contains the saved picture.

## Create with AI

**Personalize → Create with AI** opens an inline editor. Connect an image service once, choose **Anime**, **Soft toy** or **Simple**, describe the character and generate one preview. The finished preview scrolls into view and focuses **Use this picture**. Using it updates the profile draft; **Save profile** applies it. Discard, failed requests and cancellation retain the current character. The existing characters and local picture upload need no image service.

Connection details are collapsed after setup. Open **Image service** to change, turn off, reuse or forget the saved connection. OpenAI and xAI presets provide editable defaults; a compatible custom/local service can be entered directly. GPT Image requests use `size: 1024x1024`, `output_format: png` and `quality: medium`; the general Images API format requests `response_format: b64_json`. Both use `POST /images/generations` and `n: 1`. Other image API protocols are not supported. The optional server environment uses `RELAY_IMAGE_BASE_URL`, `RELAY_IMAGE_MODEL`, `RELAY_IMAGE_API_KEY` and `RELAY_IMAGE_FORMAT` (`gpt-image` or `base64`).

Only the owner-entered description, selected style and a fixed avatar-composition instruction are sent. Chat, memories, profile instructions and existing pictures are excluded. Generation may incur provider charges; the destination and charge notice are beside Generate. The service has its own encrypted connection and never borrows chat credentials. Keys are reused only for the same saved endpoint and format, never returned to the UI, exported with a workspace or included in an assistant template. A changed settings revision requires reload before generation.

Requests require the existing owner authentication and same-origin write checks. One generation may run at a time, with a three-minute timeout and no automatic retry or fallback. Stop and closing the generator cancel the Relay request; a remote service can still finish and charge for work already accepted. Provider errors remain inline, including upstream HTTP 401. Relay accepts one bounded base64 PNG/JPEG/WebP result and never follows a returned image URL. Server checks limit response bytes, type and dimensions; the client decodes and normalizes the chosen image through the existing crop pipeline. Full results are transient, while the saved normalized picture follows the ordinary profile rules. Navigation and generation add no chat messages.

## Motion and sharing

The chosen look uses the existing companion lane, greeting, dragging, keyboard movement, activity states and pause control. Shape characters blink and respond to activity; reduced-motion preferences disable their animation. Uploaded pictures move and tilt as a whole and do not acquire facial animation. The original anime Sprout retains its authored frame animations.

Template format version 2 includes appearance configuration or normalized PNG pixels. The sharing editor shows the exact picture and lets the owner replace it with Sprout before review. Public previews load picture bytes through the same link-access and revocation checks; no third-party image host is contacted. Older version 1 templates remain importable with the default character. Older Relay installations need an update to import version 2. Shared link revisions are separate from the template-format version. Public sharing includes the visible picture; metadata stripping cannot remove private information visible in its pixels.

Generated and uploaded pictures move as a whole. Animated user-uploaded rigs/sprite sheets and a larger authored anime character library are still open. Live image-provider output quality has not been verified.

## References and verification

[Grok Bot's design article](https://x.ai/news/designing-grok-bot) informed recognizable avatars and state through motion. Its [profile and duplication documentation](https://docs.x.ai/grok-bot/bots) informed keeping identity with a copied assistant. The original Relay artwork and these character drawings are our own assets/code; no reference artwork was incorporated.

`tests/appearance.test.mjs` covers schema/image limits, metadata stripping, malformed/decompression-bomb images, Main/specialist persistence, independent copies, stale edits, model-context exclusion, versioned template portability and authenticated/revoked picture routes. `scripts/test-appearance-ui.mjs` covers the editor, cropping, reload, avatar placement, model request exclusion, sharing and importing, stale review, dark/light accessibility and reduced motion using fictional pictures and a controlled HTTP model. Native file-picker interaction, physical phones and AI image-provider quality are not established by browser tests.

`tests/image-connections.test.mjs` adds nine cases for encrypted settings, credential boundaries, both request formats, input/output bounds, actual response limits, owner API protection, stale revisions, cancellation, timeout and no automatic retry. `npm run appearance:generate:test:ui` exercises production desktop/phone UI with an actual local HTTP image service. `npm run appearance:generate:test:mac` repeats it in the existing packaged Mac remote client. The synthetic fixture is an intentionally simple image for checking crop and metadata handling, not a generated-art quality sample. No live provider account or physical phone is used; the Mac bundle is not rebuilt by these checks.

Protocol references: [OpenAI Images API](https://developers.openai.com/api/reference/resources/images/methods/generate) and [xAI image generation](https://docs.x.ai/developers/model-capabilities/images/generation). No provider code or reference artwork is copied into Relay.
