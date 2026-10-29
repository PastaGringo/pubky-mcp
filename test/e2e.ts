// End-to-end test against a running pubky-mcp, playing every part with real
// protocol messages: the MCP client (OAuth discovery, registration, PKCE), the
// browser (cookies, redirects), and Pubky Ring (throwaway identities that sign
// up on a homeserver and approve the QR codes).
//
//   PUBKY_MCP_URL    the service (default http://localhost:4100)
//   MCP_PATH         its MCP endpoint path (default /mcp, same as the service)
//   E2E_HOMESERVER   homeserver key (z-base-32) to sign the identities up on
//   E2E_INVITES      comma-separated sign-up codes, if the homeserver needs them (two are used)
//   E2E_TESTNET      host of a local Pubky testnet (same as the service's PUBKY_TESTNET)
//   E2E_NEXUS=1      also wait for Nexus to index the posts (public network only)

import { createHash, randomBytes } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ElicitRequestSchema, ElicitationCompleteNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const BASE = (process.env.PUBKY_MCP_URL ?? 'http://localhost:4100').replace(/\/$/, '')
const MCP_PATH = process.env.MCP_PATH ?? '/mcp'
const MCP = `${BASE}${MCP_PATH}`
const HOMESERVER = process.env.E2E_HOMESERVER ?? ''
const INVITES = (process.env.E2E_INVITES ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const TESTNET = process.env.E2E_TESTNET || null
const NEXUS = process.env.E2E_NEXUS === '1'
const NEXUS_URL = 'https://nexus.pubky.app'
const REDIRECT = 'http://localhost:9999/callback'

if (!HOMESERVER) throw new Error('E2E_HOMESERVER is required')

// @synonymdev/pubky replaces globalThis.fetch with fetch-cookie when loaded
// (index.cjs), one cookie jar for the whole process. The simulated browsers
// must not share it, or a "stranger" would send the operator's cookies: keep
// the original fetch first, then load the SDK.
const rawFetch = globalThis.fetch
const { Keypair, Pubky, PublicKey } = await import('@synonymdev/pubky')
const pubky = TESTNET ? Pubky.testnet(TESTNET) : new Pubky()

let passed = 0
function check(condition: unknown, label: string): void {
  if (!condition) throw new Error(`FAILED: ${label}`)
  passed += 1
  console.log(`  ok  ${label}`)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// --- A minimal browser: a cookie jar and manual redirects ----------------------
class Browser {
  cookies = new Map<string, string>()
  async get(url: string): Promise<Response> {
    const res = await rawFetch(new URL(url, BASE), {
      redirect: 'manual',
      headers: { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    })
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const i = pair.indexOf('=')
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1))
    }
    return res
  }
  // Follows redirects until one leaves the service (the client's redirect_uri).
  async follow(url: string): Promise<{ url: string; res?: Response }> {
    let next = new URL(url, BASE).href
    for (let i = 0; i < 20; i++) {
      if (!next.startsWith(BASE)) return { url: next }
      const res = await this.get(next)
      const location = res.headers.get('location')
      if (!location) return { url: next, res }
      next = new URL(location, next).href
    }
    throw new Error('too many redirects')
  }
}

const unescape = (s: string) => s.replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
function ringLink(html: string): string {
  const m = /id="open" class="btn" href="([^"]+)"/.exec(html)
  if (!m) throw new Error('no Pubky Ring link on the page')
  return unescape(m[1])
}

// --- Pubky Ring, played by a throwaway identity --------------------------------
let invite = 0
async function newIdentity() {
  const keypair = Keypair.random()
  const signer = pubky.signer(keypair)
  await signer.signup(PublicKey.from(HOMESERVER), INVITES[invite++] ?? null)
  return { key: keypair.publicKey.z32(), approve: (url: string) => signer.approveAuthRequest(url) }
}

async function pollStatus(browser: Browser, url: string, until: (j: Record<string, unknown>) => boolean) {
  for (let i = 0; i < 60; i++) {
    const j = (await (await browser.get(url)).json()) as Record<string, unknown>
    if (until(j)) return j
    await sleep(500)
  }
  throw new Error(`timed out polling ${url}`)
}

// --- MCP client ------------------------------------------------------------------
async function connect(token: string) {
  const client = new Client({ name: 'pubky-mcp-e2e', version: '0.1.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP), { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
  )
  return client
}
type CallResult = { content: { type: string; text?: string }[]; isError?: boolean }
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as CallResult
  const raw = r.content.map((c) => c.text ?? '').join('\n')
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    json = undefined // a plain sentence, not JSON
  }
  return { raw, json, isError: r.isError === true }
}

