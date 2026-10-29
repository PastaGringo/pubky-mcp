// pubky-mcp: an MCP server to read and publish pubky.app posts from several
// Pubky accounts, signed in with Pubky Ring.
//
//   /mcp (MCP_PATH)                        MCP endpoint (Streamable HTTP), OAuth bearer
//   /.well-known/oauth-protected-resource  where MCP clients find the authorization server
//   /interaction/:uid                      sign-in: Pubky Ring QR code
//   /connect/:id                           linking another account
//   everything else                        oidc-provider (discovery, register, authorize, token…)

import { randomUUID } from 'node:crypto'
import express, { type Request, type Response } from 'express'
import QRCode from 'qrcode'
import { createLocalJWKSet, jwtVerify, type JWK } from 'jose'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js'
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js'
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import { MCP_PATH, MCP_URL, PORT, PUBLIC_URL, SCOPE } from './config.ts'
import { keys, provider } from './oidc.ts'
import { createMcpServer } from './mcp.ts'
import { findLinkRequest, type LinkRequest } from './links.ts'
import { linkApprovedFlow, startRingFlow, type RingFlow } from './pubky.ts'
import { messagePage, ringPage } from './pages.ts'

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', true)
app.use(hostHeaderValidation([new URL(PUBLIC_URL).hostname]))

// Avast's Web Shield (MCP_DETECTION in ashServ.dll) rewrites MCP answers that
// carry a Content-Length into "transfer-encoding: chunked" with an unframed
// body, which Node clients reject ("Invalid character in chunk size").
// Chunked answers pass (measured), so MCP answers are always chunked. Removing
// the header is not enough: Node computes a Content-Length itself when the
// whole body goes out in one end(); a Transfer-Encoding header forces chunks.
// TODO: remove once Avast ships the fix its staff announced:
// https://community.avast.com/t/invalid-http-chunked-framing-observed-during-mcp-oauth-discovery-with-avast-https-inspection/921781
// (server-side workaround first described in cronumstudio/suite-core#191).
function withoutContentLength(_req: Request, res: Response, next: () => void) {
  const isLength = (name: unknown) => String(name).toLowerCase() === 'content-length'
  const setHeader = res.setHeader.bind(res)
  res.setHeader = ((name: string, value: number | string | readonly string[]) =>
    isLength(name) ? res : setHeader(name, value)) as typeof res.setHeader
  const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => Response
  res.writeHead = ((...args: unknown[]) => {
    const i = typeof args[1] === 'string' ? 2 : 1
    const headers = args[i]
    if (Array.isArray(headers)) {
      // Either [[name, value], …] or a flat [name, value, name, value, …].
      args[i] = Array.isArray(headers[0])
        ? headers.filter(([name]) => !isLength(name))
        : headers.filter((_v, j) => j % 2 === 1 ? !isLength(headers[j - 1]) : !isLength(headers[j]))
    } else if (headers && typeof headers === 'object') {
      args[i] = Object.fromEntries(Object.entries(headers).filter(([name]) => !isLength(name)))
    }
    const status = Number(args[0])
    if (status !== 204 && status !== 304 && !res.hasHeader('transfer-encoding')) {
      setHeader('Transfer-Encoding', 'chunked')
    }
    return writeHead(...args)
  }) as typeof res.writeHead
  next()
}

const send = (res: Response, status: number, type: string, body: string) =>
  res.status(status).set({ 'content-type': type, 'cache-control': 'no-store' }).send(body)
const sendJson = (res: Response, body: unknown) => send(res, 200, 'application/json', JSON.stringify(body))
const qr = (url: string) => QRCode.toDataURL(url, { width: 280, margin: 0 })
const short = (key: string) => `${key.slice(0, 4)}…${key.slice(-4)}`

// --- Protected resource metadata (RFC 9728) ----------------------------------
const resourceMetadata = {
  resource: MCP_URL,
  authorization_servers: [PUBLIC_URL],
  scopes_supported: [SCOPE],
  bearer_methods_supported: ['header'],
  resource_name: 'Pubky (pubky.app posts)',
}
for (const path of ['/.well-known/oauth-protected-resource', `/.well-known/oauth-protected-resource${MCP_PATH}`]) {
  app.get(path, withoutContentLength, (_req, res) => sendJson(res, resourceMetadata))
}

// --- Access tokens: JWTs signed by our own authorization server ---------------
const publicJwks = createLocalJWKSet({
  keys: keys.jwks.keys.map(({ kty, n, e, kid, alg, use }) => ({ kty, n, e, kid, alg, use }) as JWK),
})

