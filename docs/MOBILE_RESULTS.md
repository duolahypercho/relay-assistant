# Results on your phone

Open a saved result from chat or Files. **Save file** opens the system destination picker. Cancelling leaves the workspace unchanged. The app shows “File saved” only after native saving completes. This action supports generated files, ordinary workspace attachments and saved voice memos, up to 8 MB. It neither sends a message nor publishes the file.

Web results have **Open interactive preview**. The preview occupies its own native screen; Back returns to the exact result editor and draft. Stop unloads the page and Restart creates a fresh view. The static thumbnail in Relay's main web view keeps scripts disabled, including on older phone builds.

## Native implementation

`RelayResults` is a small, independently written Capacitor plugin. Its only public methods are `preview({title,source})` and `save({name,mime,base64})`. It does not expose a filesystem, arbitrary URL loading or account credentials.

- iOS saves bytes to a unique temporary directory, then presents [UIDocumentPickerViewController for export](<https://developer.apple.com/documentation/uikit/uidocumentpickerviewcontroller/init(forexporting:ascopy:)>). Completion and cancellation clean that directory. Loading the native plugin also removes abandoned UUID-named export directories after a force-quit. That cleanup skips ordinary files, unrelated directories and symbolic links, and does not touch the exported file in Files. The preview uses an empty user-content controller and [nonpersistent WKWebsiteDataStore](<https://developer.apple.com/documentation/webkit/wkwebsitedatastore/nonpersistent()>). No Capacitor script, native message handler or server session is installed there.
- Android uses [ACTION_CREATE_DOCUMENT](https://developer.android.com/training/data-storage/shared/documents-files) and writes to the single returned URI. It requests no general storage permission. Its preview is a newly allocated plain WebView, never Relay's bridge WebView. Generated content has an opaque origin, no device interface, file access, content access or network loading. The WebView's cookie infrastructure is shared by Android; this implementation relies on the opaque frame and blocked navigation/resources rather than claiming a separate incognito cookie store.
- Both platforms impose filename and byte limits, escape generated source into `srcdoc`, put restrictive policies before it, and retain an opaque sandbox without `allow-same-origin`. WebKit additionally installs a content-blocking rule; Android additionally intercepts resource requests. Neither is an operating-system sandbox or a promise against browser vulnerabilities or CPU exhaustion.

## Reproduce

```sh
npm run build
npm run mobile:results:test:ui
npx cap sync ios
npm run mobile:results:test:ios
npm run mobile:results:test:unit
```

The bridge-contract browser harness checks exact preview source and download bytes, saved/cancelled/error states, the busy button and unchanged chat history for both platform branches. Its bridge is controlled; it does not prove an OS file picker.

Use Xcode’s default DerivedData directory and simulator ad-hoc signing for tests. A project-relative DerivedData path with signing disabled repeatedly hung before the runner connected on this host. No physical-device signing identity is required for the simulator.

The seven iOS `RelayNativeTests/ResultsTests` cases exercise the production WebKit configuration and generated frame: real script interaction, denied parent/cookie/storage/bridge access, CSP/sandbox rejections and zero requests to a reachable local HTTP probe, stop/restart, byte/name/size boundaries and exact abandoned-directory cleanup. They also check canonical device connection links. The unit script creates and removes its own Simulator.

The separate native UI script connects the actual app to a protected HTTPS fixture, opens four original result cards, cancels one picker, and saves DOCX, XLSX, PPTX and HTML through the real Files picker. The harness compares every saved file's bytes with its original export in the isolated Simulator's file-provider storage. It checks the compact reading header and one-tap edit control, enters an unsaved draft, verifies that saving the old file is unavailable, and discards the edit before exporting the unchanged original. It also interacts with the native HTML preview, stops/restarts it, checks Back and the preserved draft, then closes the app during another picker and verifies orphan cleanup after relaunch. The source results use production render/storage code and original synthetic content; this is not a live-model quality test. iOS 26's remote picker sometimes omits or mislabels its buttons in the host accessibility tree; the UI test uses the captured sheet geometry for Save and the normal downward dismissal gesture for cancellation. Both test scripts remove their own test devices and retain result bundles/screenshots.

A Java-only test can run without an Android SDK:

```sh
mkdir -p /tmp/relay-results-java
javac -d /tmp/relay-results-java \
  native/mobile/android/app/src/main/java/org/relay/assistant/ResultContent.java \
  native/mobile/android/tests/ResultContentTest.java
java -cp /tmp/relay-results-java org.relay.assistant.ResultContentTest
```

That validates portable content/byte handling. Android compilation, WebView behavior and file picker interaction require the Android SDK and a device or emulator; Java-only checks cannot certify them. Consult [verification](VERIFICATION.md) for the actual latest run, including unfinished gates.

## Current local app bundle

The October 13 native build includes the abandoned-export cleanup. Its web assets and both mobile source projects are checked against the production build. Generated Office/HTML system-picker exports, interactive preview and relaunch now have actual iPhone Simulator evidence in `mobile-results-native-acceptance.json`; the seven native boundary cases have `mobile-results-native-unit.json`. Physical-device and Android system-picker acceptance remain open. The unsigned/distribution limitations above still apply; see [verification](VERIFICATION.md).
