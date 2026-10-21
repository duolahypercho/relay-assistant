# Android app acceptance

The Android debug application now builds and has actual Android 16 ARM64 emulator acceptance for connection, system sharing, draft persistence, relaunch, multilingual offline recovery and a controlled voice-call lifecycle. The standalone source APK supplies fictional shared material. The receipts below distinguish completed native journeys from remaining hardware and release gates.

The current debug APK is `release/mobile/Relay-0.1.0-android-debug-005f1a301c4dc79e.apk`, SHA-256 `005f1a301c4dc79ec565208fd3f4b3d62b976bce85911a10493e1cf75d6114cb`. It passes nine checks in `../relay-evidence/ios-voice-current/android/android-voice-1792535761169.json`. The loading page now offers a visible Back to chat control before its module arrives. Tapping it returns the retained draft without reopening capture after the pending call is cancelled. All 48 web assets match the tested build, with no baked-in server URL. Ten native captures and nine synthetic recordings are retained. Physical audio and release-signing gates remain open.

The prior APK `release/mobile/Relay-0.1.0-android-debug-991d03eeddd8afde.apk`, SHA-256 `991d03eeddd8afdeea695efea25e291140568b781b1cec76841e5b9b50acacc7`, passes nine checks in `../relay-evidence/voice-navigation/android-final/android-voice-1792534446876.json`. It verifies stopping capture and pending work during a held destination load, using browser history to return. Its earlier startup timeout and native-driver installation timeout remain in sibling evidence directories; native instrumentation now starts before the short control deadlines.

The prior compact voice-history update passes eight checks in `../relay-evidence/voice-memo/android/android-voice-1792532522131.json`, including actual saved playback after full process relaunch. Its APK is `release/mobile/Relay-0.1.0-android-debug-7bbad8ec24aee764.apk`, SHA-256 `7bbad8ec24aee764771af1a5c2e0aaf45b9584f405aa85682c060caa72ed50f5`. Matching transcripts appear once, the replay row remains compact, and replay/pause preserves the draft without another model request. These checks also pass in the current journey.

## Voice timing and recovery — October 21, 2026

The earlier debug APK `release/mobile/Relay-0.1.0-android-debug-ed65336cdf0ffc04.apk` passes seven native voice checks, including rejected 180 ms noise during synthesis, retry after failed synthesis, in-flight correction, draft retention and full app relaunch. Its SHA-256 is `ed65336cdf0ffc04e4d44572f8f8af88018a8584c3e4e3ba50c0454d4d4f2c29`. All 48 bundled web files match that tested build, and the APK has no baked-in test server URL.

The receipt and seven captures are under `../relay-evidence/voice-resume/native-mobile/android-host-renderer`. The relaunch observer now waits for a new app process and selects its WebView by process ID; cached views from a terminated process cannot satisfy acceptance. The fixture schedules synthetic audio against the audio clock, avoiding wall-clock scheduling drift. An earlier run exposed inflated utterance timing in large capture callbacks; the production detector now receives frames of at most 20 ms.

The dedicated Google APIs Android 36 ARM64 device used `-gpu host`. The prior software-renderer run recorded Android graphics stalls and a genuine app-process startup timeout; that failed receipt remains under `android-framed`. This renderer change is an emulator configuration, not a product fix. No owner device or account was used. These checks validate actual WebView capture and playback with synthetic input and controlled providers, not physical acoustics, provider intelligence, Bluetooth or release signing.

## Local SDK setup

The test SDK lives at `work/toolchains/android-sdk` in the outer workspace. Use the existing JDK 21 there through `JAVA_HOME`; avoid global shell/profile changes. Create a new disposable AVD and leave any existing devices alone. Do not connect Google accounts or send model credentials into the test device.

