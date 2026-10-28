// The OAuth 2.1 authorization server in front of the MCP endpoint.
//
// oidc-provider does the protocol: discovery, dynamic client registration and
// Client ID Metadata Documents (how MCP clients register), PKCE, and JWT access
// tokens bound to the MCP endpoint (RFC 8707). The only login step is a Pubky
// Ring QR code; the key that approves it becomes the token's `sub`.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import Provider, { errors, type KoaContextWithOIDC } from 'oidc-provider'
import { DATA_DIR, MCP_URL, PUBLIC_URL, SCOPE } from './config.ts'
import { SqliteAdapter } from './db.ts'

type Keys = { jwks: { keys: Record<string, unknown>[] }; cookies: string[] }

// The token and cookie signing keys must survive a restart, otherwise every
// issued token and every browser session becomes invalid.
function loadKeys(): Keys {
  const file = join(DATA_DIR, 'keys.json')
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Keys
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...privateKey.export({ format: 'jwk' }), use: 'sig', alg: 'RS256', kid: randomBytes(8).toString('hex') }
  const keys: Keys = { jwks: { keys: [jwk] }, cookies: [randomBytes(32).toString('base64url')] }
  writeFileSync(file, JSON.stringify(keys), { mode: 0o600 })
  return keys
}

export const keys = loadKeys()

export const provider = new Provider(PUBLIC_URL, {
  adapter: SqliteAdapter,
  jwks: keys.jwks,
  cookies: { keys: keys.cookies },
  claims: { openid: ['sub'] },
  scopes: ['openid', 'offline_access', SCOPE],
  pkce: { required: () => true },
  // MCP clients run unattended between sessions: give them a refresh token
  // whenever they registered for one, without requiring `offline_access`.
  issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed('refresh_token'),
  features: {
    devInteractions: { enabled: false },
    registration: { enabled: true },
    clientIdMetadataDocument: {
      enabled: true,
      ack: 'draft-02',
      allowFetch: async (_ctx, clientId) => clientId.startsWith('https://'),
    },
    revocation: { enabled: true },
    resourceIndicators: {
      enabled: true,
      defaultResource: async () => MCP_URL,
      useGrantedResource: async () => true,
      getResourceServerInfo: async (_ctx, resource) => {
        if (resource.replace(/\/$/, '') !== MCP_URL) throw new errors.InvalidTarget()
        return { scope: SCOPE, audience: MCP_URL, accessTokenFormat: 'jwt', accessTokenTTL: 60 * 60, jwt: { sign: { alg: 'RS256' } } }
      },
    },
  },
  interactions: { url: (_ctx: KoaContextWithOIDC, interaction) => `/interaction/${interaction.uid}` },
  async findAccount(_ctx, sub) {
    return { accountId: sub, async claims() { return { sub } } }
  },
})
// Behind a TLS reverse proxy (Traefik, Caddy, nginx): trust X-Forwarded-*.
provider.proxy = true
