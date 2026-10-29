// Witness for ALLOWED_HOMESERVERS: an identity that is not a member of the
// allowed homeserver approves the sign-in QR code; the service must refuse it.
//   PUBKY_MCP_URL  the service (its ALLOWED_HOMESERVERS set)
import { createHash, randomBytes } from 'node:crypto'

const BASE = (process.env.PUBKY_MCP_URL ?? 'http://localhost:4100').replace(/\/$/, '')
const MCP = `${BASE}${process.env.MCP_PATH ?? '/mcp'}`
const REDIRECT = 'http://localhost:9999/callback'
const rawFetch = globalThis.fetch
const { Keypair, Pubky } = await import('@synonymdev/pubky')

const cookies = new Map<string, string>()
async function get(url: string) {
  const res = await rawFetch(new URL(url, BASE), {
    redirect: 'manual',
    headers: { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
  })
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';')
    cookies.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1))
  }
  return res
}

const as = (await (await rawFetch(`${BASE}/.well-known/oauth-authorization-server`)).json()) as Record<string, string>
const reg = (await (
  await rawFetch(as.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] }),
  })
).json()) as { client_id: string }
const auth = new URL(as.authorization_endpoint)
const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url')
for (const [k, v] of Object.entries({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, scope: 'pubky', code_challenge: challenge, code_challenge_method: 'S256', resource: MCP })) auth.searchParams.set(k, v)

let url = auth.href
let res = await get(url)
while (res.headers.get('location')) {
  url = new URL(res.headers.get('location')!, url).href
  res = await get(url)
}
const html = await res.text()
const link = /id="open" class="btn" href="([^"]+)"/.exec(html)![1].replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))

// A key signed up on ANOTHER homeserver (FOREIGN_HOMESERVER, FOREIGN_INVITE):
// a key hosted nowhere fails earlier, before the membership check is reached.
const signer = new Pubky().signer(Keypair.random())
if (process.env.FOREIGN_HOMESERVER) {
  const { PublicKey } = await import('@synonymdev/pubky')
  await signer.signup(PublicKey.from(process.env.FOREIGN_HOMESERVER), process.env.FOREIGN_INVITE ?? null)
}
await signer.approveAuthRequest(link)
let state: Record<string, unknown> = { state: 'waiting' }
for (let i = 0; i < 60 && state.state === 'waiting'; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  state = (await (await get(`${url}/status`)).json()) as Record<string, unknown>
}
console.log('status after approval by a foreign key:', JSON.stringify(state))
process.exit(state.state === 'error' ? 0 : 1)
