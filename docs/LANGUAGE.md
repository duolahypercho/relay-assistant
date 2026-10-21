# App language

Settings → Appearance & personality → App language changes the interface on this device immediately. Choices are Follow system (default), English, 简体中文 and 繁體中文. Search also finds this setting using “language”, “语言” or “語言”. Other windows of the same workspace on the same browser profile follow changes through the browser storage event. Separate devices keep their own choice.

System mode uses the first supported device language, recognizes Chinese script and region hints, and falls back to English. An explicit choice overrides the device language. Dates and currency formatting follow the interface locale without changing time zones, currency amounts or saved data. Names, messages, files, chat titles, drafts and the canonical values of settings are never passed through the translation dictionary. This does not instruct the model to translate or change its response language.

The current original translation catalog covers the main navigation, page headings, introductory chat/composer controls, search/navigation destinations and personal settings. Some chat tools, detailed tool screens, errors and native shell/OS controls still use English. The interface states this limitation beside the selector. Broader screen coverage and additional languages remain open; this is not complete language parity.

Implementation: `shared/ui-language.mjs` resolves preferences and interpolates original copy from `shared/ui-translations.mjs`. `src/i18n.ts` stores `relay.ui-language` locally, updates `html.lang` and the title, and publishes changes through a React external store. Saving must succeed before the visible preference changes. Navigation translates only catalog labels; user-authored titles remain data. Chinese exact page requests use the same context and busy guards as English requests, and never consume attachments or filtered requests.

## Phone connection and offline recovery

The phone’s native **Connect your devices** form and bundled offline recovery screen now support English, Simplified Chinese and Traditional Chinese. Opening the form from the workspace uses that device’s selected app language. Before the workspace loads, recovery uses the system language because the bundled origin cannot read an unavailable server’s language preference. Server addresses, connection grants and typed input remain unchanged. The catalog is original copy in `public/native-connection-language.json`, shared by the browser, Swift and Java readers.

The iPhone form retains invalid text, shows its correction in the same form and disables Connect until the address is valid. Android retains its inline field error. Both parsers reject browser-blocked ports. Android has a native recovery view because Capacitor does not expose plugins to its Android error page; that view’s compile/runtime acceptance is still pending the SDK setup. Mac native menus and its connection window remain outside this translation scope.

## Verification

- `npm run connection:language:test:ui`, `npm run connection:language:test:ios` and `npm run connection:language:test:native-unit`: bundled recovery accessibility, real iPhone form validation/relaunch in all three languages, and Swift copy/port rules.
- `npm test`: locale/script fallback, catalog completeness and placeholder parity, preserved interpolation data, and exact Chinese navigation versus contextual requests.
- `npm run language:test:ui`: desktop/phone browser journeys against isolated SQLite and a controlled HTTP provider; unsaved profile fields, drafts, original messages, canonical model/settings data and zero model calls; reload, per-device preferences and cross-window synchronization; automated accessibility and viewport checks.
- `npm run language:test:mac`: the same main journey in the packaged Mac client against an isolated local server. Archive byte checks verify bundled runtime assets separately.
- `npm run language:test:ios`: real WKWebView and native select interaction in a disposable iPhone Simulator, followed by full relaunch with the saved language and unfinished draft.

The reference behavior is [Grok Bot's app language setting](https://docs.x.ai/grok-bot/settings-and-notifications) and [mobile device-language behavior](https://docs.x.ai/grok-bot/mobile). These informed behavior only; the translations and implementation are original. No competitor code or assets were imported.
