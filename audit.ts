/**
 * Postal v2 append-only audit trail.
 *
 * Records decisions that affect authority or approvals: grant, revoke,
 * delivery policy, task state, and approval lifecycle. Bodies are never
 * recorded; only operation metadata.
 */
import { randomBytes } from "node:crypto"

export type AuditRecord = {
  auditID: string
  at: number
  actor: string
  action: string
  target: string
  before?: unknown
  after?: unknown
  note?: string
}

export type AuditContext = {
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    remove(key: string): Promise<void>
  }
}

export type Lock = <T>(key: string, task: () => Promise<T> | T) => Promise<T>

const AUDIT_INDEX = "audit/index"
const MAX_NOTE = 500

export function auditKey(auditID: string): string {
  return `audit/${auditID}`
}

export async function appendAudit(
  ctx: AuditContext,
  lock: Lock,
  input: {
    actor: string
    action: string
    target: string
    before?: unknown
    after?: unknown
    note?: string
    at?: number
  },
): Promise<AuditRecord> {
  const at = typeof input.at === "number" ? input.at : Date.now()
  const auditID = `${at}_${randomBytes(5).toString("hex")}`
  const record: AuditRecord = {
    auditID,
    at,
    actor: input.actor,
    action: input.action,
    target: input.target,
    ...(input.before !== undefined ? { before: input.before } : {}),
    ...(input.after !== undefined ? { after: input.after } : {}),
    ...(typeof input.note === "string" ? { note: input.note.slice(0, MAX_NOTE) } : {}),
  }
  return lock(AUDIT_INDEX, async () => {
    const index = await readAuditIndex(ctx)
    index.push(auditID)
    await ctx.storage.set(auditKey(auditID), record)
    await ctx.storage.set(AUDIT_INDEX, index)
    return record
  })
}

export async function listAudit(
  ctx: AuditContext,
  filter: { limit?: number; action?: string; target?: string; actor?: string } = {},
): Promise<AuditRecord[]> {
  const index = await readAuditIndex(ctx)
  let records = (await Promise.all(index.map((entry) => readAudit(ctx, entry)))).filter(
    (record): record is AuditRecord => Boolean(record),
  )
  if (filter.action) records = records.filter((record) => record.action === filter.action)
  if (filter.target) records = records.filter((record) => record.target === filter.target)
  if (filter.actor) records = records.filter((record) => record.actor === filter.actor)
  records.sort((left, right) => right.at - left.at)
  const limit = Math.max(1, Math.min(100, Math.floor(filter.limit ?? 20)))
  return records.slice(0, limit)
}

async function readAudit(ctx: AuditContext, auditID: string): Promise<AuditRecord | undefined> {
  const value = await ctx.storage.get(auditKey(auditID))
  if (!value || typeof value !== "object") return undefined
  const record = value as Partial<AuditRecord>
  if (typeof record.actor !== "string" || typeof record.action !== "string") return undefined
  if (typeof record.target !== "string") return undefined
  return {
    auditID,
    at: typeof record.at === "number" ? record.at : 0,
    actor: record.actor,
    action: record.action,
    target: record.target,
    ...(record.before !== undefined ? { before: record.before } : {}),
    ...(record.after !== undefined ? { after: record.after } : {}),
    ...(typeof record.note === "string" ? { note: record.note } : {}),
  }
}

async function readAuditIndex(ctx: AuditContext): Promise<string[]> {
  const value = await ctx.storage.get(AUDIT_INDEX)
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

/** Remove audit records older than the retention window. */
export async function cleanupAudit(
  ctx: AuditContext,
  lock: Lock,
  retentionDays = 7,
): Promise<number> {
  const days = Number.isFinite(retentionDays) ? Math.max(1, Math.min(365, retentionDays)) : 7
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  return lock(AUDIT_INDEX, async () => {
    const index = await readAuditIndex(ctx)
    const keep: string[] = []
    let removed = 0
    for (const auditID of index) {
      const record = await readAudit(ctx, auditID)
      const at = record?.at ?? Number(auditID.split("_")[0])
      if (!Number.isFinite(at) || at < cutoff) {
        await ctx.storage.remove(auditKey(auditID))
        removed += 1
      } else {
        keep.push(auditID)
      }
    }
    if (removed > 0) await ctx.storage.set(AUDIT_INDEX, keep)
    return removed
  })
}
