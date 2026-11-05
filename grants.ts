/**
 * Postal v2 relation grants.
 *
 * A spawn record is a fact (`spawn/<child>`), never authority. Authority is a
 * directed grant per operation (`grants/<from>/<to>`). `send` may be
 * bidirectional; authority operations must form a DAG (cycle checks live in the
 * caller until M1 step 3).
 */

export const OPERATIONS = ["send", "task", "spawn", "interrupt", "close", "history", "approve"] as const
export type Operation = (typeof OPERATIONS)[number]

export type Enforceable = "postal" | "host" | "none"

export type OperationSpec = {
  label: string
  enforceable: Enforceable
  defaultApprovalRequired: boolean
}

export const OPERATION_SPECS: Record<Operation, OperationSpec> = {
  send: { label: "send letters/status/question", enforceable: "postal", defaultApprovalRequired: false },
  task: { label: "forced assignment", enforceable: "postal", defaultApprovalRequired: false },
  spawn: { label: "spawn a child", enforceable: "postal", defaultApprovalRequired: true },
  interrupt: { label: "interrupt a turn", enforceable: "postal", defaultApprovalRequired: true },
  close: { label: "delete a session", enforceable: "postal", defaultApprovalRequired: true },
  history: { label: "read postal history/status", enforceable: "postal", defaultApprovalRequired: false },
  approve: { label: "approve an operation", enforceable: "postal", defaultApprovalRequired: true },
}

export type GrantRule = {
  allowed: boolean
  approvalRequired: boolean
  expiresAt?: number
  constraints?: Record<string, unknown>
}

export type DeliveryMode = "interrupt" | "idle" | "inbox"

export type RelationGrant = {
  from: string
  to: string
  operations: Record<Operation, GrantRule>
  delivery: DeliveryMode
  initialized: true
  createdAt: number
  updatedAt: number
  revokedAt?: number
}

export type SpawnRecord = {
  childID: string
  spawnedBy: string
  spawnedAt: number
  location?: string
}

export type GrantContext = {
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    remove(key: string): Promise<void>
  }
  options?: Record<string, unknown>
}

export type Lock = <T>(key: string, task: () => Promise<T> | T) => Promise<T>

export class GrantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GrantError"
  }
}

const GRANT_INDEX = "grants/index"
const AUTHORITY_OPERATIONS: Operation[] = ["task", "spawn", "interrupt", "close", "approve"]

export function grantKey(from: string, to: string): string {
  return `grants/${from}/${to}`
}

export function spawnKey(childID: string): string {
  return `spawn/${childID}`
}

export function emptyOperations(): Record<Operation, GrantRule> {
  return Object.fromEntries(
    OPERATIONS.map((operation) => [
      operation,
      { allowed: false, approvalRequired: OPERATION_SPECS[operation].defaultApprovalRequired },
    ]),
  ) as Record<Operation, GrantRule>
}

export function defaultOperations(kind: "parent" | "child" | "pair" | "ancestor"): Record<Operation, GrantRule> {
  const operations = emptyOperations()
  const allow = (names: Operation[]): void => {
    for (const name of names) operations[name].allowed = true
  }
  if (kind === "parent") allow(["send", "task", "interrupt", "close", "history"])
  else if (kind === "child") allow(["send"])
  else if (kind === "pair") allow(["send"])
  else allow(["interrupt", "close"])
  return operations
}

export async function readSpawnFact(ctx: GrantContext, childID: string): Promise<SpawnRecord | undefined> {
  const direct = await ctx.storage.get(spawnKey(childID))
  if (direct && typeof direct === "object") {
    const record = direct as Partial<SpawnRecord>
    if (typeof record.spawnedBy === "string" && record.spawnedBy) {
      return {
        childID,
        spawnedBy: record.spawnedBy,
        spawnedAt: typeof record.spawnedAt === "number" ? record.spawnedAt : 0,
        ...(typeof record.location === "string" ? { location: record.location } : {}),
      }
    }
  }
  const legacy = (await ctx.storage.get(`parent/${childID}`)) as { parentID?: unknown; createdAt?: unknown } | undefined
  if (legacy && typeof legacy === "object" && typeof legacy.parentID === "string") {
    return {
      childID,
      spawnedBy: legacy.parentID,
      spawnedAt: typeof legacy.createdAt === "number" ? legacy.createdAt : 0,
    }
  }
  return undefined
}

