// Persistent state in one SQLite file: the OAuth server's records and the
// linked Pubky accounts. node:sqlite ships with Node, so no native module.

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { DATA_DIR, SESSION_ENCRYPTION_KEY } from './config.ts'

mkdirSync(DATA_DIR, { recursive: true })
export const db = new DatabaseSync(join(DATA_DIR, 'pubky-mcp.db'))
db.exec(`
  pragma journal_mode = wal;
  create table if not exists oidc (
    model text not null,
    id text not null,
    payload text not null,
    grant_id text,
    uid text,
    user_code text,
    expires_at integer,
    primary key (model, id)
  );
  create index if not exists oidc_grant on oidc (grant_id);
  create index if not exists oidc_uid on oidc (uid);
  -- operator: the Pubky key that signed in to the MCP client.
  -- pubky: an account the operator may post as (the operator itself included).
  create table if not exists account (
    operator text not null,
    pubky text not null,
    secret text not null,
    linked_at integer not null,
    primary key (operator, pubky)
  );
`)

// --- Encryption of stored homeserver sessions -------------------------------
// AES-256-GCM; stored as base64url(iv).base64url(tag).base64url(ciphertext).
export function seal(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', SESSION_ENCRYPTION_KEY, iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.')
}

export function unseal(sealed: string): string {
  const [iv, tag, data] = sealed.split('.').map((s) => Buffer.from(s, 'base64url'))
  const decipher = createDecipheriv('aes-256-gcm', SESSION_ENCRYPTION_KEY, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

// --- Linked accounts ---------------------------------------------------------
export type Account = { pubky: string; linkedAt: number }

export function saveAccount(operator: string, pubky: string, secret: string): void {
  db.prepare(
    `insert into account (operator, pubky, secret, linked_at) values (?, ?, ?, ?)
     on conflict (operator, pubky) do update set secret = excluded.secret, linked_at = excluded.linked_at`,
  ).run(operator, pubky, seal(secret), Date.now())
}

export function listAccounts(operator: string): Account[] {
  return db
    .prepare('select pubky, linked_at from account where operator = ? order by linked_at')
    .all(operator)
    .map((row) => ({ pubky: String(row.pubky), linkedAt: Number(row.linked_at) }))
}

export function accountSecret(operator: string, pubky: string): string | undefined {
  const row = db.prepare('select secret from account where operator = ? and pubky = ?').get(operator, pubky)
  return row ? unseal(String(row.secret)) : undefined
}

export function deleteAccount(operator: string, pubky: string): boolean {
  return db.prepare('delete from account where operator = ? and pubky = ?').run(operator, pubky).changes > 0
}

// --- oidc-provider adapter -----------------------------------------------------
// Same contract as oidc-provider's memory adapter (lib/adapters/memory_adapter.js).
const GRANTABLE = new Set([
  'AccessToken',
  'AuthorizationCode',
  'RefreshToken',
  'DeviceCode',
  'BackchannelAuthenticationRequest',
  'PreAuthorizedCode',
])

type Payload = Record<string, unknown> & { grantId?: string; uid?: string; userCode?: string; consumed?: number }

export class SqliteAdapter {
  model: string
  constructor(model: string) {
    this.model = model
  }

  async upsert(id: string, payload: Payload, expiresIn?: number): Promise<void> {
    const expiresAt = typeof expiresIn === 'number' ? Date.now() + expiresIn * 1000 : null
    const values = [
      this.model,
      id,
      JSON.stringify(payload),
      GRANTABLE.has(this.model) ? (payload.grantId ?? null) : null,
      payload.uid ?? null,
      payload.userCode ?? null,
      expiresAt,
    ]
    if (this.model === 'ReplayDetection') {
      // Must be atomic insert-if-absent, so a replayed value is refused.
      db.prepare('delete from oidc where model = ? and id = ? and expires_at <= ?').run(this.model, id, Date.now())
      const inserted = db
        .prepare(
          `insert into oidc (model, id, payload, grant_id, uid, user_code, expires_at) values (?, ?, ?, ?, ?, ?, ?)
           on conflict do nothing`,
        )
        .run(...values)
      if (inserted.changes === 0) throw new Error('replay detected')
      return
    }
    db.prepare(
      `insert into oidc (model, id, payload, grant_id, uid, user_code, expires_at) values (?, ?, ?, ?, ?, ?, ?)
       on conflict (model, id) do update set payload = excluded.payload, grant_id = excluded.grant_id,
         uid = excluded.uid, user_code = excluded.user_code, expires_at = excluded.expires_at`,
    ).run(...values)
  }

  private row(where: string, value: string): Payload | undefined {
    const row = db
      .prepare(`select payload, expires_at from oidc where model = ? and ${where} = ?`)
      .get(this.model, value)
    if (!row) return undefined
    if (row.expires_at !== null && Number(row.expires_at) <= Date.now()) return undefined
    return JSON.parse(String(row.payload)) as Payload
  }

  async find(id: string) {
    return this.row('id', id)
  }

  async findByUid(uid: string) {
    return this.row('uid', uid)
  }

  async findByUserCode(userCode: string) {
    return this.row('user_code', userCode)
  }

  async consume(id: string): Promise<void> {
    const payload = this.row('id', id)
    if (!payload) return
    payload.consumed = Math.floor(Date.now() / 1000)
    db.prepare('update oidc set payload = ? where model = ? and id = ?').run(JSON.stringify(payload), this.model, id)
  }

  async destroy(id: string): Promise<void> {
    db.prepare('delete from oidc where model = ? and id = ?').run(this.model, id)
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    db.prepare('delete from oidc where grant_id = ?').run(grantId)
  }
}

// Expired rows are ignored on read; sweep them now and then.
setInterval(() => {
  db.prepare('delete from oidc where expires_at is not null and expires_at <= ?').run(Date.now())
}, 10 * 60 * 1000).unref()
