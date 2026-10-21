# Keep Relay online

Run Relay on a Linux server so phones and computers share one workspace even when your desktop app is closed. This is a single-owner, self-hosted deployment. You supply the server and domain; Relay does not provision a cloud account.

## Start

You need Docker Engine with the Compose plugin, a server reachable on TCP ports 80/443 (UDP 443 is optional), and a domain whose A/AAAA records point to that server. Run these commands from this repository. If an AAAA record exists, its IPv6 route must work too.

```sh
export RELAY_DOMAIN=relay.example.com
docker compose -f deploy/compose.yaml up -d --build
docker compose -f deploy/compose.yaml run --rm --no-deps setup --show-access-key
```

Open `https://relay.example.com`, enter the displayed access key, and use **Connect AI** to choose a model. Keep the key private: it grants owner access. The setup job creates a random key on first launch and preserves it on subsequent launches. Normal startup logs do not print it. You can run the last command again to retrieve it.

Connect the Relay mobile app to the same HTTPS address. The server remains responsible for conversations, saved files and scheduled work; the phone does not need to stay open. Use Settings → Devices to pair another device from an already signed-in workspace.

Caddy obtains and renews the public TLS certificate automatically. Its certificate state lives in a persistent volume. Public certificate issuance requires correct DNS and reachable ports; localhost testing uses Caddy's private CA instead. See [Caddy's HTTPS documentation](https://caddyserver.com/docs/automatic-https).

## What runs

- `app`: Node 24 and Relay, running as an unprivileged user with a read-only image. The app has no directly published HTTP port.
- `https`: Caddy, the only published entry point. Its administration endpoint is disabled.
- `setup`: an offline, one-time key initializer. It refuses damaged existing keys instead of replacing them.
- `maintenance`: an offline backup/restore helper, started only when explicitly requested.

The source build uses a Dockerfile-specific allowlist. Workspace databases, `.env`, credentials, downloaded models and native release packages are excluded. The separate private-computer build retains its own restrictive `.dockerignore`.

Persistent `relay-data` contains SQLite, saved files, browser state and the model credential vault key. `relay-secrets` holds the owner access key and Google token encryption key. Both are needed to recover a workspace. An optional remote computer has separate VM volumes and a private connection bundle; the archive below does not back those up. Preserve them separately and attach only one running application to that computer. Caddy's `https-data`/`https-config` volumes retain certificate state. Container replacement and `docker compose down` preserve these volumes; `down --volumes` deletes them.

## Back up and restore

Keep the same `RELAY_DOMAIN` and Compose project name for all commands. Backups contain private conversations, files and credentials. Store them privately. Stop the app first so SQLite and files form one consistent snapshot; Caddy can remain up during this short maintenance window.

```sh
umask 077
docker compose -f deploy/compose.yaml stop app
docker compose -f deploy/compose.yaml run --rm --no-deps -T maintenance backup > relay-backup.tar.gz
docker compose -f deploy/compose.yaml start app
```

Check that the backup command succeeded before treating the file as a valid backup. Restart the app even if backup fails. Move the completed archive to your private backup storage. The archive includes both data and secrets; the Docker image/source is reproducible separately. Caddy certificates are outside this archive and will be obtained again on a new host. Avoid repeated migrations that could hit certificate issuance limits.

Restore only an archive you created, into **new, empty volumes**, before first startup. Build the same Relay version first. The helper refuses to overwrite a populated data or secrets volume.

```sh
export RELAY_DOMAIN=relay.example.com
docker compose -f deploy/compose.yaml build
docker compose -f deploy/compose.yaml run --rm --no-deps -T maintenance restore < relay-backup.tar.gz
docker compose -f deploy/compose.yaml up -d
```

To test a restore beside an existing deployment, use a different Compose project name and separate ports/domain. Never point two running app containers at the same data volume. A failed extraction can leave an incomplete new volume; correct the archive and start again with fresh volumes rather than launching that partial restore.

## Update and diagnose

Back up, update to the intended source revision, then run the startup command with `--build` again. The app stops gracefully before replacement; persistent keys and state are reused. There is no automatic database downgrade guarantee, so keep the prior source/image and backup together.

```sh
docker compose -f deploy/compose.yaml ps
docker compose -f deploy/compose.yaml logs --tail=60 app https
```

Generic file-mounted secrets are supported through `RELAY_ACCESS_KEY_FILE` and `RELAY_TOKEN_ENCRYPTION_KEY_FILE`. Set either a direct variable or its `_FILE` counterpart, never both. Files must be absolute, readable, bounded and contain one line. Compose uses files so keys are absent from container environment listings. See [Docker's secrets guidance](https://docs.docker.com/compose/how-tos/use-secrets/).

## Current limits

This stack supports hosted chat, saved state/files, model connections, scheduled work and the read-only web browser. Its default deployment has computer access disabled. To enable it, an administrator can connect a dedicated VM using a private certificate bundle; see [a separate computer](REMOTE_COMPUTER.md). The application host needs no Docker socket or host-folder mounts. The credential controls the entire dedicated engine, so that VM must be exclusive to this workspace. Automatic provisioning and certificate renewal remain open.

The Linux image includes a pinned CPU recognition engine. In **Settings → Voice → Set up local listening**, an explicit 148 MB model download enables on-server dictation and voice-chat recognition without an audio-service account. Connected phones use that same engine; setup and progress stay out of chat history. See [local listening](LOCAL_LISTENING.md).

Managed Ollama installation and system speech remain Mac-only. Connect supported model and speaking services in Settings. Local model addresses mean the server container's localhost, not the phone or host's localhost; an administrator can use an explicit internal service endpoint through the existing model environment variables. Push notification delivery, external OAuth credentials, public DNS/TLS issuance, physical phone tests and signed store distribution each require their own configured services or devices.

Linux ARM64 container acceptance and the exact checks run are recorded in VERIFICATION.md. The controlled model used by the hosting harness proves transport and persistence, not model reasoning quality. The native iPhone test uses an isolated Simulator and private test CA; it never changes the owner's system trust store.

Computer workspace files and browser profiles have a separate [encrypted portable backup workflow](COMPUTER_BACKUPS.md). The application archive above does not include private computer volumes. Keep both backups and their required secrets independently of the engine disk.
