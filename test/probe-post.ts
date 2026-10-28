// Restart check: with a token saved by the e2e test (E2E_DEBUG_TOKEN_FILE),
// after the service restarted, the stored session alone must still publish.
import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const [url, tokenFile] = [process.argv[2], process.argv[3]]
const token = readFileSync(tokenFile, 'utf8')
const sub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub as string
const client = new Client({ name: 'probe-post', version: '0' })
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
const text = async (name: string, args: Record<string, unknown>) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
  return { text: r.content[0].text, isError: r.isError === true }
}
const posted = await text('create_post', { accounts: [sub], content: 'pubky-mcp restart check' })
const uri = (JSON.parse(posted.text) as { uri?: string; error?: string }[])[0]
console.log('create_post after restart:', uri.uri ? 'ok' : `FAILED ${uri.error}`)
if (uri.uri) console.log('delete_post:', (await text('delete_post', { account: sub, uri: uri.uri })).isError ? 'FAILED' : 'ok')
await client.close()
process.exit(uri.uri ? 0 : 1)
