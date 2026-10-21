# Security and deployment scope

Relay is a single-owner self-hosted application. Run it on loopback or behind HTTPS with `RELAY_ACCESS_KEY` configured. Never expose an unprotected service to a public network.

Google OAuth uses PKCE and one-use, cookie-bound state. Tokens are encrypted with the owner's server key; API state and workspace exports exclude token secrets. Read-only and reviewed-write scopes are separate choices. Disconnect invalidates pending account-bound reviews.

The model cannot execute approvals. External mail/calendar writes and Docker commands wait for an owner decision. Unknown write outcomes require checking the provider before creating a new action. Content from mail, websites, PDFs, and memory is untrusted source data.

The browser uses a separate profile and public GET/HEAD traffic. It does not import personal browser sessions. The browser process itself is not a security boundary equivalent to a dedicated VM; deploy under a restricted OS identity. The optional terminal requires Docker and validates offline, non-root, read-only, bounded container configuration without host mounts.

Keep the workspace database, backups, browser profile, environment file, access key, and token-encryption key private. The database and its parent directory use restrictive permissions when created by the app. Third-party model providers receive the conversation/tool context needed for the requested work; choose the provider accordingly.

Report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/duolahypercho/relay-assistant/security/advisories/new). Include the affected version, reproduction steps and impact using fictional data. Do not include live credentials or private workspace data in a public issue. This early development release has no guaranteed response-time or long-term-support commitment.
