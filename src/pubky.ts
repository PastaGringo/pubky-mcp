// Everything that talks to the Pubky network: Pubky Ring sign-in flows, the
// stored homeserver sessions, and writing pubky.app posts.

import { Pubky, AuthFlowKind, PublicKey, type Path, type Session } from '@synonymdev/pubky'
import { PubkySpecsBuilder, PubkyAppPostEmbed, PubkyAppPostKind } from 'pubky-app-specs'
import { ALLOWED_HOMESERVERS, CAPABILITIES, NEXUS_URL, PUBKY_RELAY, PUBKY_TESTNET } from './config.ts'
import { accountSecret, saveAccount } from './db.ts'

export const pubky = PUBKY_TESTNET ? Pubky.testnet(PUBKY_TESTNET) : new Pubky()

// How long a QR code stays valid before its flow is dropped.
export const FLOW_TTL_MS = 10 * 60 * 1000

export type RingFlow = {
  url: string
  expires: number
  // Set once Pubky Ring has approved: the approving key, and for a flow that
  // asked for capabilities, the session secret to store.
  key?: string
  secret?: string
  error?: string
}

// Starts a Pubky Ring flow and resolves it in the background.
// With capabilities: a homeserver session that can write posts.
// Without: only proves which key approved (used to confirm the operator).
export function startRingFlow(withCapabilities: boolean): RingFlow {
  const flow = pubky.startCookieAuthFlow(withCapabilities ? CAPABILITIES : '', AuthFlowKind.signin(), PUBKY_RELAY)
  const state: RingFlow = { url: flow.authorizationUrl, expires: Date.now() + FLOW_TTL_MS }
  const settle = withCapabilities
    ? flow.awaitApproval().then(async (session) => {
        state.secret = await session.exportLocalSecret()
        return session.info.publicKey.z32()
      })
    : flow.awaitToken().then((token) => token.publicKey.z32())
  settle
    .then(async (key) => {
      const refusal = await homeserverRefusal(key)
      if (refusal) {
        state.secret = undefined
        state.error = refusal
        return
      }
      state.key = key
    })
    .catch((e: unknown) => {
      state.error = e instanceof Error ? e.message : String(e)
    })
  return state
}

async function homeserverRefusal(key: string): Promise<string | undefined> {
  if (!ALLOWED_HOMESERVERS.length) return undefined
  // Where the user's own pkarr record says their homeserver is.
  const home = await pubky.getHomeserverOf(PublicKey.from(key))
  if (!home || !ALLOWED_HOMESERVERS.includes(home.z32())) {
    return 'this Pubky account is not hosted on a homeserver allowed here'
  }
  return undefined
}

// Stores an approved flow's session as an account of `operator`, and asks
// Nexus to index it so its posts show up on pubky.app.
export async function linkApprovedFlow(operator: string, state: RingFlow): Promise<void> {
  if (!state.key || !state.secret) throw new Error('flow not approved')
  saveAccount(operator, state.key, state.secret)
  // Best effort: Nexus also finds the account by itself through its homeserver.
  await fetch(`${NEXUS_URL}/v0/ingest/${state.key}`, { method: 'PUT', signal: AbortSignal.timeout(5000) }).catch(
    () => undefined,
  )
}

export class AccountError extends Error {}

async function sessionFor(operator: string, account: string): Promise<Session> {
  let secret: string | undefined
  try {
    secret = accountSecret(operator, account)
  } catch {
    // AES-GCM refuses it: SESSION_ENCRYPTION_KEY changed since it was stored.
    throw new AccountError(`the stored session of ${account} cannot be decrypted with the current key; link it again`)
  }
  if (!secret) throw new AccountError(`${account} is not linked to this connection; use list_accounts`)
  try {
    return await pubky.restoreSession(secret)
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    throw new AccountError(`the session of ${account} could not be restored (${detail}); link it again`)
  }
}

// Nexus reports a post's kind as a lowercase name ("short", "image"…).
const KINDS: Record<string, PubkyAppPostKind> = {
  short: PubkyAppPostKind.Short,
  long: PubkyAppPostKind.Long,
  image: PubkyAppPostKind.Image,
  video: PubkyAppPostKind.Video,
  link: PubkyAppPostKind.Link,
  file: PubkyAppPostKind.File,
}
function postKind(kind: string): PubkyAppPostKind {
  const value = KINDS[kind]
  if (value === undefined) throw new AccountError(`cannot repost a post of kind ${kind}`)
  return value
}

const POST_URI =/^pubky:\/\/([a-z0-9]{52})\/pub\/pubky\.app\/posts\/([0-9A-Z]{13})$/

export function parsePostUri(uri: string): { author: string; id: string } {
  const m = POST_URI.exec(uri.trim())
  if (!m) throw new AccountError(`not a pubky.app post URI: ${uri}`)
  return { author: m[1], id: m[2] }
}

// Reads a post from its author's homeserver (anonymous, no Nexus lag).
// Undefined when it does not exist.
export async function readPost(uri: string): Promise<{ kind: string; content: string } | undefined> {
  parsePostUri(uri)
  try {
    const post = JSON.parse(await pubky.publicStorage.getText(uri.trim() as `pubky://${string}/pub/${string}`)) as {
      kind?: unknown
      content?: unknown
    }
    return { kind: String(post.kind ?? ''), content: String(post.content ?? '') }
  } catch (e) {
    if (e instanceof Error && /404/.test(e.message)) return undefined
    throw e
  }
}

// Writes a short pubky.app post and returns its URI: a reply when `parent` is
// set, a repost of `embed` (a quote when `content` is not empty) when it is set.
export async function createPost(
  operator: string,
  account: string,
  content: string,
  options: { parent?: string; embed?: { uri: string; kind: string } } = {},
): Promise<string> {
  if (options.parent) parsePostUri(options.parent)
  if (options.embed) parsePostUri(options.embed.uri)
  const session = await sessionFor(operator, account)
  try {
    const embed = options.embed ? new PubkyAppPostEmbed(options.embed.uri, postKind(options.embed.kind)) : null
    const { meta, post } = new PubkySpecsBuilder(account).createPost(content, PubkyAppPostKind.Short, options.parent ?? null, embed)
    // toJson() writes absent fields as null ("parent": null, "embed": null…).
    // Both forms exist on pubky.app (measured: posts with and without the null
    // fields, all indexed by Nexus); the shorter one is written.
    const body = Object.fromEntries(
      Object.entries(post.toJson() as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined),
    )
    await session.storage.putJson(meta.path as Path, body)
    return meta.url
  } finally {
    session.free()
  }
}

export async function deletePost(operator: string, account: string, uri: string): Promise<void> {
  const { author, id } = parsePostUri(uri)
  if (author !== account) throw new AccountError(`${uri} was not written by ${account}`)
  const session = await sessionFor(operator, account)
  try {
    await session.storage.delete(`/pub/pubky.app/posts/${id}`)
  } finally {
    session.free()
  }
}

// Ends a linked account's homeserver session. Failure is not fatal: the
// stored secret is deleted by the caller either way.
export async function signOut(operator: string, account: string): Promise<void> {
  const session = await sessionFor(operator, account).catch(() => undefined)
  if (!session) return
  await session.signout().catch(() => undefined)
  session.free()
}
