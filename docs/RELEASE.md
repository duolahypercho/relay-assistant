# Release preparation

Relay's source archive is a development release of an independent MIT-licensed application. Creating it does not publish a repository, create a GitHub release, sign an app, or deploy a server.

## Source archive

Use Node.js 24 or later from the repository root:

```sh
npm ci
npm run release:source
```

The command prints the paths of a ZIP and its `.sha256` checksum under `release/source/`. The name includes the application version and a hash of the reviewed source tree. Existing artifacts are retained; a conflicting file is never replaced.

Extract the ZIP, enter its `Relay-<version>-source` folder, then run:

```sh
npm ci
npm test
npm run build
npm start
```

Open `http://127.0.0.1:4173`. The default sample workspace requires no account. A real assistant requires your selected model, and mobile devices connect to a reachable Relay server. See README.md for setup.

`source-files.json` contains the explicit, reviewable file list. Adding a file to the working directory or Git does not automatically add it to a release. Review and add a relative path when it belongs in the source distribution. The list includes web/server code, desktop/mobile projects, original assets, tests, lockfile, documentation and dependency notices. Build output, databases, local environment settings, signing credentials, IDE caches, generated mobile web bundles and captured test evidence are excluded. Symlinked files or parents, private-key material, unsafe paths and case-insensitive duplicates stop packaging. This is a bounded release check, not a general secret-scanning guarantee; review source changes before sharing.

The ZIP includes `SOURCE-MANIFEST.json`, with each included file's byte length, SHA-256 and executable mode. File order, timestamps and permission normalization are fixed. Identical source bytes and executable bits produce the same ZIP with the same locked toolchain; different Node/zlib versions are not certified as byte-identical. Checksums detect changes against a known receipt; they do not supply publisher authentication or app signing.

## Clean rebuild verification

```sh
npm run release:source:verify
```

This creates the archive, verifies every entry against the reviewed source, extracts to a new temporary directory and runs a fresh `npm ci`, formatting check, Node tests, production web build and source repack. It starts that rebuilt server on an ephemeral loopback port with its own disposable workspace, checks health, Main chat and exact web asset bytes, then verifies graceful shutdown. The repacked ZIP must match the original checksum exactly. No existing `node_modules`, Relay data directory, environment settings or native SDK are copied into the temporary checkout. Package downloads may use npm's ordinary integrity-checked cache. npm uses an empty user/global configuration for this check. Logs and `result.json` remain under `release/source/verification-<tree hash>/`; the temporary checkout is removed on completion or failure.

The verifier tests source completeness and the portable application build. Browser journeys, model quality, external services, computer isolation and native device behavior have separate acceptance scripts and records in VERIFICATION.md. The CI workflow also creates and retains a source archive after the existing checks; a local verification result does not imply that hosted CI has run.

## Desktop and mobile outputs

`npm run desktop:package` builds a desktop app under `release/desktop/` for the current build host. The current verified package is macOS arm64. It remains unsigned/unnotarized for distribution; other desktop platforms need their own runtime checks. See README.md for local development and lifecycle behavior.

`npm run mobile:sync` builds and copies the web app into both native source projects. Open iOS with `npm run mobile:ios`, or Android with `npm run mobile:android`. An iOS Simulator build is not an installable physical-iPhone distribution. Physical iOS builds need the owner's signing team/provisioning and device acceptance. Android SDK consent is recorded, and an actual debug APK now passes the scoped emulator journeys in [Android acceptance](ANDROID_TESTING.md). Physical Android devices, release signing and store distribution remain open. Source synchronization alone does not prove native runtime behavior.

Keep model credentials, notification signing keys, native signing identities, private server addresses and owner workspaces outside the release. General-purpose dependencies retain their own licenses; the Gradle wrapper's Apache license is embedded in its JAR, and the optional Mac recognizer bridge is Relay's original source in `native/audio/transcribe.c`. Its separately downloaded runtime/model retain the notices described in LOCAL_LISTENING.md. No competitor repository, source, screenshot, mascot or artwork is bundled as a Relay product asset.