async function main() {
  console.log(`pubky-mcp e2e against ${BASE}${TESTNET ? ` (testnet ${TESTNET})` : ''}`)

  console.log('discovery')
  const unauth = await fetch(MCP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  check(unauth.status === 401, 'MCP endpoint without a token: 401')
  check(unauth.headers.get('www-authenticate')?.includes(`resource_metadata="${BASE}/.well-known/oauth-protected-resource${MCP_PATH}"`), 'WWW-Authenticate points to the resource metadata')
  const bogus = await fetch(MCP, { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body: '{}' })
  check(bogus.status === 401, 'MCP endpoint with a forged token: 401')
  const prm = (await (await fetch(`${BASE}/.well-known/oauth-protected-resource${MCP_PATH}`)).json()) as Record<string, unknown>
  check(prm.resource === MCP && (prm.authorization_servers as string[])[0] === BASE, 'protected resource metadata names the MCP URL and the issuer')
  const as = (await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json()) as Record<string, string | string[]>
  check(as.issuer === BASE && typeof as.registration_endpoint === 'string', 'authorization server metadata (RFC 8414) with a registration endpoint')

  console.log('client registration (RFC 7591)')
  const reg = (await (
    await fetch(String(as.registration_endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'pubky-mcp e2e',
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    })
  ).json()) as { client_id: string }
  check(typeof reg.client_id === 'string', 'public client registered')

  const authorizeUrl = (resource: string, challenge: string) => {
    const u = new URL(String(as.authorization_endpoint))
    for (const [k, v] of Object.entries({
      response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, scope: 'pubky',
      code_challenge: challenge, code_challenge_method: 'S256', state: randomBytes(8).toString('hex'), resource,
    })) u.searchParams.set(k, v)
    return u.href
  }

  console.log('wrong resource is refused')
  const evil = await new Browser().follow(authorizeUrl('https://evil.example/mcp', 'x'.repeat(43)))
  check(new URL(evil.url).searchParams.get('error') === 'invalid_target', 'authorization for another resource: invalid_target')

  console.log('sign-in with Pubky Ring (identity A)')
  const browser = new Browser()
  const verifierCode = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifierCode).digest('base64url')
  const login = await browser.follow(authorizeUrl(MCP, challenge))
  check(login.res && /\/interaction\/[\w-]+$/.test(login.url), 'authorization lands on the Pubky Ring page')
  const loginHtml = await login.res!.text()
  const loginRing = ringLink(loginHtml)
  check(loginRing.startsWith('pubkyauth://signin?') && loginRing.includes('caps=%2Fpub%2Fpubky.app%2Fposts%2F%3Arw') || loginRing.includes('caps=/pub/pubky.app/posts/:rw'), 'QR asks for /pub/pubky.app/posts/:rw')
  const A = await newIdentity()
  await A.approve(loginRing)
  const approved = await pollStatus(browser, `${login.url}/status`, (j) => j.state !== 'waiting')
  check(approved.state === 'next', 'sign-in approved')
  const back = await browser.follow(String(approved.next))
  const code = new URL(back.url).searchParams.get('code')
  check(back.url.startsWith(REDIRECT) && code, 'redirected to the client with a code')

  const tokenRes = await fetch(String(as.token_endpoint), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: code!, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifierCode, resource: MCP }),
  })
  const tokens = (await tokenRes.json()) as { access_token: string; refresh_token?: string }
  const claims = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString()) as Record<string, unknown>
  check(claims.aud === MCP && claims.sub === A.key, 'JWT access token: audience is the MCP URL, subject is identity A')
  check(typeof tokens.refresh_token === 'string', 'refresh token issued')
  const refreshed = (await (
    await fetch(String(as.token_endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token!, client_id: reg.client_id, resource: MCP }),
    })
  ).json()) as { access_token?: string }
  check(typeof refreshed.access_token === 'string', 'refresh token exchanged for a new access token')

  console.log('MCP tools')
  if (process.env.E2E_DEBUG_TOKEN_FILE) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(process.env.E2E_DEBUG_TOKEN_FILE, tokens.access_token, { mode: 0o600 })
  }
  const client = await connect(tokens.access_token)
  const tools = (await client.listTools()).tools.map((t) => t.name).sort()
  check(tools.join() === 'create_post,delete_post,link_account,list_accounts,read_feed,read_post,read_user_posts,repost,unlink_account', `9 tools: ${tools.join(', ')}`)
  let accounts = (await call(client, 'list_accounts')).json as { pubky: string; signed_in: boolean }[]
  check(accounts.length === 1 && accounts[0].pubky === A.key && accounts[0].signed_in, 'list_accounts: identity A, signed in')

  console.log('link identity B from the browser that signed in')
  const linkText = (await call(client, 'link_account')).raw
  const linkUrl = /https?:\/\/\S+\/connect\/[\w-]+/.exec(linkText)?.[0]
  check(linkUrl, 'link_account gives a /connect URL (client without URL elicitation)')
  const linkPage = await (await browser.get(linkUrl!)).text()
  check(linkPage.includes('Approve the account to link'), 'same browser: no confirmation step, straight to the account QR')
  const B = await newIdentity()
  await B.approve(ringLink(linkPage))
  const linked = await pollStatus(browser, `${linkUrl}/status`, (j) => j.state !== 'waiting')
  check(linked.state === 'done', 'identity B linked')
  accounts = (await call(client, 'list_accounts')).json as { pubky: string; signed_in: boolean }[]
  check(accounts.map((a) => a.pubky).sort().join() === [A.key, B.key].sort().join(), 'list_accounts: A and B')

  console.log('a link page opened by someone else is refused')
  const phishUrl = /https?:\/\/\S+\/connect\/[\w-]+/.exec((await call(client, 'link_account')).raw)![0]
  const stranger = new Browser()
  const phishRes = await stranger.get(phishUrl)
  const phishPage = await phishRes.text()
  check(phishPage.includes('First, confirm it is you'), `other browser: asked to confirm the operator first (got ${phishRes.status}: ${phishPage.replace(/\s+/g, ' ').slice(0, 160)})`)
  await B.approve(ringLink(phishPage))
  const refused = await pollStatus(stranger, `${phishUrl}/status`, (j) => j.state !== 'waiting')
  check(refused.state === 'error' && String(refused.message).includes('not the account'), 'confirming with another identity: refused')
  const otherUrl = /https?:\/\/\S+\/connect\/[\w-]+/.exec((await call(client, 'link_account')).raw)![0]
  const otherBrowser = new Browser()
  await A.approve(ringLink(await (await otherBrowser.get(otherUrl)).text()))
  const confirmed = await pollStatus(otherBrowser, `${otherUrl}/status`, (j) => j.state !== 'waiting' || typeof j.qr === 'string')
  check(typeof confirmed.qr === 'string' && confirmed.title === 'Approve the account to link', 'confirming with identity A: moves on to the account QR')

  console.log('link identity C through URL elicitation (what Claude Code does)')
  const elicited: { url?: string; id?: string; completed?: string } = {}
  const eliciting = new Client({ name: 'pubky-mcp-e2e-elicit', version: '0.1.0' }, { capabilities: { elicitation: { url: {} } } })
  eliciting.setRequestHandler(ElicitRequestSchema, async (request) => {
    if (request.params.mode === 'url') Object.assign(elicited, { url: request.params.url, id: request.params.elicitationId })
    return { action: 'accept' }
  })
  eliciting.setNotificationHandler(ElicitationCompleteNotificationSchema, async (n) => {
    elicited.completed = n.params.elicitationId
  })
  await eliciting.connect(new StreamableHTTPClientTransport(new URL(MCP), { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } }))
  const elicitResult = await call(eliciting, 'link_account')
  check(!elicitResult.isError && elicited.url?.startsWith(`${BASE}/connect/`), 'link_account sends a URL elicitation, the client accepts')
  const C = await newIdentity()
  await C.approve(ringLink(await (await browser.get(elicited.url!)).text()))
  check((await pollStatus(browser, `${elicited.url}/status`, (j) => j.state !== 'waiting')).state === 'done', 'identity C linked')
  for (let i = 0; i < 20 && !elicited.completed; i++) await sleep(250)
  check(elicited.completed === elicited.id, 'the client is told the elicitation is complete')
  accounts = (await call(client, 'list_accounts')).json as { pubky: string; signed_in: boolean }[]
  check(accounts.some((a) => a.pubky === C.key), 'list_accounts: C is there')
  check(!(await call(client, 'unlink_account', { account: C.key })).isError, 'unlink_account C')
  await eliciting.close()

  console.log('publish')
  const content = `pubky-mcp test ${new Date().toISOString()}`
  const posted = (await call(client, 'create_post', { accounts: [A.key, B.key], content })).json as { account: string; uri?: string; error?: string }[]
  check(posted.length === 2 && posted.every((p) => p.uri?.startsWith(`pubky://${p.account}/pub/pubky.app/posts/`)), 'create_post on A and B: two post URIs')
  for (const p of posted) {
    // The raw text, as Nexus will read it: optional fields must be absent, not null.
    const raw = await pubky.publicStorage.getText(p.uri! as `pubky://${string}/pub/${string}`)
    const stored = JSON.parse(raw) as Record<string, unknown>
    check(stored.content === content && stored.kind === 'short' && Object.keys(stored).sort().join() === 'content,kind', `post of ${p.account.slice(0, 6)} readable anonymously, exactly {content, kind}: ${raw}`)
  }
  const reply = (await call(client, 'create_post', { accounts: [A.key], content: 'reply from A', reply_to: posted[1].uri })).json as { uri: string }[]
  const replyStored = JSON.parse(await pubky.publicStorage.getText(reply[0].uri as `pubky://${string}/pub/${string}`)) as Record<string, unknown>
  check(replyStored.parent === posted[1].uri, 'reply stores its parent URI')
  // Repost, as pubky.app writes one: {content, embed: {kind, uri}, kind}.
  const plain = (await call(client, 'repost', { accounts: [A.key], uri: posted[1].uri })).json as { uri: string }[]
  const plainStored = JSON.parse(await pubky.publicStorage.getText(plain[0].uri as `pubky://${string}/pub/${string}`)) as Record<string, unknown>
  check(plainStored.content === '' && plainStored.kind === 'short' && JSON.stringify(plainStored.embed) === JSON.stringify({ kind: 'short', uri: posted[1].uri }), `plain repost: ${JSON.stringify(plainStored)}`)
  const quote = (await call(client, 'repost', { accounts: [B.key], uri: posted[0].uri, comment: 'worth reading' })).json as { uri: string }[]
  const quoteStored = JSON.parse(await pubky.publicStorage.getText(quote[0].uri as `pubky://${string}/pub/${string}`)) as Record<string, unknown>
  check(quoteStored.content === 'worth reading' && (quoteStored.embed as { uri: string }).uri === posted[0].uri, 'quote repost keeps the comment and embeds the original')
  const missing = await call(client, 'repost', { accounts: [A.key], uri: `pubky://${A.key}/pub/pubky.app/posts/0035ZZZZZZZZZ` })
  check(missing.isError, 'reposting a post that does not exist: refused')
  const stray = await call(client, 'create_post', { accounts: [Keypair.random().publicKey.z32()], content: 'x' })
  check(stray.isError && stray.raw.includes('not linked'), 'posting as an unlinked account: refused')

  if (NEXUS) {
    console.log('visible on pubky.app (Nexus)')
    const [author, id] = posted[0].uri!.replace('pubky://', '').split('/pub/pubky.app/posts/')
    let status = 0
    for (let i = 0; i < 60 && status !== 200; i++) {
      status = (await fetch(`${NEXUS_URL}/v0/post/${author}/${id}`)).status
      if (status !== 200) await sleep(5000)
    }
    check(status === 200, 'Nexus indexed the post (what pubky.app reads)')
    const mine = (await call(client, 'read_user_posts', { user: A.key })).json as { uri: string }[]
    check(mine.some((p) => p.uri === posted[0].uri), 'read_user_posts finds it')
    const thread = (await call(client, 'read_post', { uri: posted[1].uri })).json as { replies: { uri: string }[] }
    check(thread.replies.some((p) => p.uri === reply[0].uri), 'read_post shows the reply')
  }

  console.log('clean up')
  for (const [account, uri] of [...posted.map((p) => [p.account, p.uri!]), [A.key, reply[0].uri], [A.key, plain[0].uri], [B.key, quote[0].uri]]) {
    const del = await call(client, 'delete_post', { account, uri })
    check(!del.isError, `delete_post ${uri.slice(-13)}`)
    const gone = await pubky.publicStorage.exists(uri as `pubky://${string}/pub/${string}`)
    check(!gone, 'post gone from the homeserver')
  }
  const unlinked = await call(client, 'unlink_account', { account: B.key })
  check(!unlinked.isError, 'unlink_account B')
  accounts = (await call(client, 'list_accounts')).json as { pubky: string; signed_in: boolean }[]
  check(accounts.length === 1 && accounts[0].pubky === A.key, 'list_accounts: A only')
  await client.close()

  console.log(`\n${passed} checks passed`)
}

main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
