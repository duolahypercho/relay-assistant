# Android sharing framework tests

From the Relay root, with JDK 21 selected, run:

```sh
npm run mobile:sharing:test:android
```

This standalone Java Gradle project needs no Android SDK. It compiles the production importer and inbox against Robolectric's Android API 35 framework and runs a controlled content provider backed by temporary files. AndroidX test AAR class jars are extracted only for this JVM test runtime; none of these test dependencies enter the app.

These tests do **not** compile the Activity, Capacitor bridge, manifest or app resources, and do not replace an APK build or an Android share-sheet/WebView/device test. See [mobile sharing](../../../../docs/MOBILE_SHARING.md) for outstanding platform gates. The source app's actual URI permission lifetime and stalled-provider behavior require device acceptance.

The test setup follows [Robolectric's Java 17+ guidance](https://robolectric.org/getting-started/). Gradle, JUnit, Robolectric, Android framework and AndroidX test libraries remain third-party development dependencies; their source is not incorporated into Relay's independent product implementation.
