# App directory

**More → Connect apps** now offers searchable hosted apps alongside existing connections. Search by name or purpose, choose **Connect**, then sign in and review the tools. No server address needs to be typed. The primary connection form keeps technical details collapsed. **Add an app** still accepts a custom address or a program inside Relay’s computer.

Browsing and searching use the bundled directory; they send no requests to the listed services. Selecting a service starts the existing real MCP preparation check. An unreachable service stays an inline error; cancellation saves nothing. Authentication begins only from **Sign in with browser**, and tool access begins only after explicit connection review. Tool policies still default to Ask each time, and every write uses the existing exact action-review flow.

An already connected endpoint shows **Manage** and opens its saved connection, even if it was renamed or paused. It does not register a new client or create a duplicate connection. Connection details disclose the address and official guide; the owner can reveal address editing. Directory entries do not contain tokens or grant permissions. They are not stored in exported workspace state or offered as already connected tools to the model.

## Sources and scope

The interaction is informed by [Grok Bot’s Connect apps flow](https://docs.x.ai/grok-bot/computer-and-apps). Endpoint data comes directly from the service publishers. Implementation, copy and letter icons are original; no competitor code or artwork is included.

| App     | Official endpoint            | Publisher documentation                                                                                                                                                         |
| ------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Notion  | `https://mcp.notion.com/mcp` | [Connect to Notion MCP](https://developers.notion.com/guides/mcp/get-started-with-mcp), [custom client requirements](https://developers.notion.com/guides/mcp/build-mcp-client) |
| Todoist | `https://ai.todoist.net/mcp` | [Todoist developer platform](https://developer.todoist.com/)                                                                                                                    |
| Linear  | `https://mcp.linear.app/mcp` | [Linear MCP](https://linear.app/docs/mcp)                                                                                                                                       |
| Sentry  | `https://mcp.sentry.dev/mcp` | [Sentry MCP](https://mcp.sentry.dev/)                                                                                                                                           |

All four public endpoints have been checked through Relay’s actual preparation code and OAuth discovery. They reject unauthenticated initialization and publish matching resource metadata, dynamic registration endpoints and PKCE S256 support. This probe performs no registration, login, account grant or tool call. See `app-directory-public-probe.json` for the observed scope and timestamp.

Provider accounts, plans, organization policies and redirect-registration acceptance still need live-account validation. Listing is not vendor certification or affiliation. Figma is intentionally not advertised as connectable: its [official client catalog](https://www.figma.com/mcp-catalog/) requires approval for new remote clients. The directory does not install packages or serve as a public plugin marketplace; these remain separate parity gates.

## Verification

- `npm run apps:directory:probe`: current, unauthenticated public protocol/metadata checks only.
- `npm run apps:directory:test:ui`: desktop and phone journeys with an independent OAuth/MCP fixture, real production server and encrypted storage. Verifies purpose search without provider traffic, inline failure/cancel/retry, real PKCE flow, declined consent, reload recovery, explicit tool review, authorized read, credential exclusion, duplicate prevention, address editing, unchanged chat/draft, accessibility and viewport fit.
- `npm run apps:directory:test:mac`: that journey in the rebuilt packaged Mac client. Production IPC validates browser launch; the OS launch is captured into an independent browser session for controlled acceptance.
- `npm run apps:directory:test:ios`: native iPhone WebKit search/selection followed by real Safari consent, tool review, encrypted credentials and retained chat draft, using a disposable Simulator and isolated HTTPS fixture.

Existing custom-address/token flows and Node tests remain required regressions. These tests do not establish physical-device, Android, real-vendor or full marketplace parity. See VERIFICATION.md for actual run results.
