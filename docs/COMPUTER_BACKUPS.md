# Portable computer backups

A portable backup keeps saved computer files and its browser profile outside the Docker engine. Ordinary restore points remain quick copies on the same engine. Use this backup when moving saved work to a replacement engine or recovering after workspace-volume loss.

Open **Computer → Restore points** for backup controls. Save a password-protected file to your device, or import one and review it before restoring. Everything stays on the Computer page; these actions add no chat messages. The administrator command-line workflow is also available.

## Save a backup

Choose **Save backup to a file**, enter a new password twice, then choose **Save backup**. Relay saves a restore point and prepares the encrypted file. The desktop and mobile apps open the system save picker; the web app starts a browser download. Cancel the picker to keep the prepared backup available for another attempt. To export an existing point without capturing again, choose its **Back up** action.

Save your work first. Capturing keeps Relay paused until you give control back. Cancelling preparation may wait for the current restore-point copy to finish; that point stays available.

For the command line, run from an installed source release with Node.js and dependencies installed:

```sh
npm run computer:backup -- export /private/backups/Relay-computer.relaybackup --url http://127.0.0.1:4173
```

Enter a new password twice; input is hidden. Use at least 12 UTF-8 bytes and keep the password separately. Relay cannot recover a forgotten password. The command refuses to overwrite an existing file, writes with private permissions, and removes incomplete output on an ordinary failure or cancellation. A forced process kill can leave an incomplete file, which cannot be imported.

By default, export saves a new restore point first. Save work in open applications beforehand. This interrupts foreground computer work and leaves Relay paused under owner control. The desktop briefly freezes during capture, then its open apps remain available. To export an existing point instead, pass `--point POINT_ID`; the authenticated `/api/computer/snapshots` response lists IDs. Relay allows ten restore points; remove an old one through the page when necessary.

Copy the completed `.relaybackup` file to private storage **away from the computer engine’s disk**. Keeping it on that same disk does not protect against disk loss. Backups contain browser-profile data and may contain signed-in session material. The file is encrypted, but anyone with both the file and its password can recover its saved contents.

## Import and recover

When Relay detects missing previously verified storage, the Computer page opens **Recover your workspace** immediately below the explanation. A successful engine listing must confirm the volume is absent; an unreachable engine does not trigger this state. Ordinary owner/agent startup refuses to silently replace it. Use a surviving point's **Restore** action, or **Import backup** below.

Without a saved copy, **Start a new empty workspace → Start empty workspace** explicitly creates a separate empty volume. It does not recover lost files. **Not now** leaves the original location selected. The review is invalidated when storage changes, and attached desktop/command processes prevent fresh recovery. A durable operation journal tracks replacement and cleanup; failed startup attempts return to the original missing location. A committed fresh start retains the prior volume name in the private SQLite `computer_workspace_losses` table for administrator investigation. This record is not a copy of its files. Owner control, chat history and existing saved points are preserved. Normal chat can continue independently, with a **Recover computer** link in its paused status.

Start a compatible Relay computer engine and install/build Relay’s desktop image first. Connect Relay to the replacement engine using the normal local setup or dedicated remote-engine configuration. Choose **Import backup**, select the `.relaybackup` file and enter its password. **Import & review** adds a private saved point and opens the restore review. Your current files remain unchanged until you choose **Restore workspace**. A wrong password leaves the selected file available so you can try again.

For the command line, run:

```sh
npm run computer:backup -- import /private/backups/Relay-computer.relaybackup --url http://127.0.0.1:4173
```

Enter the original password. The command imports into a fresh, private volume and adds **Imported backup**. It does not replace current saved files. Open **Computer → Restore points**, choose **Restore** for the imported point, review, then choose **Restore workspace**. Existing workspace files become a Before restore point when that workspace still exists. If the original workspace volume is gone and no old desktop/runtime remains attached, Relay can restore without it. Successful recovery starts the desktop with the current computer software and keeps owner control until you choose Give back to Relay.

Use a separate Relay workspace/server to test a backup without affecting your active computer. Never attach two Relay servers to the same writable workspace volume. A changed engine must supply a compatible desktop image; the backup does not install one or rewrite the connection configuration.

## Server access and automation

