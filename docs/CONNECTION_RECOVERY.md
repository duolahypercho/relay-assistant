# Your workspace across devices

The desktop app and phone app can use the same self-hosted Relay server. For a protected HTTPS server, open **Settings → Data & devices → Create connection link** on a signed-in device. Copy the link, then paste it into **Connect your devices** in the phone or desktop app. The phone shows the destination and asks you to connect; the Mac connection window explains the access grant before Connect. You can also open the link in a browser and choose a device name. No owner key is copied. The existing server-address and owner-key sign-in remains available. The native app remembers the address. On iPhone, a mistyped address stays in the same form with inline guidance; Connect becomes available when the address is valid. Authentication uses a server-issued, HttpOnly session cookie; the access key is not saved in the native preferences or workspace.

For a remote server, configure `RELAY_PUBLIC_URL` with its HTTPS origin and `RELAY_ACCESS_KEY` with a long random owner key. Keep the server behind HTTPS. The address must have no credentials, path, query or fragment. Debug native builds additionally accept loopback HTTP for development. The application remains single-owner: separate device sessions do not create separate human accounts.

## Connection links and device access

A link gives one new device full owner access to the same chats, files, settings and computer. Create it only for your own device. It expires after five minutes, and creating a new link cancels any unused link. **Cancel link** invalidates it immediately. The Data & devices page lists active sessions created with links; **Disconnect** revokes that device's session and immediately closes its live event streams. Other signed-in devices stay connected. A device can sign itself out using the existing Sign out control. These remain single-owner sessions, not separate users or team permissions.

The server stores only a cryptographically random token's SHA-256 digest, bound to the configured public origin, owner-key configuration and issuing session. A pending link becomes unusable when its issuing session expires or is revoked. Redeeming it atomically creates a seven-day HttpOnly, Secure, SameSite=Lax session and consumes the grant. Repeating the exchange is only accepted when the caller already holds that exact issued session; another browser cannot reuse the link. The receiver's name is bounded, and failed exchanges are rate-limited. Ordinary API owner and origin checks apply to creation, cancellation and revocation.

The copied credential is in the URL fragment, outside the HTTP path/query. The web entry removes it before mounting the workspace, keeps the pending value only in memory and sends it in the explicit exchange body. The native connection preferences save only the canonical server origin; the Mac stores its session in its existing persistent cookie partition, and iPhone/Android use the WebView cookie store. Links are absent from workspace state, model context and exports. Clipboard contents remain under the device user's control. Reloading an unfinished browser review discards its in-memory link; open it again or make a new one. A lost exchange without its session cookie needs a new link. Disconnecting an already connected device does not delete its chats/files or undo its earlier work.

Link creation requires both `RELAY_PUBLIC_URL` (canonical HTTPS origin) and `RELAY_ACCESS_KEY` on the server. It does not expose a loopback-only desktop server, provision hosting, configure DNS/TLS or open firewall ports. An address without a link still uses normal sign-in. Native release builds reject non-HTTPS links; loopback HTTP remains available only for address-based development connections.