Google's [SDK terms](https://developer.android.com/studio/terms), section 2.1, require agreement before use. The [download page](https://developer.android.com/studio#command-line-tools-only) also requires agreement before download. On October 15, 2026, the owner explicitly accepted: “I accept; install and test Android.” This authorizes the isolated SDK and dedicated emulator below. Use these stable packages:

| Package                                          | Purpose                                                                             |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Mac ARM command-line tools `15859902`            | SDK manager / AVD manager                                                           |
| `platforms;android-36`                           | Compile against the project's API level                                             |
| `build-tools;36.0.0`                             | Package/sign the development APK                                                    |
| `platform-tools`                                 | adb installation, test transport and captures                                       |
| `emulator` (stable channel 0)                    | Run the disposable test device                                                      |
| `system-images;android-36;default;arm64-v8a`     | AOSP Android 16 test system with no owner account                                   |
| `system-images;android-36;google_apis;arm64-v8a` | Additional Android 16 runtime for Google-provider WebView checks; no Google account |

The Mac ARM command-line archive published on October 11, 2026 is `commandlinetools-mac_arm64-15859902_latest.zip`, SHA-256 `835b62a26162b229b441d1f6d4680383815a270809eb33522c0d480fa5002c4e`. The original AOSP toolchain requires roughly 1.6 GB of compressed downloads; allow additional space for extraction and the AVD. Those packages reference `android-sdk-license`. The additional stable Google APIs image revision 7 is 1,872,691,175 bytes and references the Android SDK agreement under `android-sdk-arm-dbt-license`. No preview-channel package is needed.

Gradle also installed its default stable `build-tools;35.0.0` under the accepted SDK license. The exact installed versions are recorded in `../relay-evidence/android-sdk-packages.json`. `npx playwright install android` supplies the separate Playwright instrumentation APKs; these are test tools and are not bundled in Relay.

After setup:

```sh
npm run build
npx cap sync android
# Set JAVA_HOME and ANDROID_HOME to the approved local toolchain paths.
cd native/mobile/android
./gradlew -PrelayAndroidAcceptance :app:assembleDebug :share-source:assembleDebug --console=plain
# With a dedicated AVD named Relay-QA-<timestamp> booted:
# From the Relay project root, set RELAY_ANDROID_TEST_SERIAL to its emulator serial.
npm run mobile:android:test:app
npm run connection:language:test:android
npm run voice:test:android
```

## Acceptance requirements

1. Install and launch the actual APK on a fresh dedicated emulator. Verify Main, separate page navigation, native controls and viewport layout.
2. Connect to an isolated Relay server with fictional data. Verify a sent message and server-side persistence; keep owner data out of the test.
3. Deliver text, a photo and a document from a separate source app using the Android share contract and transient URI grants. Verify native import, original bytes and exactly one manual Send.
4. Verify retained drafts through page/chat navigation, app relaunch and receiving a second share. Verify cancellation and failure UI.
5. Exercise native preview/export, permissions and sharing-origin boundaries. HTTPS/authentication, push and live microphone/camera paths need their own actual platform checks.
6. In English, Simplified Chinese and Traditional Chinese, verify native connection labels, retained invalid text and rejection of browser-blocked ports. Navigate to an unavailable HTTPS origin on an allowed port, relaunch, and exercise native Try again, Change server, Cancel and Use sample. Confirm only the exact bundled error page exposes recovery and that ordinary subresource failures do not replace a working workspace. Capacitor’s Android error page has no plugin bridge; these controls deliberately live in native views.
7. Preserve APK hashes, source hashes, logs, native captures and a machine-readable receipt. Clean up only the dedicated test device and fixture data.

No gate is complete until its real run passes. The test sources or a successful JVM test cannot be substituted for these app-level checks. Physical devices and signed public distribution remain separate requirements.

## WebView reload diagnostics

