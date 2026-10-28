// The MCP tools. One McpServer per MCP session, bound to the operator: the
// Pubky key that signed in to the MCP client (the access token's `sub`).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as z from 'zod'
import { PUBLIC_URL } from './config.ts'
import { deleteAccount, listAccounts } from './db.ts'
import { createLinkRequest } from './links.ts'
import * as nexus from './nexus.ts'
import { AccountError, createPost, deletePost, parsePostUri, signOut } from './pubky.ts'

const pubkyKey = z.string().regex(/^[a-z0-9]{52}$/, 'a Pubky public key: 52 characters of z-base-32')
const postUri = z.string().describe('pubky.app post URI: pubky://<author>/pub/pubky.app/posts/<id>')
const limit = z.number().int().min(1).max(nexus.MAX_LIMIT).optional()

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
})
const failure = (message: string) => ({ ...text(message), isError: true })

export function createMcpServer(operator: string): McpServer {
  const server = new McpServer({ name: 'pubky-mcp', version: '0.1.0' })

  const linked = () => new Set(listAccounts(operator).map((a) => a.pubky))

  server.registerTool(
    'list_accounts',
    {
      title: 'List linked Pubky accounts',
      description:
        'Pubky accounts this connection can post as. The account that signed in is always one of them; link more with link_account.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const accounts = await Promise.all(
        listAccounts(operator).map(async (a) => ({
          pubky: a.pubky,
          name: (await nexus.userName(a.pubky)) ?? null,
          signed_in: a.pubky === operator,
          linked_at: new Date(a.linkedAt).toISOString(),
        })),
      )
      return text(accounts)
    },
  )

  server.registerTool(
    'link_account',
    {
      title: 'Link another Pubky account',
      description:
        'Opens a page where the user approves, with Pubky Ring, another account this connection may post as. ' +
        'Call list_accounts afterwards to see it.',
    },
    async () => {
      const request = createLinkRequest(operator)
      const url = `${PUBLIC_URL}/connect/${request.id}`
      const message = 'Approve, with Pubky Ring, the Pubky account to link. The page also confirms that you are the one who connected.'
      if (server.server.getClientCapabilities()?.elicitation?.url) {
        request.onDone = server.server.createElicitationCompletionNotifier(request.id)
        const answer = await server.server.elicitInput({ mode: 'url', elicitationId: request.id, url, message })
        if (answer.action !== 'accept') return failure(`Linking ${answer.action === 'decline' ? 'declined' : 'cancelled'}.`)
        return text(`The link page is open. Once approved in Pubky Ring, the account appears in list_accounts. Link: ${url}`)
      }
      return text(`Open this page in a browser to link an account (valid 10 minutes): ${url}`)
    },
  )

  server.registerTool(
    'unlink_account',
    {
      title: 'Unlink a Pubky account',
      description: 'Ends the stored homeserver session of a linked account and forgets it.',
      inputSchema: { account: pubkyKey },
      annotations: { destructiveHint: true },
    },
    async ({ account }) => {
      if (!linked().has(account)) return failure(`${account} is not linked.`)
      await signOut(operator, account)
      deleteAccount(operator, account)
      return text(`${account} unlinked.`)
    },
  )

  server.registerTool(
    'read_feed',
    {
      title: 'Read a pubky.app feed',
      description:
        "Latest posts from Nexus, the index behind pubky.app. source 'all' is the public timeline; 'following' is what `account` follows.",
      inputSchema: {
        source: z.enum(['all', 'following']).default('all'),
        account: pubkyKey.optional().describe("for source 'following': whose feed (defaults to the signed-in account)"),
        limit,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ source, account, limit }) => {
      const query =
        source === 'following' ? { source, observer_id: account ?? operator, limit } : { source, limit }
      return text(await nexus.streamPosts(query))
    },
  )

  server.registerTool(
    'read_user_posts',
    {
      title: "Read a user's posts",
      description: 'Latest posts written by one Pubky user, as indexed by Nexus.',
      inputSchema: { user: pubkyKey, limit },
      annotations: { readOnlyHint: true },
    },
    async ({ user, limit }) => text(await nexus.streamPosts({ source: 'author', author_id: user, limit })),
  )

  server.registerTool(
    'read_post',
    {
      title: 'Read a post and its replies',
      description: 'One pubky.app post and its latest replies, from Nexus.',
      inputSchema: { uri: postUri, limit },
      annotations: { readOnlyHint: true },
    },
    async ({ uri, limit }) => {
      const { author, id } = parsePostUri(uri)
      const post = await nexus.post(author, id)
      if (!post) return failure('Nexus does not know this post (not indexed yet, or it does not exist).')
      const replies = await nexus.streamPosts({ source: 'post_replies', author_id: author, post_id: id, limit })
      return text({ post, replies })
    },
  )

  server.registerTool(
    'create_post',
    {
      title: 'Publish a post',
      description:
        'Publishes a short pubky.app post (at most 2000 characters) from each listed account, or a reply when reply_to is set. ' +
        'Always name the accounts explicitly. The post appears on pubky.app once Nexus has indexed it, usually within a minute.',
      inputSchema: {
        accounts: z.array(pubkyKey).min(1).describe('accounts to post as; see list_accounts'),
        content: z.string().min(1).max(2000),
        reply_to: postUri.optional(),
      },
    },
    async ({ accounts, content, reply_to }) => {
      const known = linked()
      const results = []
      for (const account of new Set(accounts)) {
        if (!known.has(account)) {
          results.push({ account, error: 'not linked to this connection' })
          continue
        }
        try {
          results.push({ account, uri: await createPost(operator, account, content, reply_to) })
        } catch (e) {
          results.push({ account, error: e instanceof Error ? e.message : String(e) })
        }
      }
      const failed = results.filter((r) => 'error' in r).length
      return { ...text(results), isError: failed === results.length }
    },
  )

  server.registerTool(
    'delete_post',
    {
      title: 'Delete a post',
      description: 'Deletes a post written by one of the linked accounts.',
      inputSchema: { account: pubkyKey, uri: postUri },
      annotations: { destructiveHint: true },
    },
    async ({ account, uri }) => {
      if (!linked().has(account)) return failure(`${account} is not linked.`)
      try {
        await deletePost(operator, account, uri)
        return text(`Deleted ${uri}.`)
      } catch (e) {
        if (e instanceof AccountError) return failure(e.message)
        throw e
      }
    },
  )

  return server
}
