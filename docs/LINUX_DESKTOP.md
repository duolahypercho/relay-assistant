# Linux desktop application

Relay's Linux app uses the same chat interface and local SQLite worker as the Mac app. It can also connect to an existing Relay HTTPS server. Closing the window leaves the local worker running; use **File → Quit** to stop it. Launching Relay again brings back its window. Linked Linux devices are named **My Linux PC** in Data & devices.

## Local Debian installer

On the intended Debian 13 architecture, with Node 24 and Debian's `dpkg-deb` available:

```sh
npm ci
npm run desktop:package:deb
```

This produces `release/desktop/relay-assistant_0.1.0_arm64.deb` on ARM64 or `relay-assistant_0.1.0_amd64.deb` on x64, plus a SHA-256 file. The package installs Relay under `/opt/relay-assistant`, a `relay-assistant` command, and an app-menu entry with Relay's original icon. Its `org.relay.assistant.desktop` identity matches Electron's desktop name for window grouping. Open the package in your desktop's software installer, or use `sudo apt install ./relay-assistant_0.1.0_arm64.deb` on a Debian 13 ARM64 system. Use the matching filename on x64.

The bundle's directory is readable and traversable by ordinary users. The installer assigns the Chromium sandbox helper to root with mode 4755; Relay runs as your ordinary user with renderer sandboxing, context isolation and Node integration disabled in the page. Do not launch Relay as root or add `--no-sandbox` to its launcher. These builds have no update service or signed repository. The package metadata identifies an unsigned local build, not a published maintainer or support address.

The initial target is Debian 13 with X11 and the listed system libraries. The installer asks the system package manager for FFmpeg 7.1 or newer, including `ffprobe`, so video inspection has its required descriptor-input decoder. These remain separately installed Debian packages under their upstream licenses. Debian 12's default older FFmpeg is insufficient. Other distributions, Wayland, physical GPU/audio devices and native notifications require their own acceptance. Local Linux listening additionally requires the optional Linux audio runtime; packaging the desktop alone does not establish that runtime's availability. Windows builds and public distribution remain separate work.

## Reproduce the native acceptance

```sh
# Select your intended test Docker engine normally, or set DOCKER_CONTEXT.
npm run desktop:test:linux
```

The harness copies only `source-files.json` entries into a temporary context. It installs fresh Linux dependencies, builds the native-architecture Electron app and Debian installer, installs that package, then runs its installed executable as an ordinary user. The runtime container has no external network, host folders, published ports, credentials or Docker socket. Its outer seccomp filter is relaxed to permit Chromium's own namespace sandbox; Playwright explicitly enables that sandbox, and the test rejects a `--no-sandbox` launch.

The Node backend suite runs on Linux first. Native checks then cover local SQLite chat/memory, a native side-chat menu action, reusable skills, work and a real scheduled reminder while all windows are closed, reopening and full restart. A separate controlled HTTPS server verifies a one-use connection link, Secure HttpOnly cookie persistence, chat, an unfinished draft, reload during initial navigation and owner revocation. Screenshots and pass/failure receipts are kept under `relay-evidence/linux-desktop-<timestamp>` by default. The successful bundle and installer are copied to `release/desktop/linux-validation-<timestamp>`. The harness removes only its own runtime container, image tag and temporary source; it does not start or stop your Docker engine. Docker's ordinary layer cache remains available.

This is real packaged Electron/SQLite/HTTPS execution in Debian with a virtual X display. The assistant and remote-provider response are controlled test data. It does not certify live model quality, physical desktop behavior, other architectures or every feature. The `linux-desktop` CI job runs this same acceptance on the runner's Linux architecture and saves the installer and evidence; a configured job is not a claim that its hosted run has passed.

## Evidence

See [verification](VERIFICATION.md) for the exact runs and current limits. The initial ordinary-user launch failed because Electron Packager retained mode 0700 on its output directory; the packaging script now fixes that directory to 0755 before installation. Failed evidence is retained, rather than treating a successful build as a successful app launch.

The packaging uses [Electron Packager's native platform defaults](https://electron.github.io/packager/main/interfaces/Options.html), [Electron's desktop launcher conventions](https://www.electronjs.org/docs/latest/tutorial/linux-desktop-actions), and [Debian's binary control-file format](https://www.debian.org/doc/debian-policy/ch-controlfields.html). The scripts and launcher are independently written.

The [Debian 13 FFmpeg package](https://packages.debian.org/trixie/ffmpeg) provides the current tools; Relay retains its descriptor-only input and no-network decoding policy described by the [FFmpeg fd protocol](https://ffmpeg.org/ffmpeg-protocols.html#fd). The first broad Linux run retained six honest failures for this missing dependency, with the other 857 checks passing.

The decoder also avoids FFmpeg 8's `scale.reset_sar` option. It explicitly fits the input display aspect ratio into the preview bounds and then uses square pixels. Actual FFmpeg 7.1 on Linux and 8.1 on Mac pass seven reader tests, including original portrait, anamorphic and large-frame fixtures, real colors/audio, bounded inherited descriptors, cancellation and timeout cleanup. The earlier 861/863 Linux result retains the two frame-extraction failures that exposed this portability issue.