export async function writeSpawnFact(
  ctx: GrantContext,
  lock: Lock,
  childID: string,
  spawnedBy: string,
  location?: string,
): Promise<SpawnRecord> {
  const existing = await readSpawnFact(ctx, childID)
  if (existing?.spawnedBy && existing.spawnedBy !== spawnedBy) {
    throw new GrantError(`spawn fact already recorded: ${childID} was spawned by ${existing.spawnedBy}`)
  }
  return lock(spawnKey(childID), async () => {
    const record: SpawnRecord = {
      childID,
      spawnedBy,
      spawnedAt: existing?.spawnedAt || Date.now(),
      ...(location ? { location } : {}),
    }
    await ctx.storage.set(spawnKey(childID), record)
    return record
  })
}

export async function readCurrentParent(ctx: GrantContext, childID: string): Promise<string | undefined> {
  const parent = (await ctx.storage.get(`parent/${childID}`)) as { parentID?: unknown } | undefined
  if (typeof parent?.parentID === "string" && parent.parentID) return parent.parentID
  return (await readSpawnFact(ctx, childID))?.spawnedBy
}

export async function wouldCreateParentCycle(
  ctx: GrantContext,
  childID: string,
  parentID: string,
): Promise<boolean> {
  if (childID === parentID) return true
  let current = parentID
  for (let depth = 0; depth < 64; depth += 1) {
    if (current === childID) return true
    const parent = await readCurrentParent(ctx, current)
    if (!parent) return false
    current = parent
  }
  return true
}

export async function wouldCreateAuthorityCycle(
  ctx: GrantContext,
  from: string,
  to: string,
  operations: Operation[],
): Promise<boolean> {
  if (!operations.some((operation) => AUTHORITY_OPERATIONS.includes(operation))) return false
  if (from === to) return true
  const index = await readGrantIndex(ctx)
  const adjacency = new Map<string, string[]>()
  for (const entry of index) {
    const grant = await readGrantEntry(ctx, entry)
    if (!grant) continue
    if (!AUTHORITY_OPERATIONS.some((operation) => isRuleActive(grant.operations[operation], operation))) {
      continue
    }
    const next = adjacency.get(grant.from) ?? []
    if (!next.includes(grant.to)) next.push(grant.to)
    adjacency.set(grant.from, next)
  }
  const stack = [to]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const current = stack.pop()!
    if (current === from) return true
    if (seen.has(current)) continue
    seen.add(current)
    for (const next of adjacency.get(current) ?? []) stack.push(next)
  }
  return false
}

export async function readGrant(ctx: GrantContext, from: string, to: string): Promise<RelationGrant | undefined> {
  const value = await ctx.storage.get(grantKey(from, to))
  if (!value || typeof value !== "object") return undefined
  const record = value as Partial<RelationGrant>
  if (typeof record.from !== "string" || typeof record.to !== "string") return undefined
  return normalizeGrant(record, from, to)
}

export async function listGrants(ctx: GrantContext, sessionID?: string): Promise<RelationGrant[]> {
  const index = await readGrantIndex(ctx)
  const grants = (await Promise.all(index.map((entry) => readGrantEntry(ctx, entry)))).filter(
    (grant): grant is RelationGrant => Boolean(grant),
  )
  if (!sessionID) return grants
  return grants.filter((grant) => grant.from === sessionID || grant.to === sessionID)
}