The cross-device behavior is informed by [Grok Bot’s mobile guide](https://docs.x.ai/grok-bot/mobile). The grant mechanism is independently implemented; its random, expiring, single-use tokens and fixed-origin URLs apply the relevant token-handling principles in [OWASP’s URL-token guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html#url-tokens). This is a device connection feature, not password recovery or Grok's authentication service.

On Mac, reloading while the initial page is still loading replaces that navigation without a fatal startup dialog. Other startup failures still surface normally. This follows Electron’s distinction between a window’s [initial load promise](https://www.electronjs.org/docs/latest/api/browser-window#winloadurlurl-options) and the subsequent navigation; the packaged regression exercises a real interrupted HTTPS load.

## When the connection drops

An open workspace keeps the composer available and displays one inline connection notice. Typing stays in a tab-local draft buffer. A successful reconnect retries the draft save and attached-file selection; it never automatically sends a message or repeats an external action. Relay retries when the device comes online, the page returns to the foreground, and during its normal refresh. The notice also offers **Reconnect**.

If the session expires, Relay shows sign-in immediately when an API request or live update detects it. Signing in reopens the selected conversation with its pending text and attachment selection. An initial side-chat link also survives sign-in. The original workspace stays on the server. A previously connected origin cannot silently become an unrelated sample workspace when its startup request fails.

Draft buffers contain unsent text and uploaded-file IDs, not provider credentials. They are scoped to the thread’s creation time and server origin. They protect pending edits within the current WebView/tab; force quitting while completely offline does not guarantee retention of edits that have never reached the server. Server-saved drafts and cookies survive the tested native app restart. Uploaded file bytes remain on the server.

Messages and results synchronize between independently authenticated sessions. A local unfinished message is not replaced by an incoming result or another device’s send. Other actions still need an explicit retry when a request fails; Relay does not infer whether an uncertain external action succeeded.

The native connection form and bundled phone recovery screen use English, Simplified Chinese or Traditional Chinese. A form opened inside the workspace follows its selected app language; offline recovery follows the device language. The iPhone acceptance covers the actual unreachable HTTPS screen, remembered address, Change server, cancellation and full application relaunch in all three languages.

Addresses using a [browser-blocked port](https://fetch.spec.whatwg.org/#port-blocking) are rejected before navigation. Testing port 9 exposed a blank WebKit page instead of recovery; the form now rejects that destination directly. Normal unavailable HTTPS on an allowed port reaches the recovery screen. The port rule is shared by web/desktop connection links and independently implemented in the Swift and Java parsers.

[Capacitor’s configuration documentation](https://capacitorjs.com/docs/config) specifies that its Android error page cannot access plugins. Android therefore supplies native Retry and Change server controls when the exact bundled error URL loads, hiding the failed WebView from accessibility. Retry reloads the saved connection, and Change server uses the ordinary native form; no additional JavaScript bridge or TLS bypass is introduced. The actual Android debug APK now passes English, Simplified Chinese and Traditional Chinese emulator recovery, including invalid-input retention, blocked ports, relaunch, Retry, Change server, Cancel and Use sample; see ANDROID_TESTING.md. The iPhone uses the bundled web recovery controls with its existing native bridge.

## Live-session lifetime

Every event-stream snapshot rechecks its original session. Logout immediately closes that session’s open streams. Expiry without new activity closes on the next 15-second heartbeat; no new snapshot can be sent after authorization expires. Separately authenticated devices stay connected. The frontend also rejects callbacks from older connection generations after sign-in changes, and stops its previous stream and polling when sign-in is required.

## Verification

- Three Node cases cover logout across multiple streams, expiry before a new snapshot/command, and isolation between independently authenticated devices.
- Desktop and phone browser journeys cover offline unsaved text, retained attachments, recovery, wrong-key feedback, expiry, exact chat restoration, startup failure, synchronization and logout. Network faults are injected by the browser; the HTTP server and storage are real.
- An actual iPhone Simulator journey uses WebKit over HTTPS, a test root trusted only in a newly created Simulator, a Secure HttpOnly cookie, the native connection dialog, a server outage, session expiry, an independently authenticated TLS client and a complete application restart. The harness deletes that Simulator and its certificate store afterward. The Mac host trust store is unchanged.
- Public deployment, physical-device networks, broader Android account/notification/hardware paths and distribution signing still need acceptance. Controlled-model replies do not establish live provider quality.

```sh
npm run build
node --test tests/session-recovery.test.mjs tests/http.test.mjs
npm run connection:test:ui
npx cap sync ios
npm run connection:test:ios
npm run connection:language:test:ui
npm run connection:language:test:ios
npm run connection:language:test:native-unit
npm run devices:test:ui
npm run devices:test:mac
npm run devices:test:ios
```

The native command requires Xcode and the iOS 26.5 iPhone 17 Pro Simulator runtime. Run Xcode builds sequentially. Receipts and screenshots are written to the sibling `relay-evidence` directory; native result bundles are written to the sibling `work` directory above outputs.

The behavior follows the shared conversation and mobile continuity described in [Grok Bot’s mobile guide](https://docs.x.ai/grok-bot/mobile), checked October 11, 2026. Relay’s server-selection and session implementation is independent; it does not use Grok Bot’s account service or proprietary code.
