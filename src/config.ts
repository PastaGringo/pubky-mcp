// Configuration, read once from the environment.

import type { Capabilities } from '@synonymdev/pubky'

const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback
  if (value === undefined || value === '') throw new Error(`Missing environment variable: ${name}`)
  return value
}

export const PORT = Number(env('PORT', '4100'))
// Public base URL of this service: it is both the OAuth issuer and the host of
// the MCP endpoint. No trailing slash.
export const PUBLIC_URL = env('PUBLIC_URL', `http://localhost:${PORT}`).replace(/\/$/, '')
// Path of the MCP endpoint. Locally, some antivirus software (Avast measured)
// rewrites the responses of any path ending in /mcp or /sse, which breaks the
// HTTP framing: tests on such a machine use another path.
export const MCP_PATH = env('MCP_PATH', '/mcp')
if (!/^\/[\w-]+$/.test(MCP_PATH)) throw new Error('MCP_PATH must look like /mcp')
export const MCP_URL = `${PUBLIC_URL}${MCP_PATH}`
export const DATA_DIR = env('DATA_DIR', './data')
export const NEXUS_URL = env('NEXUS_URL', 'https://nexus.pubky.app').replace(/\/$/, '')
export const PUBKY_RELAY = process.env.PUBKY_RELAY || null
// Host of a local Pubky testnet (pkarr relay, HTTP relay, homeserver), for
// tests only. Unset: the public Pubky network.
export const PUBKY_TESTNET = process.env.PUBKY_TESTNET || null

// What each linked account lets this service do on its homeserver: write
// pubky.app posts (and delete them). Shown to the user by Pubky Ring.
const capabilities = env('PUBKY_CAPABILITIES', '/pub/pubky.app/posts/:rw')
if (!/^\/[^,:]*:(r|w|rw)(,\/[^,:]*:(r|w|rw))*$/.test(capabilities)) {
  throw new Error('PUBKY_CAPABILITIES must look like /pub/pubky.app/posts/:rw (comma-separated)')
}
export const CAPABILITIES = capabilities as Capabilities

// Optional: only accounts hosted on one of these homeservers (z-base-32 keys,
// comma-separated) may sign in or be linked. Empty: any Pubky account.
export const ALLOWED_HOMESERVERS = (process.env.ALLOWED_HOMESERVERS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

// 32 bytes, base64. Encrypts the stored homeserver sessions: a copy of the
// database alone does not let anyone post.
const sessionKey = Buffer.from(env('SESSION_ENCRYPTION_KEY'), 'base64')
if (sessionKey.length !== 32) throw new Error('SESSION_ENCRYPTION_KEY must be 32 bytes, base64-encoded')
export const SESSION_ENCRYPTION_KEY = sessionKey

// The single OAuth scope this MCP server understands: act on the linked accounts.
export const SCOPE = 'pubky'
