# pubky-mcp

An MCP server that lets an AI assistant **read and publish pubky.app posts**,
from **several Pubky accounts**, signed in with **Pubky Ring**.

- Remote MCP server (Streamable HTTP) with its own OAuth 2.1 authorization
  server: MCP clients such as Claude Code discover it, register themselves and
  sign in without any manual setup.
- The only login step is a Pubky Ring QR code. The approving key becomes the
  operator; its posting session is stored, encrypted, on the server.
- More accounts are linked with `link_account`: a page, opened through MCP
  URL elicitation, shows a QR code for the account to add. Each linked account
  was approved by its own key in Pubky Ring.
- Posts are written to each account's homeserver in the pubky.app format and
  appear on pubky.app once Nexus has indexed them.

## Tools

| Tool | What it does |
| --- | --- |
| `list_accounts` | Accounts this connection can post as, with their Nexus name |
| `link_account` | Link another account (URL elicitation, or a link in the result) |
| `unlink_account` | End an account's stored session and forget it |
| `read_feed` | Public timeline, or what an account follows (Nexus) |
| `read_user_posts` | Latest posts of one user (Nexus) |
| `read_post` | One post and its replies (Nexus) |
| `create_post` | Publish a short post (≤ 2000 characters) or a reply, from one or several accounts |
| `delete_post` | Delete a post written by a linked account |

`create_post` takes the accounts explicitly; there is no default account.

## How it works

```
MCP client ──(Bearer JWT, aud = /mcp)──> /mcp            MCP tools
     │                                     │
     └─ OAuth: /.well-known/*, /reg, /auth, /token        oidc-provider
                         │
                 /interaction/:uid  ── Pubky Ring QR (capabilities /pub/pubky.app/posts/:rw)
                 /connect/:id       ── link another account
```

- **Authorization server**: [oidc-provider](https://github.com/panva/node-oidc-provider)
  with dynamic client registration, Client ID Metadata Documents, PKCE
  required, and JWT access tokens bound to the MCP URL (RFC 8707). Refresh
  tokens for clients registered with the `refresh_token` grant.
- **Sessions**: the Pubky Ring flow is the legacy cookie flow, the one Pubky
  Ring reads today. The session secret is stored AES-256-GCM encrypted with
  `SESSION_ENCRYPTION_KEY`, keyed by operator and account.
- **Linking**: the `/connect` page must be completed by the operator who asked
  (MCP spec, URL elicitation, phishing). The browser that signed in is
  recognised by its session cookie; any other browser must first confirm the
  operator's key with Pubky Ring (no capabilities requested).
- **Storage**: one SQLite file (`node:sqlite`, built into Node) for the OAuth
  records and the accounts.

## Run

Node 24 (TypeScript runs directly, type stripping).

```bash
pnpm install
cp .env.example .env    # set SESSION_ENCRYPTION_KEY and PUBLIC_URL
node --env-file=.env src/server.ts
```

Docker: `docker build -t pubky-mcp .`, then run with the same variables and a
volume on `/data`. Put it behind a TLS reverse proxy; `PUBLIC_URL` is the
public HTTPS address.

Add it to Claude Code:

```bash
claude mcp add --transport http pubky https://mcp.example.com/mcp
```

## Test

`test/e2e.ts` plays every part with real protocol messages: the MCP client
(discovery, registration, PKCE, refresh), the browser (cookies, redirects) and
Pubky Ring (throwaway identities that sign up and approve). It checks the
phishing protection, URL elicitation and its completion notice, the stored
format of a post (exactly `{content, kind}`), replies, refusals, deletion.

Against a local Pubky testnet (`synonymsoft/homeserver-testnet`, which needs a
PostgreSQL on its `localhost:5432` with a `root` role):

```bash
PUBKY_TESTNET=localhost node --env-file=.env src/server.ts
E2E_HOMESERVER=8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo E2E_TESTNET=localhost node test/e2e.ts
```

On the public network, with sign-up codes for the homeserver, `E2E_NEXUS=1`
also waits for Nexus to index the posts:

```bash
E2E_HOMESERVER=<key> E2E_INVITES=<code1>,<code2>,<code3> E2E_NEXUS=1 node test/e2e.ts
```

`test/probe-post.ts` checks that a stored session still publishes after a
restart.

## Known pitfalls

- **Avast breaks MCP over HTTP on the machine it protects.** Its Web Shield
  rewrites responses on paths ending in `/mcp` or `/sse`, and MCP SSE streams:
  `transfer-encoding: chunked` with an unframed body, so Node clients fail
  with `Invalid character in chunk size`. Measured on loopback (127.0.0.1,
  ::1 and the LAN address); reported by others for HTTPS too, and confirmed
  by Avast staff (fix announced, no version given). On such a machine: add
  the service's address as an Avast exception, or turn HTTPS scanning off in
  Web Shield, and run the tests inside Docker. The server stays standard on
  purpose; a measured server-side workaround (always answer chunked: Avast
  leaves chunked answers alone) is in commit 41e35c1, reverted in b8613dd.
- **`@synonymdev/pubky` replaces `globalThis.fetch`** with `fetch-cookie`
  (one cookie jar per process) when it is loaded. A test that simulates
  several browsers in one process must keep the original `fetch`.
- **`pubky-app-specs` `toJson()` writes absent fields as `null`**; pubky.app
  omits them. The service strips them before writing.
- The capability `/pub/pubky.app/posts/:rw` is enough to post and delete;
  pubky.app paths are planned to move (`/pub/pubky.app/` → `/pub/social/v1/`).