export async function ensureGrant(
  ctx: GrantContext,
  lock: Lock,
  from: string,
  to: string,
): Promise<RelationGrant | undefined> {
  return lock(grantKey(from, to), async () => {
    const existing = await readGrant(ctx, from, to)
    if (existing) return existing
    const defaults = await defaultsFor(ctx, from, to)
    if (!defaults) return undefined
    const now = Date.now()
    const grant: RelationGrant = {
      from,
      to,
      operations: defaults,
      delivery: "interrupt",
      initialized: true,
      createdAt: now,
      updatedAt: now,
    }
    await ctx.storage.set(grantKey(from, to), grant)
    await addGrantIndex(ctx, lock, from, to)
    return grant
  })
}

export async function grantOperations(
  ctx: GrantContext,
  lock: Lock,
  from: string,
  to: string,
  operations: Operation[],
  options: { approvalRequired?: boolean; expiresAt?: number } = {},
): Promise<RelationGrant> {
  if (!operations.length) throw new GrantError("at least one operation is required")
  return lock("grants/authority", () =>
    lock(grantKey(from, to), async () => {
      if (await wouldCreateAuthorityCycle(ctx, from, to, operations)) {
        throw new GrantError(`authority cycle rejected: ${from} -> ${to}`)
      }
      const existing = await readGrant(ctx, from, to)
    const defaults = existing ? existing.operations : await defaultsFor(ctx, from, to)
    if (!defaults) throw new GrantError(`${from} has no relation with ${to}`)
    const now = Date.now()
    const next = cloneOperations(defaults)
    for (const operation of operations) {
      if (!OPERATIONS.includes(operation)) throw new GrantError(`unknown operation: ${operation}`)
      next[operation] = {
        allowed: true,
        approvalRequired: options.approvalRequired ?? OPERATION_SPECS[operation].defaultApprovalRequired,
        ...(typeof options.expiresAt === "number" ? { expiresAt: options.expiresAt } : {}),
      }
    }
    const grant: RelationGrant = {
      from,
      to,
      operations: next,
      delivery: existing?.delivery ?? "interrupt",
      initialized: true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(existing?.revokedAt ? { revokedAt: existing.revokedAt } : {}),
    }
      await ctx.storage.set(grantKey(from, to), grant)
      await addGrantIndex(ctx, lock, from, to)
      return grant
    }),
  )
}

export async function revokeOperations(
  ctx: GrantContext,
  lock: Lock,
  from: string,
  to: string,
  operations?: Operation[],
): Promise<RelationGrant | undefined> {
  return lock(grantKey(from, to), async () => {
    const existing = await readGrant(ctx, from, to)
    if (!existing) return undefined
    const now = Date.now()
    const targets = operations?.length ? operations : [...OPERATIONS]
    for (const operation of targets) {
      if (!OPERATIONS.includes(operation)) throw new GrantError(`unknown operation: ${operation}`)
      existing.operations[operation] = {
        ...existing.operations[operation],
        allowed: false,
        approvalRequired: OPERATION_SPECS[operation].defaultApprovalRequired,
      }
    }
    existing.updatedAt = now
    existing.revokedAt = now
    await ctx.storage.set(grantKey(from, to), existing)
    return existing
  })
}

export async function setDelivery(
  ctx: GrantContext,
  lock: Lock,
  from: string,
  to: string,
  mode: DeliveryMode,
): Promise<RelationGrant> {
  return lock(grantKey(from, to), async () => {
    const existing = await readGrant(ctx, from, to)
    if (!existing) throw new GrantError(`${from} has no relation with ${to}`)
    existing.delivery = mode
    existing.updatedAt = Date.now()
    await ctx.storage.set(grantKey(from, to), existing)
    return existing
  })
}

export function isRuleActive(rule: GrantRule | undefined, operation: Operation, now = Date.now()): boolean {
  if (!rule?.allowed) return false
  if (typeof rule.expiresAt === "number" && rule.expiresAt <= now) return false
  return true
}