const verifier: OAuthTokenVerifier = {
  async verifyAccessToken(token) {
    try {
      const { payload } = await jwtVerify(token, publicJwks, { issuer: PUBLIC_URL, audience: MCP_URL })
      if (typeof payload.sub !== 'string') throw new InvalidTokenError('token has no subject')
      return {
        token,
        clientId: String(payload.client_id ?? ''),
        scopes: String(payload.scope ?? '').split(' ').filter(Boolean),
        expiresAt: payload.exp,
        resource: new URL(MCP_URL),
        extra: { sub: payload.sub },
      }
    } catch (e) {
      if (e instanceof InvalidTokenError) throw e
      throw new InvalidTokenError('invalid or expired access token')
    }
  },
}

const bearer = requireBearerAuth({
  verifier,
  requiredScopes: [SCOPE],
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(MCP_URL)),
  expectedResource: new URL(MCP_URL),
})

// --- MCP endpoint ---------------------------------------------------------------
// One transport and one McpServer per MCP session; a session belongs to the
// operator whose token opened it, and no other token may use it.
const sessions = new Map<string, { operator: string; transport: StreamableHTTPServerTransport }>()

const operatorOf = (req: Request) => String(req.auth?.extra?.sub ?? '')

async function handleMcp(req: Request, res: Response) {
  const operator = operatorOf(req)
  const sessionId = req.header('mcp-session-id')
  if (sessionId) {
    const session = sessions.get(sessionId)
    if (!session) return res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null })
    if (session.operator !== operator) return res.status(403).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session belongs to another account' }, id: null })
    return session.transport.handleRequest(req, res, req.body)
  }
  if (req.method !== 'POST') return res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'No session' }, id: null })
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { operator, transport })
    },
  })
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId)
  }
  await createMcpServer(operator).connect(transport)
  await transport.handleRequest(req, res, req.body)
}

app.all(MCP_PATH, withoutContentLength, bearer, express.json({ limit: '1mb' }), (req, res, next) => {
  handleMcp(req, res).catch(next)
})

// --- Sign-in: the authorization server's only login step ------------------------
// interaction uid -> Pubky Ring flow. The flow asks for posting capabilities,
// so signing in also links the signed-in account.
const loginFlows = new Map<string, RingFlow>()

async function handleInteraction(req: Request, res: Response, uid: string, action?: string) {
  const details = await provider.interactionDetails(req, res)
  if (details.uid !== uid) return send(res, 400, 'text/plain; charset=utf-8', 'Unknown interaction.')

  if (details.prompt.name === 'consent') {
    // Scanning the QR code with Pubky Ring, which shows the capabilities, is
    // the consent: grant what the client asked for.
    const accountId = details.session?.accountId
    if (!accountId) return send(res, 400, 'text/plain; charset=utf-8', 'No signed-in account.')
    const grant = details.grantId
      ? await provider.Grant.find(details.grantId)
      : new provider.Grant({ accountId, clientId: String(details.params.client_id) })
    if (!grant) return send(res, 400, 'text/plain; charset=utf-8', 'Grant not found.')
    const missing = details.prompt.details as {
      missingOIDCScope?: string[]
      missingOIDCClaims?: string[]
      missingResourceScopes?: Record<string, string[]>
    }
    if (missing.missingOIDCScope) grant.addOIDCScope(missing.missingOIDCScope.join(' '))
    if (missing.missingOIDCClaims) grant.addOIDCClaims(missing.missingOIDCClaims)
    for (const [resource, scopes] of Object.entries(missing.missingResourceScopes ?? {})) {
      grant.addResourceScope(resource, scopes.join(' '))
    }
    const grantId = await grant.save()
    return provider.interactionFinished(req, res, { consent: details.grantId ? {} : { grantId } }, { mergeWithLastSubmission: true })
  }

  if (details.prompt.name !== 'login') return send(res, 400, 'text/plain; charset=utf-8', `Unsupported step: ${details.prompt.name}`)

  if (action === 'status') {
    const state = loginFlows.get(uid)
    if (!state || state.expires < Date.now()) return sendJson(res, { state: 'expired' })
    if (state.error) return sendJson(res, { state: 'error', message: state.error })
    return sendJson(res, state.key ? { state: 'next', next: `/interaction/${uid}/complete` } : { state: 'waiting' })
  }

  if (action === 'complete') {
    const state = loginFlows.get(uid)
    if (!state?.key) return send(res, 409, 'text/plain; charset=utf-8', 'Sign-in not approved yet.')
    loginFlows.delete(uid)
    await linkApprovedFlow(state.key, state)
    return provider.interactionFinished(req, res, { login: { accountId: state.key } }, { mergeWithLastSubmission: false })
  }

  // Show the QR code. Reloading the page starts a fresh flow.
  const state = startRingFlow(true)
  loginFlows.set(uid, state)
  return send(
    res,
    200,
    'text/html; charset=utf-8',
    ringPage({
      title: 'Sign in with Pubky Ring',
      lead: 'Scan this code with Pubky Ring and approve. This account can then read and publish pubky.app posts through your AI assistant.',
      qr: await qr(state.url),
      link: state.url,
      statusUrl: `/interaction/${uid}/status`,
    }),
  )
}

