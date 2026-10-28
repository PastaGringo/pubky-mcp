// Requests to link another Pubky account to an operator, opened from the MCP
// client (URL-mode elicitation) and completed on the /connect page.
//
// The MCP spec requires that the person completing the page is the operator
// who asked (otherwise anyone handed the link could attach their account to
// someone else's connection). The page checks the browser's sign-in session,
// and when there is none, asks the operator to confirm with Pubky Ring first.

import { randomBytes } from 'node:crypto'
import { FLOW_TTL_MS, type RingFlow } from './pubky.ts'

export type LinkRequest = {
  id: string
  operator: string
  expires: number
  verified: boolean
  verifyFlow?: RingFlow
  linkFlow?: RingFlow
  linked?: string
  error?: string
  // Tells the MCP client the out-of-band step is over (elicitation completion).
  onDone?: () => Promise<void>
}

const requests = new Map<string, LinkRequest>()

export function createLinkRequest(operator: string): LinkRequest {
  const request: LinkRequest = {
    id: randomBytes(24).toString('base64url'),
    operator,
    expires: Date.now() + FLOW_TTL_MS,
    verified: false,
  }
  requests.set(request.id, request)
  return request
}

export function findLinkRequest(id: string): LinkRequest | undefined {
  const request = requests.get(id)
  if (!request || request.expires < Date.now()) return undefined
  return request
}

setInterval(() => {
  const now = Date.now()
  for (const [id, request] of requests) if (request.expires < now) requests.delete(id)
}, 60_000).unref()