The default URL is `http://127.0.0.1:4173`. Specify `--url` for another port. Remote URLs require HTTPS with valid certificate verification. When owner authentication is enabled, provide `RELAY_ACCESS_KEY_FILE` or the existing `RELAY_ACCESS_KEY` environment variable. No access key or backup password is accepted as a command-line argument.

For unattended use, `--password-file /private/backup-password` reads a private regular file (permissions 600 on Unix), with at most one trailing newline removed. Protect this file separately from the backup. The command never prints the password, owner cookie, file names inside the backup, or file contents. Import transfers the password in a request header over the authenticated connection; administrators should exclude `X-Relay-Backup-Password` and export request bodies from reverse-proxy request logging.

## Format and boundaries

- Prepared encrypted downloads are private to the signed-in session and expire 15 minutes after preparation. Normal completion/cancellation removes staging files. A force-quit can leave encrypted temporary files; startup/next-use cleanup removes only recognised abandoned files. Native saving streams in 1 MiB chunks instead of using the attachment size limit. The full format limit has not been exercised through a mobile picker.
- Up to **8 GiB of regular-file bytes, 200,000 entries and 64 MiB of metadata**. Streamed transfer avoids loading the workspace or full archive into server/client memory. It needs free space for a new saved-point volume, and restore additionally needs a working copy.
- Original versioned format using AES-256-GCM with independently authenticated 1 MiB frames, random salt/nonce prefix, and fixed scrypt parameters (`N=65536, r=8, p=1`, 32-byte key). Frame index, size and header are authenticated; an authenticated final frame rejects truncation. There is no compression or caller-selected cryptography.
- Import authenticates each frame before forwarding its contents into a network-disabled helper with a read-only root, no capabilities, no host mounts and user 1000. It creates only regular files, directories and symlinks inside a new owned volume. Canonical relative paths, unique records, directory-only parents, bounded metadata, sizes and end counts are validated. Links are preserved but never traversed; device files, named pipes, duplicate entries, path traversal and privileged mode bits are rejected. Export omits sockets.
- File bytes, relative paths, ordinary permission bits and symlink targets are kept. Ownership becomes the Relay guest user. Timestamps, extended attributes, ACLs, hard-link identity and sparse allocation are not preserved. Browser sign-ins may expire or be incompatible with another software version.
- A private operation journal permits startup cleanup of Relay’s own interrupted transfer helper and unfinished volume. A point appears only after authenticated EOF and successful guest validation. Helper ownership and isolation are verified before cleanup. Failed imports leave the active workspace and completed points intact. Transfers have a 15-minute limit and are drained during normal server shutdown.
- Saved disk state only: no open-process memory, unsaved buffers, chat messages, attached chat files, provider credentials stored by Relay, app settings, desktop image or full machine snapshot. Back up the Relay application database/secrets separately using [Hosting](HOSTING.md). Signed-in browser material saved **inside the computer profile** is included.

Technical foundations: [Node authenticated encryption and scrypt](https://nodejs.org/api/crypto.html) and [Docker volume backup and recovery](https://docs.docker.com/engine/storage/volumes/#back-up-restore-or-migrate-data-volumes). The transfer implementation is original Relay code.

## Verification

Run `node --test tests/computer-backup-codec.test.mjs tests/computer-backup-guest.test.mjs tests/computer-snapshots.test.mjs` for format/corruption/path-boundary checks. Run `RELAY_BACKUP_TEST_DOCKER_HOST=unix:///path/to/dedicated-test/docker.sock npm run computer:backup:test:runtime` for authenticated CLI export/import and recovery after deleting only the harness’s isolated computer containers and volumes. This deliberately simulates volume loss; it does not claim a physical disk-loss test, live browser sign-in continuity or remote-engine migration acceptance.

Use `npm run computer:backup:test:ui`, `npm run computer:backup:test:mac` and `npm run computer:backup:test:ios` with `RELAY_TEST_DOCKER_HOST` pointing to a dedicated test engine for the in-app flow. Tests cover encrypted files larger than 10 MB, cancellation, wrong-password retry, inline review, exact restored bytes, unchanged chat and retained drafts. Mac acceptance controls Save-dialog responses while exercising the packaged bridge/filesystem. The iPhone Simulator harness uses actual system save/import pickers. `npm run computer:backup:test:native-unit` covers Swift staging boundaries. Android currently has a passing pure-Java staging test only; its plugin/build/runtime and physical-device backup flows remain unverified.
