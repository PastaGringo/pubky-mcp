// Reads from Nexus, the indexer behind pubky.app. Anonymous, no session needed.
// Nexus lags behind the homeservers: a post just written is not there yet.

import { NEXUS_URL } from './config.ts'

// Nexus refuses larger pages (40 measured as 400, 20 accepted).
export const MAX_LIMIT = 20

type NexusPost = {
  details: { id: string; uri: string; author: string; content: string; kind: string; indexed_at: number; deleted: boolean }
  counts?: { replies?: number; reposts?: number; tags?: number }
  relationships?: { replied?: string | null }
  tags?: { label: string; taggers_count: number }[]
}

export type Post = {
  uri: string
  author: string
  content: string
  kind: string
  indexed_at: string
  replies: number
  reply_to?: string
  tags: string[]
}

function simplify(p: NexusPost): Post {
  return {
    uri: p.details.uri,
    author: p.details.author,
    content: p.details.content,
    kind: p.details.kind,
    indexed_at: new Date(p.details.indexed_at).toISOString(),
    replies: p.counts?.replies ?? 0,
    ...(p.relationships?.replied ? { reply_to: p.relationships.replied } : {}),
    tags: (p.tags ?? []).map((t) => t.label),
  }
}

async function get(path: string, query: Record<string, string | number | undefined>): Promise<unknown> {
  const url = new URL(`${NEXUS_URL}/v0/${path}`)
  for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v))
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
  if (res.status === 404) return undefined
  if (!res.ok) throw new Error(`Nexus answered ${res.status} for ${url.pathname}`)
  return res.json()
}

const clamp = (limit: number | undefined) => Math.min(Math.max(1, limit ?? 10), MAX_LIMIT)

export async function streamPosts(query: Record<string, string | number | undefined>): Promise<Post[]> {
  const posts = (await get('stream/posts', { ...query, limit: clamp(query.limit as number | undefined) })) as
    | NexusPost[]
    | undefined
  // A deleted post stays in Nexus with its content set to "[DELETED]".
  return (posts ?? []).filter((p) => !p.details.deleted).map(simplify)
}

export async function post(author: string, id: string): Promise<Post | undefined> {
  const p = (await get(`post/${author}/${id}`, {})) as NexusPost | undefined
  return p ? simplify(p) : undefined
}

export async function userName(pubky: string): Promise<string | undefined> {
  const u = (await get(`user/${pubky}`, {}).catch(() => undefined)) as { details?: { name?: string } } | undefined
  return u?.details?.name
}