The conversational-reminder journey exposed a native crash in the AOSP Android 16 revision 2 image's WebView `133.0.6943.137`. Its `Chrome_IOThread` terminates on a Chromium dangling-pointer check during reload. The seven reminder operations had passed before the reload failed; that is a failed native journey. Repeated reloads of an initial Relay chat also reproduced the failure. Static HTML, a minimal EventSource page and a JavaScript-module chain passed their isolated probes, so these checks do not establish which integration triggers the engine defect.

The failed journey, native log and diagnostic probes are retained under `../relay-evidence/reminder-changes/android-webview133-failure`. Chromium documents that the [AOSP prebuilt WebView is not regularly updated](https://chromium.googlesource.com/chromium/src/+/HEAD/android_webview/docs/aosp-system-integration.md). Testing another official runtime does not certify the failing one. The reminder-change Android harness records its provider and system fingerprint, requires five reloads and a full process relaunch with the saved draft, and rejects native Relay crashes. It does not disable memory checks or replace the reload gate with a relaunch.

The Google APIs revision 7 image also supplies version `133.0.6943.137`, with package `com.google.android.webview`. Its first journey completed five reloads and relaunch without a native crash, but failed the JavaScript-error check: Capacitor's legacy native reply could arrive after the document's `window.Capacitor` was gone. That failed receipt is under `android-google-bridge-failure`; provider identity, not the version number alone, distinguishes these runs.

Android builds now run `scripts/patch-android-bridge.mjs` before compiling Capacitor. This small compatibility change guards the legacy reply when its document bridge no longer exists, preserving normal payload delivery. It checks the exact installed Capacitor `8.5.3` version and source line, is idempotent, and fails the build on unexpected dependency code. It changes no origin, permission, or native memory-check settings. Capacitor retains its MIT license in [third-party notices](../THIRD_PARTY_NOTICES.md). The callback tests cover absent and live bridges; the native journey keeps its JavaScript-error assertion. Its final receipt remains the authority for whether the patched APK passed.

The patched APK passes the complete reminder-change journey on the Google provider: seven operations, five reloads, process relaunch, retained draft, accessibility checks, no JavaScript errors and no native crashes. Retesting that identical APK on a fresh AOSP image still crashes in `Chrome_IOThread`; the guard does not fix that separate engine failure. `android/acceptance.json` records the Google-provider pass, and `android-aosp-after-guard/acceptance.json` plus its native log record the remaining failure. This release does not pass every tested Android runtime. Physical devices and current retail WebView releases still require their own acceptance.

## Prepared harness and present limits

`scripts/test-android-app.mjs` uses Playwright's Android driver for native controls and the actual app WebView. It does not inject a fake Capacitor bridge. It refuses physical devices and AVDs whose names do not match `Relay-QA-<timestamp>` before clearing any application data. It connects a fresh Relay HTTP/SQLite/model fixture through one adb reverse port and records screenshots, APK hashes, a pass/failure receipt and device logs. It removes only its own reverse mapping and temporary host workspace; the calling setup owns deletion of the disposable AVD.

The opt-in `:share-source` Gradle module is a separate debug-only APK with its own UID, private content provider and fixed fictional PNG/text file. A real Android chooser grants those URIs to Relay. It is included only with `-PrelayAndroidAcceptance` and cannot produce a release variant. It is never a product dependency.

The app's Debug manifest permits HTTP only to `127.0.0.1`, `localhost` and `::1`, matching the existing development-only address validator. Remote HTTP remains denied and Release receives no exception. This enables a controlled local fixture without adding a production trust bypass. HTTPS authentication still needs separate native acceptance.

The completed native receipts below cover the SDK build, system chooser, URI grants, connection forms, lifecycle and WebView behavior. Their scope remains narrower than physical-device and distribution acceptance.

## Connection parser and locale helper

The dependency-free Java helper can run with an existing JDK, without an Android SDK or emulator. It checks locale selection and address rules only:

```sh
# Run from the Relay project root; JAVA_HOME points to an existing JDK.
connection_classes=$(mktemp -d)
"$JAVA_HOME/bin/javac" -d "$connection_classes" \
  native/mobile/android/app/src/main/java/org/relay/assistant/ConnectionLocale.java \
  native/mobile/android/app/src/main/java/org/relay/assistant/ServerAddress.java \
  native/mobile/android/tests/ConnectionLocaleTest.java
"$JAVA_HOME/bin/java" -cp "$connection_classes" org.relay.assistant.ConnectionLocaleTest
```

A passing helper does not compile or verify `MainActivity` or `ConnectionRecoveryView`.

## Assistant-template URL parser

The dependency-free `TemplateLink` and its existing `ServerAddress` dependency also run with the same JDK:

```sh
template_classes=$(mktemp -d)
"$JAVA_HOME/bin/javac" -d "$template_classes" \
  native/mobile/android/app/src/main/java/org/relay/assistant/ServerAddress.java \
  native/mobile/android/app/src/main/java/org/relay/assistant/TemplateLink.java \
  native/mobile/android/tests/TemplateLinkTest.java
"$JAVA_HOME/bin/java" -cp "$template_classes" org.relay.assistant.TemplateLinkTest
```

These checks cover HTTPS, debug-only HTTP loopback, bounded source paths, credentials, fragments, duplicate/extra parameters, blocked ports and malformed scheme links. The manifest, pending-intent storage and WebView review bridge are implemented in source; this helper does not compile or certify their Android runtime behavior. The SDK license was accepted as recorded above; native template-link acceptance remains a separate gate.

## Completed native checks — October 15, 2026

- `android-app-1792004132935.json`: actual debug APK and separate source app, Android system chooser, transient content URI grants, original photo/document bytes, text sharing, one manual Send, page navigation, full process relaunch, side-chat selection, Main draft retention, embedded-WebView accessibility and no horizontal overflow.
- `android-connection-1792004686760.json`: English, Simplified Chinese and Traditional Chinese native forms; rejected insecure addresses and blocked ports retain text inline; failed subresources leave the workspace usable; unavailable HTTPS opens the exact bundled error page with native Retry and Change server controls; relaunch, Cancel, Use sample and reconnection preserve server drafts without chat or model activity.

- `android-voice-1792005310303.json`: actual Android WebView capture and 16 kHz WAV segmentation from an explicitly synthetic microphone, controlled HTTP transcription/chat/speech, playback, spoken/button interruption, mute, identical-audio retry, End cleanup and full app relaunch with a retained draft. Three model turns, three spoken replies and one failed/retried transcription are checked. Hardware acoustics and real-model task quality remain separate gates.

Invalid addresses now use an accessible inline message instead of an EditText error popup that covered the form buttons. The native launcher and Android splash use an original vector sprout mark. Test-only instrumentation handles Activity recreation by selecting the live WebView page, polls native observations because the current Playwright Android protocol omits inner selector deadlines, and terminates its owned instrumentation transport during cleanup.

These runs use a dedicated AOSP emulator, local synthetic servers and a controlled model. They do not certify physical devices, real account login/public TLS joining, push, camera/microphone hardware, all file export paths, release signing or Play Store distribution. A debug APK is a development artifact. The broader JARVIS-style goal remains active.

## Voice correction and cross-device continuation

`android-voice-1792014815949.json` verifies the current development APK (SHA-256 `e2ef61fea76146a9409972e91bfd00322f3189fde26c2a7940507851c38ad44c`). It repeats the full controlled audio lifecycle and adds a second call that redirects an in-flight model request. Both spoken messages belong to the same run; only the corrected reply is spoken. All five device screenshots contain actual drawn content and were visually inspected.

The real-model computer journey uses `scripts/voice-result-android.mjs` to connect this APK to an independent server, preview the corrected Markdown file, compare authenticated bytes and save an unsent draft. The desktop then consumes that draft in the same conversation. This helper certifies emulator preview and transfer, not a physical phone or native file export. The integrated voice/computer receipt records the model and final desktop continuation separately.