app.get(/^\/interaction\/([\w-]+)(?:\/(status|complete))?$/, (req, res, next) => {
  const [uid, action] = [req.params[0], req.params[1]]
  handleInteraction(req, res, uid, action).catch((e: unknown) => {
    console.error('interaction', e)
    if (!res.headersSent) send(res, 400, 'text/plain; charset=utf-8', `Invalid or expired sign-in session: ${e instanceof Error ? e.message : String(e)}`)
    else next(e)
  })
})

setInterval(() => {
  const now = Date.now()
  for (const [uid, state] of loginFlows) if (state.expires < now) loginFlows.delete(uid)
}, 60_000).unref()

// --- Linking another account -----------------------------------------------------
async function connectStep(request: LinkRequest) {
  if (request.linked) {
    return { state: 'done', message: `Linked ${short(request.linked)}. You can close this page and go back to your assistant.` }
  }
  if (request.error) return { state: 'error', message: request.error }

  if (!request.verified) {
    const flow = request.verifyFlow
    if (flow?.key) {
      if (flow.key !== request.operator) {
        request.error = `This is not the account that connected your assistant (expected ${short(request.operator)}).`
        return { state: 'error', message: request.error }
      }
      request.verified = true
    } else if (flow?.error) {
      return { state: 'error', message: flow.error }
    } else {
      return { state: 'waiting' }
    }
  }

  if (!request.linkFlow) {
    request.linkFlow = startRingFlow(true)
    return {
      state: 'waiting',
      title: 'Approve the account to link',
      lead: 'In Pubky Ring, choose the account to link, then approve. Your assistant will be able to publish as it.',
      qr: await qr(request.linkFlow.url),
      link: request.linkFlow.url,
    }
  }
  const flow = request.linkFlow
  if (flow.error) return { state: 'error', message: flow.error }
  if (!flow.key) return { state: 'waiting' }
  await linkApprovedFlow(request.operator, flow)
  request.linked = flow.key
  await request.onDone?.().catch(() => undefined) // the client may be gone; the link stands
  return { state: 'done', message: `Linked ${short(flow.key)}. You can close this page and go back to your assistant.` }
}

app.get('/connect/:id/status', (req, res, next) => {
  const request = findLinkRequest(req.params.id)
  if (!request) return sendJson(res, { state: 'expired' })
  connectStep(request).then((step) => sendJson(res, step), next)
})

app.get('/connect/:id', async (req, res, next) => {
  try {
    const request = findLinkRequest(req.params.id)
    if (!request) return send(res, 410, 'text/html; charset=utf-8', messagePage('Link expired', 'Ask your assistant to run link_account again.'))

    // Same browser that signed in: its session cookie proves the operator.
    if (!request.verified) {
      const session = await provider.Session.get(provider.createContext(req, res))
      if (session.accountId === request.operator) request.verified = true
    }
    if (request.verified) {
      if (!request.linkFlow || request.linkFlow.error || request.linkFlow.expires < Date.now()) request.linkFlow = undefined
      const step = await connectStep(request)
      if (step.state === 'done' || step.state === 'error') {
        return send(res, 200, 'text/html; charset=utf-8', messagePage(step.state === 'done' ? 'Account linked' : 'Linking failed', step.message ?? ''))
      }
      const flow = request.linkFlow
      if (!flow) throw new Error('no link flow')
      return send(res, 200, 'text/html; charset=utf-8', ringPage({
        title: 'Approve the account to link',
        lead: 'In Pubky Ring, choose the account to link, then approve. Your assistant will be able to publish as it.',
        qr: await qr(flow.url),
        link: flow.url,
        statusUrl: `/connect/${request.id}/status`,
      }))
    }

    // Another browser: confirm the operator with Pubky Ring first (no capabilities).
    if (!request.verifyFlow || request.verifyFlow.error || request.verifyFlow.expires < Date.now()) {
      request.verifyFlow = startRingFlow(false)
    }
    return send(res, 200, 'text/html; charset=utf-8', ringPage({
      title: 'First, confirm it is you',
      lead: `Approve with the account that connected your assistant (${short(request.operator)}). This gives no access; it only proves who opened this page.`,
      qr: await qr(request.verifyFlow.url),
      link: request.verifyFlow.url,
      statusUrl: `/connect/${request.id}/status`,
    }))
  } catch (e) {
    next(e)
  }
})

app.get('/healthz', (_req, res) => send(res, 200, 'text/plain', 'ok'))

// RFC 8414 metadata: the same document as OpenID discovery, under the OAuth name.
app.get('/.well-known/oauth-authorization-server', (req, _res, next) => {
  req.url = '/.well-known/openid-configuration'
  next()
})

// Everything else is the authorization server.
app.use(provider.callback())

app.listen(PORT, () => console.log(`pubky-mcp at ${PUBLIC_URL} (port ${PORT}), MCP endpoint ${MCP_URL}`))
