# Updates while you’re away

Open **More → Settings → Notifications** in the desktop or mobile app. Turn on **Notify this device**; mobile asks for the system notification permission at this point. Message previews start off. With previews off the lock screen only says that Relay has an update. With previews on it may include the assistant’s name and up to 240 characters. Apple/Google still receive device and delivery metadata.

An update opens the exact conversation and message, reply thread, or pending review. It never approves or executes an action. Main and side-chat drafts and attachments stay in place. Wrong-workspace notifications are rejected. Reading a conversation clears its unread status. The bell and sidebar show unread updates even without device push.

Each assistant’s settings offer results and requests, requests only, or off. Group updates use the workspace-wide preference. The global Workspace notifications setting also controls device delivery. Foreground Relay stays quiet: device presence suppresses queued alerts and mobile foreground presentation is disabled. Other connected devices can still notify when an update is unread.

## Desktop

Electron polls the owner-authenticated server with the same cookie session as the app window. Closing every window keeps this process running on macOS; a notification tap reopens Relay. **Quit Relay** ends desktop polling. Relay must be allowed to display notifications in system settings. Electron’s current macOS notification API also requires a code-signed app. The supplied unsigned development package cannot display OS alerts; it records the failure and shows a settings explanation. Signing and real Mac OS delivery remain a release gate. This is not an always-on OS background daemon.

## iOS server setup

Use your own Apple Developer app identifier, push entitlement, provisioning and APNs key. Keep signing keys outside the repository and downloadable artifacts. Set:

```dotenv
RELAY_APNS_KEY_PATH=/private/path/AuthKey.p8
RELAY_APNS_KEY_ID=YOUR_KEYID
RELAY_APNS_TEAM_ID=YOUR_TEAMID
RELAY_APNS_TOPIC=org.relay.assistant
RELAY_APNS_ENVIRONMENT=development
```

Use `production` for production signing. The topic must match the signed bundle identifier. Debug and Release project settings select development and production entitlements respectively. Rebuild with `npm run mobile:sync`, then sign in Xcode. Simulator injection tests do not establish APNs delivery to a physical device.

The transport uses HTTP/2 and a cached ES256 provider token. It calls the fixed Apple sandbox or production endpoint; workspace content cannot replace that destination. The response is checked and invalid registrations are disabled.

## Android server setup

Create your own Firebase project and Android registration for the app identifier. Place its `google-services.json` in `native/mobile/android/app/` for your private build. Keep it and the private service-account key out of published source. Set:

```dotenv
RELAY_FCM_SERVICE_ACCOUNT=/private/path/firebase-service-account.json
```

The server reads `project_id`, `client_email` and `private_key`. It signs an RS256 OAuth assertion and uses the fixed Google OAuth and FCM HTTP-v1 endpoints. It does not trust endpoint fields in the credentials file. The mobile app creates an Assistant updates channel and requests notification permission when enabled. Automatic Firebase registration and analytics collection are disabled by default.

Android SDK consent, debug build and basic emulator journeys are now verified (see ANDROID_TESTING.md); actual Android push delivery still needs its own configured-service and device acceptance. No Firebase or Apple credentials are shipped.

## Delivery and privacy boundaries

- Device tokens and private per-installation keys are encrypted in the server’s secret store; they are absent from workspace exports and status responses. The desktop’s local identity file has owner-only permissions.
- Enrollment is explicit. It ignores older history, retains delivery receipts across restart, rechecks read/policy/focus state before dispatch and expires a device registration after 30 days without presence.
- An outbox claim is durable before the provider call. Only explicit retryable rejections are retried, at most three attempts. Lost or interrupted outcomes are recorded as unknown and are not blindly repeated. This favors avoiding duplicate alerts over guaranteed delivery.
- A provider acceptance is not proof of device delivery. OS policy, networking, app state, Do Not Disturb and provider retention can suppress or delay an alert. Alerts older than one hour are not queued; in-app updates remain available within the bounded recent feed.
- Disable or remove a device to stop future sends. A request already accepted by Apple or Google cannot be recalled. The assistant cannot enroll devices or alter notification permissions through its tools.
- Desktop notifications need the desktop process and server; mobile notifications need a running, reachable Relay server and separately configured provider credentials. Static browser sample mode has no OS push service.

## Verification

`npm test` includes 11 server/transport cases and four desktop-client cases. Independent local HTTP/2 and HTTP services verify cryptographic signatures, authorization claims, private payloads, revocation, receipt recovery and retries. `node scripts/test-notifications-ui.mjs` checks real Relay HTTP routes with controlled desktop/iOS/Android native callbacks, exact routing, draft retention, explicit permission/preview controls, device removal and accessibility. These tests do not establish vendor delivery.

`RELAY_NOTIFICATION_TEST_DEVICE=<isolated-simulator-id> node scripts/test-notifications-native.mjs` exercises actual iOS Simulator delivery and a system notification tap. See the latest verification receipt for its outcome. Physical-device delivery, hosted APNs/FCM acceptance, Android runtime and signed distribution remain separate gates.

## Reference decisions

[Grok Bot notifications](https://docs.x.ai/grok-bot/settings-and-notifications) informed per-assistant preferences, quiet foreground behavior and opening the relevant conversation. Transport behavior follows the official [Capacitor plugin](https://capacitorjs.com/docs/apis/push-notifications), [Apple APNs request documentation](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns) and [Firebase HTTP-v1 documentation](https://firebase.google.com/docs/cloud-messaging/send/v1-api). Relay’s workspace, outbox and UI implementation are original; the licensed Capacitor plugin is included as a dependency.

Packaged Mac bridge verification uses `node scripts/test-notifications-desktop.mjs`. It checks real authentication, background polling and exact reopen routing. The test records OS delivery separately; set `RELAY_REQUIRE_OS_NOTIFICATION=true` to require successful display on a signed build. See [Electron notification signing requirements](https://www.electronjs.org/docs/latest/api/notification).