export function allowedOperations(grant: RelationGrant, now = Date.now()): Operation[] {
  return OPERATIONS.filter((operation) => isRuleActive(grant.operations[operation], operation, now))
}

async function defaultsFor(ctx: GrantContext, from: string, to: string): Promise<Record<Operation, GrantRule> | undefined> {
  // The current parent mirror follows reparenting; the spawn fact is historical.
  const currentParentOfTo = (await ctx.storage.get(`parent/${to}`)) as { parentID?: unknown } | undefined
  if (currentParentOfTo?.parentID === from) return defaultOperations("parent")
  const currentParentOfFrom = (await ctx.storage.get(`parent/${from}`)) as { parentID?: unknown } | undefined
  if (currentParentOfFrom?.parentID === to) return defaultOperations("child")
  const toSpawn = await readSpawnFact(ctx, to)
  if (toSpawn?.spawnedBy === from) return defaultOperations("parent")
  const fromSpawn = await readSpawnFact(ctx, from)
  if (fromSpawn?.spawnedBy === to) return defaultOperations("child")
  if (await isPaired(ctx, from, to)) return defaultOperations("pair")
  if (ctx.options?.allowAncestorCommands === true && (await isAncestor(ctx, from, to))) {
    return defaultOperations("ancestor")
  }
  return undefined
}

async function isPaired(ctx: GrantContext, from: string, to: string): Promise<boolean> {
  const peers = await ctx.storage.get(`peers/${from}`)
  return Array.isArray(peers) && peers.some((peer) => peer && typeof peer === "object" && (peer as { id?: unknown }).id === to)
}

async function isAncestor(ctx: GrantContext, from: string, to: string): Promise<boolean> {
  let current = to
  for (let depth = 0; depth < 64; depth += 1) {
    const parent = await readCurrentParent(ctx, current)
    if (!parent) return false
    if (parent === from) return true
    current = parent
  }
  return false
}

function normalizeGrant(record: Partial<RelationGrant>, from: string, to: string): RelationGrant {
  const operations = emptyOperations()
  const source = record.operations && typeof record.operations === "object" ? record.operations : {}
  for (const operation of OPERATIONS) {
    const rule = (source as Record<string, Partial<GrantRule>>)[operation]
    if (rule && typeof rule === "object") {
      operations[operation] = {
        allowed: rule.allowed === true,
        approvalRequired: rule.approvalRequired === true,
        ...(typeof rule.expiresAt === "number" ? { expiresAt: rule.expiresAt } : {}),
        ...(rule.constraints && typeof rule.constraints === "object" ? { constraints: rule.constraints } : {}),
      }
    }
  }
  return {
    from,
    to,
    operations,
    delivery:
      record.delivery === "inbox" || record.delivery === "idle" ? record.delivery : "interrupt",
    initialized: true,
    createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
    ...(typeof record.revokedAt === "number" ? { revokedAt: record.revokedAt } : {}),
  }
}

function cloneOperations(source: Record<Operation, GrantRule>): Record<Operation, GrantRule> {
  const next = emptyOperations()
  for (const operation of OPERATIONS) {
    next[operation] = { ...source[operation] }
  }
  return next
}

async function readGrantIndex(ctx: GrantContext): Promise<string[]> {
  const value = await ctx.storage.get(GRANT_INDEX)
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

async function addGrantIndex(ctx: GrantContext, lock: Lock, from: string, to: string): Promise<void> {
  await lock("grants/index", async () => {
    const index = await readGrantIndex(ctx)
    const key = `${from}/${to}`
    if (!index.includes(key)) {
      index.push(key)
      await ctx.storage.set(GRANT_INDEX, index)
    }
  })
}

async function readGrantEntry(ctx: GrantContext, entry: string): Promise<RelationGrant | undefined> {
  const slash = entry.indexOf("/")
  if (slash <= 0 || slash === entry.length - 1) return undefined
  return readGrant(ctx, entry.slice(0, slash), entry.slice(slash + 1))
}
