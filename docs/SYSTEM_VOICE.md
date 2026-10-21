# Mac system voice

Open **Settings → Voice → Set up voice** on a supported Mac server to enable local listening and the installed Mac voice together after the disclosed download. For speaking alone, open **Voice options → Use Mac voice** (or **Use Mac voice** directly when separate providers are already configured). There is no speech-service endpoint, model ID, voice ID or API key to enter. The choice is explicit and persists across restart. **Preview voice** in the simple setup, or **Preview Mac voice** in Voice options, creates a short preview without saving a memo, changing the selection or adding a chat message. Choose Play to hear it. **Cancel test** stops a pending preview; leaving Voice settings cancels it too.

In a conversation, open the reply’s **Message actions → Create voice memo**, then Play. The recording and exact transcript stay with that reply. A phone connected to that Mac can play the same recording. The Mac generates the audio; playback happens on the device using Relay. The Mac and server must remain reachable. The ordinary authenticated audio download and seek behavior apply.

The first synthesis can be slow while macOS loads its voice. Relay shows progress, allows cancellation and stops synthesis after 60 seconds. In the initial local command probe, a cold sentence took 39.8 seconds and a warm default-voice sentence took 4.84 seconds. These are observations on this development Mac, not a latency guarantee. The selected voice and language are controlled by macOS; Relay does not download voices or change system preferences. See [Apple’s voice settings guide](https://support.apple.com/en-mo/guide/mac-help/mchlp2290/mac).

This option supplies **speaking only**. Dictation and live voice calls need [local listening](LOCAL_LISTENING.md) or a listening/transcription service, and assistant replies need a chat model. When both are configured, the existing call pipeline can use the system voice for output. Real microphone, acoustic echo, voice quality and physical-device acceptance remain separate checks.

## Connections and portability

The Speaking connection selector offers **Mac system voice**, any saved speech connection, any server configuration and **Off**. Off and Mac system voice retain a saved provider connection so switching back does not require another key. An in-flight audio operation or active call blocks connection edits. Stale windows must reload before saving a changed revision.

The option appears only on a Mac server with `/usr/bin/say`. A workspace moved to another platform keeps its choice but reports the Mac voice as unavailable; choose Off or a speech service. No voice assets are bundled or redistributed. Native Windows/Linux synthesis is not implemented by this adapter. Local recognition is supplied by the separate local-listening adapter.

## Implementation and verification

`server/system-speech.mjs` is an original adapter based on the Mac’s installed `man say` documentation. It launches a fixed `/usr/bin/say` command without a shell, passes reply text only through stdin, neutralizes embedded speech commands and writes mono 22,050 Hz PCM WAV to a private temporary directory. Replies are limited to 4,096 characters, output to 8 MB, and concurrent synthesis to two operations. Cancellation and timeout kill the owned process group and wait for its exit before releasing temporary storage. Raw subprocess details, credentials and file paths are not returned in error messages. Successful replies enter the existing durable voice-memo storage; previews remain temporary.

Reproduce the bounded checks on a Mac with an installed voice:

```sh
node --test tests/system-speech.test.mjs tests/voice-connections.test.mjs tests/speech.test.mjs
npm run voice:system:test:ui
npm run voice:system:test:mac
npm run voice:system:test:ios
RELAY_VOICE_CALL_SYSTEM=true npm run voice:test:ui
```

The Node suite uses controlled audio for failure, auth, settings and process-lifecycle cases. UI acceptance uses actual macOS synthesis and real browser playback; only the chat response is controlled. The Mac journey uses the packaged application’s own isolated backend and full quit/relaunch. The iPhone journey creates its own Simulator and TLS trust, plays the Mac-generated reply in WKWebView, and removes its test device afterward. See VERIFICATION.md for completed runs and evidence. Simulator checks do not establish physical-device or Android runtime support.
