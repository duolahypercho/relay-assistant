# Share into Relay

Share text, a link, a photo or a file from an iPhone/iPad app. Choose **Relay**, select Main or a side chat, then **Attach**. The extension keeps the items on the device. Open Relay: the share appears above that conversation’s composer. Your unfinished message stays intact. Add a message if you like and press **Send** when ready. Attaching alone starts no assistant work and adds no chat history.

Android’s incoming share target implements **text, links, photos and files**, including multiple files. It opens Relay and offers the conversation choice and Attach action inline; the existing draft stays in place. The importer is verified with Android framework tests on the JVM and the composer with a controlled bridge. An Android APK build and actual system-share/WebView journey remain unverified.

Remove a pending shared item with its × control. This detaches it from the composer; imported files remain in Files. Text and file shares survive app/server restart. A lost acknowledgement retries the same receipt and never adds the same share twice, including after it has already been sent or removed.

## Workspace and data handling

Open and connect Relay once before using the iOS extension. It caches only a workspace identifier, server label and up to 200 active top-level chat titles. The extension does not contain a model key, access key or cookie, and makes no network request. Its native Attach writes into the App Group inbox. iOS does not automatically open Relay from the extension; this implementation uses supported share-extension APIs and explicitly asks the owner to open the app.

The app imports into its current authenticated Relay server only when the workspace identifier matches. That identifier includes the server origin and Main chat’s creation time. A share destined for a different workspace waits on the device until that workspace is opened again. An archived/missing chat asks for a new destination. A previously imported receipt keeps its original destination. If Android receives a share before its selected server has a cached workspace, it binds that item only when a workspace on that same server is opened. A cached workspace on another server cannot capture it. An already-bound share retains its original workspace, including across resets on the same server. The owner still chooses Attach.

Shared text is stored as source material alongside the owner’s message. It cannot act as a slash command or as evidence for learned owner preferences. The model receives a clear source-material label. This is a provenance boundary, not a guarantee against every model-level prompt injection. URLs are passed as source text; the extension never fetches them.

Each share allows up to 12,000 UTF-16 code units and eight files, with an 8 MB combined file limit. Generic UIKit images are encoded as PNG (up to 40 megapixels before encoding); concrete image file representations retain their original bytes. The composer allows eight files in total and eight pending shares. The native inbox holds twelve waiting shares. Workspace receipts are retained to prevent replay; its 10,000-receipt limit fails explicitly instead of silently forgetting sent receipts. Imports validate the complete payload before saving any file.

## Native implementation and signing

`RelayShareStore.swift` is shared between the iOS app and its extension. It uses an App Group, a cross-process file lock, atomic writes and iOS file protection. Foundation’s typed URL loader decodes item providers, while temporary file bytes are copied inside their provider callback. The extension has a small native chat picker and Cancel/Attach actions. The app’s Capacitor bridge is restricted to the connected workspace’s main page; result-preview web views receive no sharing bridge.

For physical distribution, register a unique App Group identifier with your signing team and use that same identifier in both entitlements and `RelayShareStore.group`. The project’s development identifier is `group.org.relay.assistant.shared`. Both app and extension require the matching provisioning capability. Simulator ad-hoc signing does not establish physical-device or App Store readiness.

Android handles `ACTION_SEND` and `ACTION_SEND_MULTIPLE`. Its MIME filter allows any type because the importer accepts bounded opaque file attachments; an unrecognized/invalid MIME value becomes `application/octet-stream`. It reads `EXTRA_STREAM`, or `ClipData` when streams are absent, and deduplicates the same URI within an item. Only `content:` files are opened. Local paths, remote URLs used as file URIs, and Relay’s own providers are rejected. Shared text URLs remain text. Names, declared sizes and actual bytes are checked; files are neither converted nor executed. A failure saves none of that share.

The inbox lives under the app’s private no-backup directory. Metadata and writes use one process-wide lock; provider reads run outside that lock. A bounded serial worker keeps file/bridge IO off the UI thread. The selected server and cached workspace are frozen before provider reads. Writes are atomic and abandoned temporary files are removed on reopen. Consumed intents are cleared after being queued to prevent configuration changes from repeating them. A process killed before copying completes can lose that not-yet-saved share; share it again from its source. Once committed, the item survives restart until acknowledgement. No general storage permission, persistent URI permission or background service is added.

A cancellation signal is requested after 30 seconds and closes an opened descriptor; byte limits are always enforced. A source provider that ignores cancellation can still delay the single import worker. This behavior needs real-device/provider acceptance, alongside URI grant lifetime and large WebView bridge transfers. The bridge remains restricted to the selected server’s main workspace and rechecks its origin before returning data.

## Reproduce

```sh
npm run build
node --test tests/incoming-shares.test.mjs
npm run mobile:sharing:test:ui
# JDK 21; framework tests only, no Android SDK/application build:
npm run mobile:sharing:test:android
npx cap sync ios
xcodebuild test -project native/mobile/ios/App/App.xcodeproj -scheme App \
  -destination 'platform=iOS Simulator,id=YOUR_SIMULATOR_ID' \
  -parallel-testing-enabled NO CODE_SIGN_IDENTITY=-
RELAY_SHARE_TEST_DEVICE=YOUR_ISOLATED_SIMULATOR_ID npm run mobile:sharing:test:ios
```

Run Xcode builds sequentially when using the same DerivedData directory. The system-share acceptance script creates an isolated Relay HTTP server, SQLite database and controlled model, then launches the native UI test. A DEBUG-only source button supplies fictional text, a URL, a file and an image through the **actual system share sheet**. This proves that source-to-extension journey when passing; it does not certify every source app, a physical phone or Android’s runtime. The button is compiled out of Release and appears in Debug only with an explicit test launch argument.

The separate browser journeys control the Capacitor bridge and check both platform branches, draft retention, explicit send, errors/retry, wrong-workspace queues, archived targets and accessibility. Native unit tests exercise actual Foundation item providers and the durable inbox. The separate `native/mobile/android/share-tests` Java project compiles the production importer/inbox against Android framework classes and runs 22 Robolectric tests with real local test-provider streams. It needs a JDK but not an Android SDK. It does not compile MainActivity, the Capacitor plugin, resources or the manifest, and does not run the Android application. The portable Java text test remains available too. See [the verification record](VERIFICATION.md) for actual pass/failure evidence and remaining gates.

## References

Behavior was researched from [Grok Bot’s mobile guide](https://docs.x.ai/grok-bot/mobile), checked October 11, 2026. That guide currently documents Android text sharing only; Relay’s Android file support aims for consistency with its own iOS flow rather than claiming an existing Grok feature. The independent implementation uses Apple’s [shared app-group extension guidance](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/ExtensionScenarios.html), [extension activation rules](https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/AppExtensionKeys.html), [NSItemProvider](https://developer.apple.com/documentation/foundation/nsitemprovider), and Android’s [intent filters](https://developer.android.com/training/basics/intents/filters). The Android importer also follows [receiving shared data](https://developer.android.com/training/sharing/receive) and [content metadata](https://developer.android.com/training/secure-file-sharing/retrieve-info); framework verification follows [Robolectric setup](https://robolectric.org/getting-started/). No reference product’s code or art was copied.
