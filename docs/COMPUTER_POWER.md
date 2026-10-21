# Stopping and waking Relay’s private computer

For a VM installed by Relay, **Stop computer** closes workspace apps and jobs, then gracefully stops that private VM. This releases its allocated memory while preserving the VM disks, workspace volume and saved files. **Start computer** wakes the same VM and opens the saved desktop. It keeps the owner in control; **Start & resume** from chat explicitly hands back after readiness. Closing Relay continues to detach from the desktop without automatically shutting down a background computer.

The existing Stop button performs this action. It does not open a confirmation modal or add a message to chat. Progress appears on Computer and in the paused-chat status. Navigating, reloading or using another client observes the same server operation. New computer input, startup, control changes and maintenance are blocked while stopping. Stop is not cancellable after it begins closing apps; an ordinary stop is bounded and never force-kills an installed VM.

A failed or unconfirmed stop remains visible with **Try stopping again** and **Start computer instead** when the desktop is closed. Failure does not imply that memory was released. Interrupted server restart retains a recovery notice and waits for an explicit choice; it never replays shutdown automatically. A confirmed stopped VM is idempotent. The model has no VM shutdown tool.

## Ownership and lifecycle

Only a verified, selected installation created by `ComputerInstallation` receives VM shutdown. The server rechecks the deployment receipt, selected engine, installed tools and exact Colima profile before dispatch. It uses the private executable, home and configuration; clients cannot supply commands, profile names, flags or paths. The fixed command is `colima stop --profile relay` in that private environment. A subsequent profile inspection must report `Stopped` before the UI reports completion. No force or disk-delete command is used.

An existing Docker or Colima installation retains its container-only Stop behavior. Relay does not shut down a shared engine. Administrative server disable or a changed/unverifiable installation blocks private VM shutdown.

Private shutdown first retains owner control and advances the computer epoch, rejecting stale computer input and pausing assistant work. It drains foreground and isolated local-app work, removes the command container while frozen, stops the desktop and closes an optional private-browser session before stopping the VM. Encrypted browser state is retained through its existing vault; temporary browser processes are disposed without permanently disabling the service. Image preparation, updates and restore-point operations cannot overlap private shutdown.

Service quit remains separate: pending explicit shutdown is drained during graceful close, but ordinary quit does not request VM shutdown. An externally terminated server may leave the VM running; its saved stop marker produces a recovery notice on the next start. Idle-time sleep, app-quit policies, managed runtime upgrades, migration and removal remain separate work.

## Validation

`node --test tests/computer-sleep.test.mjs` checks ownership, fixed commands, duplicate suppression, serialization, no forced deletion, failure/retry, interrupted recovery, shared-engine exclusion, browser lifecycle and owner/same-origin routes. Real browser, packaged Mac and native iPhone acceptance scripts are exposed as `computer:sleep:test:ui`, `computer:sleep:test:mac` and `computer:sleep:test:ios`. They use disposable private VMs, preserve the owner’s existing profile/context and verify saved file contents across real shutdown/wake. Actual results and limitations are recorded in VERIFICATION.md and the sibling `relay-evidence/computer-sleep-*` receipts.
