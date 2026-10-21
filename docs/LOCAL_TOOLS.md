# Local app tools

Relay now connects installed stdio MCP programs through Your apps. The primary link-based connection flow stays unchanged; local programs are an advanced option. This implementation is original. No Hermes, OpenClaw, Muse, Grok Bot or Dot application source or artwork is incorporated.

## Reference study

The [MCP transport specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) defines subprocess stdin/stdout with newline-delimited JSON-RPC. Relay uses the already installed official SDK Client and framing utilities, with an independently written Docker transport and lifecycle manager.

[Hermes MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp/) documents explicit environment filtering and tool exposure controls. Its local reference checkout, commit `1e0c7730d791f5ce855c5c78935cfea6fb1e43a9`, was inspected at `tools/mcp_tool_transport.py` for the launch/lifecycle pattern. The useful lessons are to resolve command/arguments/environment deliberately and reap child processes. Relay does not reuse that implementation.

[OpenClaw MCP](https://docs.openclaw.ai/tools/mcp) documents command-based setup, probes, policy enforcement and retirement after configuration changes. Relay adopts the user-facing principle that saving configuration does not prove a working connection: the program must actually return its available actions or content before the connection can be saved. A program launch is code execution, so its scope is shown beside the launch button. Avoiding an extra popup must not disguise that fact.

## Behavior and boundaries

- A local launch consists of a program, literal argument array, workspace folder and explicitly supplied environment. No host shell expands arguments. Absolute executable paths may contain spaces. The guest resolves the working folder and rejects symlink escapes outside `/workspace`.
- Program, arguments, folder and environment changes require discovery again. Saved environment values can be retained only for an unchanged program/arguments/folder. Values are encrypted in the app vault and omitted from owner API views, chat catalogs, reviews and source exports. Returned tool descriptions/results redact the supplied values.
- Each session uses the verified desktop image by immutable ID, UID/GID 1000, read-only root, no privileges/capabilities, private PID/IPC namespaces, no direct network, a 512 MiB memory limit, one CPU, 64 processes and 64 MiB tmpfs. Only the owned workspace volume is mounted. Configuration is delivered through the private attached stdin before the guest execs the program; it is absent from host argv, container environment metadata, workspace files and persistent container logs.
- Session output and stderr are bounded. The standard MCP client handles initialization, tools, documents, templates, schemas and results with no sampling/elicitation capabilities advertised. Existing pagination, tool fingerprints, role scopes and app-selection revisions still apply. Every call opens a fresh session and rechecks the tool schema before dispatch.
- Ask each time is the default. Allow reads is available only when explicitly chosen for a server-declared read tool. That declaration is a trust claim, not a filesystem security boundary. Startup itself can change shared workspace files; only configure trusted programs.
- Close, cancellation and computer takeover freeze then kill all workload processes before removing the session container. A private SQLite journal permits cleanup after an actual owner-process crash. Startup reaps leftover sessions before serving work. A fixed guest timeout also bounds sessions after host loss. Failed cleanup prevents restore-point copying and normal control completion rather than silently continuing with live writers.
- A dispatched action with no confirmed result remains uncertain and cannot be automatically replayed. Cleanup does not undo a write already performed. The same reviewed-action continuation used by HTTP connectors runs once after a confirmed local result.

## Verification

`npm run apps:local:test` exercises real Docker discovery, explicit launch, encrypted/filtered environment, non-root execution, no direct network, an actual Unicode write, review enforcement, receipt reuse, takeover against double-forked descendants, an interrupted write and actual server-process SIGKILL recovery. It uses an original Python standard-library MCP fixture.

`npm run apps:local:test:ui` uses the real HTTP server, worker, controlled model and Docker on desktop/phone browser sizes. It tests discovery before saving, masked saved values, cancellation during slow initialization, retained chat drafts, actual read → exact write review → continuation, accessibility and viewport fit. `:mac` runs the same flow in the packaged Mac client. The Mac acceptance timeout accommodates actual asynchronous Docker work, rather than the test library's default five-second UI assertion.

`npm run apps:local:test:ios` uses native iPhone WebKit, an isolated HTTPS server, the same Docker tool backend and a disposable Simulator. It connects a program, grants read policy, preserves the draft, approves the proposed write and verifies its actual workspace bytes plus the assistant continuation. This is not physical-device or Android certification.

The existing HTTP/OAuth browser journeys and the real eight-check computer-runtime regression also pass. Node tests cover launch validation, credential binding/redaction, explicit startup, disabled-computer behavior, blocked owner input with recoverable cleanup failure, and refusal to copy a restore point when local writers cannot be stopped. See VERIFICATION.md and the local-tools evidence receipts for exact runs.

## Remaining scope

This supports stdio actions, document reads and owner-chosen prompt templates for programs already installed in Relay's computer; see [APP_CONTENT.md](APP_CONTENT.md). Hosted services still use HTTP. General outbound networking, installer/marketplace flows, persistent in-memory MCP sessions, a separate document/template browser, sampling, subscriptions and interactive MCP Apps remain open. The workspace is shared with the assistant's other computer work; this is not per-app file secrecy. Live third-party programs/accounts, physical devices, Android runtime and signed distribution require separate acceptance.
