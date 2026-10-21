# Audio and video attachments

Add a recording or video with the existing chat attachment picker, or open it from Files. Sent attachments and assistant file results have a small player directly in the conversation. Play, pause, seek and mute work without opening another window. Tapping the filename opens the existing file preview with the original download.

Playback is manual. Starting another recording pauses the previous one. Leaving the page, opening a file preview, or backgrounding the app stops playback. Previewing does not send a message, call the model, transcribe a recording or change the draft. Closing a preview releases its temporary file URL. Files remain available when a device cannot play their format.

## Assistant access

With a listening service configured in Settings, the assistant's `read_file` tool can transcribe an audio attachment. It sends the original bytes through the existing bounded transcription service and returns the transcript with an explicit warning that automatic transcription can contain errors and is untrusted source content. It cannot authorize actions. Cancellation and lost run authority discard late results. This does not enable automatic transcription on upload or playback.

Without a listening service, the tool reports the setup needed; playback and download still work. Video inspection uses the same attachment or **Ask about this** flow. Uploading, opening or playing a clip does not automatically inspect it or send audio to a provider.

For a video, `read_file` returns its duration, dimensions, audio-track availability, source hash and suggested sample times. `read_video_frame` supplies one actual JPEG near a requested timestamp to an image-capable model. Multiple requested frames arrive together after their tool results. `transcribe_video` extracts a selected soundtrack segment to mono 16 kHz WAV and sends it through the configured listening service. The response identifies that segment's start/end time. Repeated reads leave one file card in the assistant's response and preserve the original bytes.

The assistant must distinguish sampled frames from continuous viewing, cite approximate times and disclose unsampled portions. A transcript has no visual context and may be inaccurate; a still frame has no sound and cannot establish everything that happened between samples. Automatic subtitles, scene detection, native video-model transport and live vision/transcription quality are separate work.

## Video decoder setup and boundaries

Install a current **FFmpeg and ffprobe** on the Relay server (verified here with FFmpeg 8.1.1, including its seekable `fd` protocol and `scale` filter's `reset_sar` option). Relay checks the server's PATH and standard Homebrew/Unix locations. To choose another installation, set absolute `RELAY_FFMPEG_PATH` and `RELAY_FFPROBE_PATH` paths. The macOS app reads these from its existing `server.env`. Mobile clients use their connected server's decoder. FFmpeg is an external prerequisite; Relay does not redistribute its binary. Missing or incompatible decoders produce a setup message while playback/download remain available.

The decoder runs with fixed arguments and no shell. Only the uploaded source's inherited read-only file descriptor is available to the input protocol; network and ordinary file protocols, playlists and MOV external data references are disabled. Temporary sources use a private directory and are removed after the child process closes. No provider credentials or inherited FFmpeg report settings are passed to the child. Decoder diagnostics are not logged or returned as source text.

Input is at most 8 MiB; metadata allows up to two hours, 4096 pixels per side and 16 streams. One selected video/audio stream is used. Frames are scaled to at most 1280 pixels per side with a 2 MiB output limit. Audio segments are at most 120 seconds, bounded to 4 MiB. Two reads may run at once, with a 20-second deadline per child and bounded output/allocation/thread settings. These are process/resource bounds, not an operating-system sandbox or a hard aggregate memory limit. Cancellation kills the decoder; source hashes and execution authority are checked again before returning pixels or sending audio to the listening service.

## Formats and limits

Application uploads remain limited to **8 MiB per file**, with up to eight chat attachments. Recognized containers include MP3, M4A/MP4, WAV, Ogg, WebM, FLAC and QuickTime/MOV. Actual playback depends on the codecs available on the device; recognition is not a promise that every encoding works. File-extension inference applies only when MIME information is absent or generic. Explicit HTML/SVG types are never reclassified as playable media.

The transcription service checks supported container signatures, uses its existing timeout and response bounds, and forwards the file to the configured provider. The provider may support fewer formats. These checks are not a full media decoder or a transcription-quality guarantee.

## Verification and references

Run `npm run media:test:ui`, `npm run media:test:mac` after packaging, or `npm run media:test:ios` on macOS with Xcode. Fixtures use an original synthetic WAV and locally generated H.264 MP4, an isolated Relay workspace, and independent controlled HTTP model/transcription services. Acceptance checks verify playback, seeking/muting, exclusive playback and cleanup, exact downloaded bytes, preserved drafts/history, and actual audio bytes reaching the configured service. See VERIFICATION.md and `../relay-evidence/media-*-acceptance.json` for completed runs and platform scope.

Video inspection adds `node --test tests/video-reader.test.mjs` and `npm run files:video:test:{ui,mac,local-mac,ios}` (choose one script suffix). Its original six-second fixture changes red → blue → green and contains two different sine tones. Tests check decoded pixel colors and audio frequencies, timestamps/segment bounds, invalid sources, source/authority races, cancellation, missing decoders and environment/protocol restrictions. Controlled HTTP services prove the bytes reach the services and the result reaches chat; their synthetic transcript does not certify real speech recognition or visual reasoning.

Product research used [Grok Bot files and results](https://docs.x.ai/grok-bot/files-and-results), [Grok Bot messaging](https://docs.x.ai/grok-bot/chat-and-collaboration), [Grok Bot mobile](https://docs.x.ai/grok-bot/mobile) and [Muse's introduction](https://introducing.muse.ai/). Browser behavior follows the documented [video element](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/video) and [canPlayType](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/canPlayType) APIs. This implementation uses no reference-product code or assets.
