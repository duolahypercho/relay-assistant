# Private computer installation

Relay can set up a deployment-owned virtual computer from the separate Computer page on an Apple silicon Mac running macOS 14 or later. This is an original Relay workflow around optional general-purpose runtimes. It installs no Muse, OpenMuse, Grok or Dot application code.

When there is no usable existing engine, **Set up computer** downloads verified tools, creates a private Linux VM, builds Relay's bundled workspace image and opens the desktop. Progress, cancel, retry and interruption recovery stay on the Computer page. Navigation and setup do not insert chat messages. Existing running engines and existing stopped Colima profiles keep their previous setup/recovery path. Explicit server disable, Docker host/context selection and externally managed computers prevent installation.

## Requirements and storage

- Apple silicon, macOS 14+, at least 8 GiB physical memory and 40 GiB free storage at setup. Intel, Linux and Windows installation are not implemented by this installer.
- The private VM uses four virtual CPUs, 4 GiB memory, a 10 GiB root disk and a 25 GiB data disk. Disks are sparse; downloads and tools use additional space.
- About 139 MB of host tools are downloaded, followed by Colima's Linux image and the packages needed by Relay's desktop. First setup requires internet access and can take several minutes.
- Files live under `~/.relay/vm/<deployment-id>/`. The short root avoids macOS Unix-socket path limits. Unusually long home-directory paths are not offered this installer. The root's receipt binds it to this Relay deployment.
- Child processes have a private home, Colima home, Docker configuration, cache and temporary directory. System tools are not replaced, global PATH is not changed, and no administrator password, Homebrew, Docker Desktop, login item or launch service is installed.
- Mac folders and the host SSH agent are not mounted/forwarded into this VM. Docker uses a private Unix socket. A private Lima override suppresses automatic TCP/UDP forwarding; its local SSH control transport and Unix sockets remain. Relay's separate container and web-broker boundaries still apply; this VM is not a new grant of arbitrary host/network access to the model.

## Fixed releases

| Component     | Version | Source                                                                                  |
| ------------- | ------- | --------------------------------------------------------------------------------------- |
| Colima        | 0.10.3  | [Official release](https://github.com/abiosoft/colima/releases/tag/v0.10.3)             |
| Lima          | 2.2.1   | [Official release](https://github.com/lima-vm/lima/releases/tag/v2.2.1)                 |
| Docker CLI    | 29.8.2  | [Official Mac static downloads](https://download.docker.com/mac/static/stable/aarch64/) |
| Docker Buildx | 0.38.0  | [Official release](https://github.com/docker/buildx/releases/tag/v0.38.0)               |

`server/computer-engine-release.mjs` pins exact sizes and SHA-256 values. GitHub artifact digests were checked against the published expanded release assets. Docker's digest was measured from its official HTTPS artifact and pinned by Relay; it is not presented as an independently published Docker checksum. Executable contents are never unpacked or run before verification. Extraction is bounded, archive paths are inspected and external links/special files are rejected. A completed tools folder is committed by rename; unrelated existing destinations are never replaced. Production clients cannot supply download URLs, paths, programs, flags or profiles.

Colima's pinned binary chooses the official `colima-core` 0.10.4 Ubuntu 24.04 arm64 Docker disk image and verifies its embedded SHA-512. Relay does not change that downloader or run copied Colima source. Lima's [VZ driver](https://lima-vm.io/docs/config/vmtype/vz/) provides native Mac virtualization. See [Colima installation](https://colima.run/docs/installation/), [Lima binary installation](https://lima-vm.io/docs/installation/) and [Docker static-client scope](https://docs.docker.com/engine/install/binaries/).

The pinned Colima `--port-forwarder=none` configuration serializes zero port ranges. In real testing that alone did not suppress every forwarded port. Relay therefore writes an explicit all-port ignore rule in only its own Lima configuration. This follows Lima's documented [port-forwarding configuration](https://lima-vm.io/docs/config/port/) and preserves the required Unix engine socket. Source inspection and test logs remain research evidence, not product dependencies.

## Recovery and ownership

Only authenticated owner routes start or cancel installation; model tools cannot invoke it. Repeated request IDs do not repeat setup. Concurrent engine/setup requests are rejected. An engine appearing after an offer is detected again before mutation. A process restart marks incomplete installation interrupted and waits for another explicit request; it does not start or download anything automatically.

Cancel before opening aborts the fixed setup process and removes incomplete host-tool staging. Once VM creation has begun, Relay force-stops only its verified, deployment-owned partial VM. This is necessary because the guest Docker service may not yet be available for a graceful stop. VM disks, downloaded images and completed tools remain for retry. Failure to confirm that the private VM stopped is shown inline. Cancel during final desktop opening is rejected; the normal Computer controls become available when it opens.

A successful installation restores the private executable/configuration binding on server restart. The existing **Start computer** / **Start & resume** recovery uses that same private Colima profile and environment. Closing Relay preserves the saved desktop/VM according to the existing computer lifecycle. The Stop control now gracefully stops this verified private VM after its workspace containers, preserving files and releasing memory. Existing shared engines retain container-only Stop. See COMPUTER_POWER.md for progress, retry and wake behavior. Automatic idle/app-quit sleep, uninstall, migration and managed runtime upgrades remain separate work. Do not delete the private root to repair a computer that has user files.

The guest image build still downloads Debian packages using the existing original Dockerfile. This installer does not add a signed Relay image distribution or update service. Upstream release pins require deliberate review and new validation when upgraded. Receipt checks protect restoration from mistaken locations; they are not an integrity boundary against malicious programs already running as the Mac account.

## Verification

Run `node --test tests/computer-installation.test.mjs tests/computer-network.test.mjs` for controlled lifecycle, verification, boundaries, authorization and routing cases. `node scripts/test-computer-install-ui.mjs` performs a real official download, fresh private VM provisioning, desktop/phone UI cancellation/retry, image build and runtime checks. It creates and deletes only its disposable `/tmp/relay-ci-*` VM. It leaves the owner's engine/profile/context unchanged. Results and known failures are recorded in VERIFICATION.md; native and platform claims must match that evidence.
