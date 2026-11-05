/**
 * Postal v2 operation-bound approvals.
 *
 * An approval is bound to one canonical operation payload: operation, resource,
 * and sorted parameters. The hash prevents approving one target and executing
 * another. One approval authorizes one execution; consume marks it used.
 */
import { createHash, randomBytes } from "node:crypto"
import { OPERATIONS, OPERATION_SPECS, type Operation } from "./grants.js"

export const EXTERNAL_OPERATIONS = ["host.shell", "host.edit", "host.deploy"] as const
export type ExternalOperation = (typeof EXTERNAL_OPERATIONS)[number]
export type ApprovalOperation = Operation | ExternalOperation

export const APPROVAL_OPERATIONS: ApprovalOperation[] = [...OPERATIONS, ...EXTERNAL_OPERATIONS]

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "consumed"

export type ApprovalRecord = {
  approvalID: string
  operation: ApprovalOperation
  resource: string
  parameters: Record<string, unknown>
  resourceHash: string
  proposer: string
  approver?: string
  executor?: string
  requestedAt: number
  expiresAt: number
  status: ApprovalStatus
  reason?: string
  consumedAt?: number
  decidedAt?: number
}

export type ApprovalContext = {
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    remove(key: string): Promise<void>
  }
  options?: Record<string, unknown>
}

export type Lock = <T>(key: string, task: () => Promise<T> | T) => Promise<T>

export class ApprovalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ApprovalError"
  }
}

const APPROVAL_INDEX = "approval/index"
const DEFAULT_TTL_MS = 15 * 60 * 1000
const MIN_TTL_MS = 60 * 1000
const MAX_TTL_MS = 24 * 60 * 60 * 1000

export function approvalKey(approvalID: string): string {
  return `approval/${approvalID}`
}

export type ApprovalOperationSpec = {
  label: string
  enforceable: "postal" | "host" | "none"
  defaultApprovalRequired: boolean
}

const EXTERNAL_SPECS: Record<ExternalOperation, ApprovalOperationSpec> = {
  "host.shell": { label: "run a host shell command", enforceable: "host", defaultApprovalRequired: true },
  "host.edit": { label: "edit a host file", enforceable: "host", defaultApprovalRequired: true },
  "host.deploy": { label: "deploy to a host target", enforceable: "none", defaultApprovalRequired: true },
}

export function approvalOperationSpec(operation: string): ApprovalOperationSpec | undefined {
  if ((OPERATIONS as readonly string[]).includes(operation)) {
    return OPERATION_SPECS[operation as Operation]
  }
  if ((EXTERNAL_OPERATIONS as readonly string[]).includes(operation)) {
    return EXTERNAL_SPECS[operation as ExternalOperation]
  }
  return undefined
}

export function isApprovalOperation(operation: string): operation is ApprovalOperation {
  return approvalOperationSpec(operation) !== undefined
}

/** Stable JSON: object keys sorted at every depth, arrays keep their order. */
export function canonicalApprovalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalApprovalValue(entry))
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalApprovalValue(record[key])]),
    )
  }
  return value
}

export function approvalHash(
  operation: string,
  resource: string,
  parameters: Record<string, unknown> = {},
): string {
  const payload = JSON.stringify({
    operation,
    resource,
    parameters: canonicalApprovalValue(parameters),
  })
  return createHash("sha256").update(payload).digest("hex")
}

function newApprovalID(now = Date.now()): string {
  return `apr_${now.toString(36)}_${randomBytes(5).toString("hex")}`
}

function clampExpiry(expiresAt: number | undefined, now: number): number {
  const requested = typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : now + DEFAULT_TTL_MS
  return Math.min(Math.max(requested, now + MIN_TTL_MS), now + MAX_TTL_MS)
}

function normalizeApproval(value: unknown, approvalID: string): ApprovalRecord | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Partial<ApprovalRecord>
  if (typeof record.operation !== "string" || !isApprovalOperation(record.operation)) return undefined
  if (typeof record.resource !== "string" || !record.resource) return undefined
  if (typeof record.resourceHash !== "string" || !record.resourceHash) return undefined
  if (typeof record.proposer !== "string" || !record.proposer) return undefined
  if (typeof record.expiresAt !== "number") return undefined
  const status: ApprovalStatus =
    record.status === "approved" ||
    record.status === "rejected" ||
    record.status === "expired" ||
    record.status === "consumed"
      ? record.status
      : "pending"
  return {
    approvalID,
    operation: record.operation,
    resource: record.resource,
    parameters:
      record.parameters && typeof record.parameters === "object" && !Array.isArray(record.parameters)
        ? (record.parameters as Record<string, unknown>)
        : {},
    resourceHash: record.resourceHash,
    proposer: record.proposer,
    ...(typeof record.approver === "string" ? { approver: record.approver } : {}),
    ...(typeof record.executor === "string" ? { executor: record.executor } : {}),
    requestedAt: typeof record.requestedAt === "number" ? record.requestedAt : 0,
    expiresAt: record.expiresAt,
    status,
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
    ...(typeof record.consumedAt === "number" ? { consumedAt: record.consumedAt } : {}),
    ...(typeof record.decidedAt === "number" ? { decidedAt: record.decidedAt } : {}),
  }
}

export async function readApproval(
  ctx: ApprovalContext,
  approvalID: string,
): Promise<ApprovalRecord | undefined> {
  return normalizeApproval(await ctx.storage.get(approvalKey(approvalID)), approvalID)
}

export async function listApprovals(
  ctx: ApprovalContext,
  filter: { proposer?: string; approver?: string; status?: ApprovalStatus } = {},
): Promise<ApprovalRecord[]> {
  const index = await readApprovalIndex(ctx)
  let approvals = (await Promise.all(index.map((entry) => readApproval(ctx, entry)))).filter(
    (record): record is ApprovalRecord => Boolean(record),
  )
  if (filter.proposer) approvals = approvals.filter((record) => record.proposer === filter.proposer)
  if (filter.approver) approvals = approvals.filter((record) => record.approver === filter.approver)
  if (filter.status) approvals = approvals.filter((record) => record.status === filter.status)
  return approvals.sort((left, right) => right.requestedAt - left.requestedAt)
}

export async function createApproval(
  ctx: ApprovalContext,
  lock: Lock,
  input: {
    proposer: string
    operation: string
    resource: string
    parameters?: Record<string, unknown>
    expiresAt?: number
  },
): Promise<ApprovalRecord> {
  const spec = approvalOperationSpec(input.operation)
  if (!spec) throw new ApprovalError(`unknown operation: ${input.operation}`)
  if (!input.proposer) throw new ApprovalError("proposer is required")
  const resource = input.resource.trim()
  if (!resource) throw new ApprovalError("resource is required")
  const parameters = input.parameters ?? {}
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    throw new ApprovalError("parameters must be an object")
  }
  if (JSON.stringify(parameters).length > 8 * 1024) {
    throw new ApprovalError("parameters are too large")
  }
  const now = Date.now()
  const approvalID = newApprovalID(now)
  const record: ApprovalRecord = {
    approvalID,
    operation: input.operation as ApprovalOperation,
    resource,
    parameters,
    resourceHash: approvalHash(input.operation, resource, parameters),
    proposer: input.proposer,
    requestedAt: now,
    expiresAt: clampExpiry(input.expiresAt, now),
    status: "pending",
  }
  return lock(approvalKey(approvalID), async () => {
    await ctx.storage.set(approvalKey(approvalID), record)
    await addApprovalIndex(ctx, lock, approvalID)
    return record
  })
}

export async function approveApproval(
  ctx: ApprovalContext,
  lock: Lock,
  approvalID: string,
  approver: string,
  options: { executor?: string; allowSelfApproval?: boolean } = {},
): Promise<ApprovalRecord> {
  return lock(approvalKey(approvalID), async () => {
    const record = await readApproval(ctx, approvalID)
    if (!record) throw new ApprovalError(`approval not found: ${approvalID}`)
    if (record.status !== "pending") throw new ApprovalError(`approval is ${record.status}`)
    const now = Date.now()
    if (now > record.expiresAt) {
      record.status = "expired"
      await ctx.storage.set(approvalKey(approvalID), record)
      throw new ApprovalError("approval has expired")
    }
    if (!options.allowSelfApproval && approver === record.proposer) {
      throw new ApprovalError("the proposer cannot approve its own request")
    }
    record.status = "approved"
    record.approver = approver
    record.decidedAt = now
    if (options.executor) record.executor = options.executor
    await ctx.storage.set(approvalKey(approvalID), record)
    return record
  })
}

export async function rejectApproval(
  ctx: ApprovalContext,
  lock: Lock,
  approvalID: string,
  approver: string,
  reason?: string,
): Promise<ApprovalRecord> {
  return lock(approvalKey(approvalID), async () => {
    const record = await readApproval(ctx, approvalID)
    if (!record) throw new ApprovalError(`approval not found: ${approvalID}`)
    if (record.status !== "pending") throw new ApprovalError(`approval is ${record.status}`)
    const now = Date.now()
    if (now > record.expiresAt) {
      record.status = "expired"
      await ctx.storage.set(approvalKey(approvalID), record)
      throw new ApprovalError("approval has expired")
    }
    record.status = "rejected"
    record.approver = approver
    record.decidedAt = now
    if (reason) record.reason = reason.slice(0, 500)
    await ctx.storage.set(approvalKey(approvalID), record)
    return record
  })
}

export async function consumeApproval(
  ctx: ApprovalContext,
  lock: Lock,
  approvalID: string,
  input: {
    executor: string
    operation: string
    resource: string
    parameters?: Record<string, unknown>
  },
): Promise<ApprovalRecord> {
  return lock(approvalKey(approvalID), async () => {
    const record = await readApproval(ctx, approvalID)
    if (!record) throw new ApprovalError(`approval not found: ${approvalID}`)
    if (record.status !== "approved") throw new ApprovalError(`approval is ${record.status}`)
    const now = Date.now()
    if (now > record.expiresAt) {
      record.status = "expired"
      await ctx.storage.set(approvalKey(approvalID), record)
      throw new ApprovalError("approval has expired")
    }
    const expected = approvalHash(input.operation, input.resource, input.parameters ?? {})
    if (expected !== record.resourceHash) {
      throw new ApprovalError("approval hash does not match the operation")
    }
    if (record.executor && record.executor !== input.executor) {
      throw new ApprovalError(`approval is bound to executor ${record.executor}`)
    }
    if (!record.executor && record.proposer !== input.executor) {
      throw new ApprovalError("approval is bound to the proposer")
    }
    record.status = "consumed"
    record.executor = input.executor
    record.consumedAt = now
    await ctx.storage.set(approvalKey(approvalID), record)
    return record
  })
}

async function readApprovalIndex(ctx: ApprovalContext): Promise<string[]> {
  const value = await ctx.storage.get(APPROVAL_INDEX)
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

async function addApprovalIndex(ctx: ApprovalContext, lock: Lock, approvalID: string): Promise<void> {
  await lock(APPROVAL_INDEX, async () => {
    const index = await readApprovalIndex(ctx)
    if (!index.includes(approvalID)) {
      index.push(approvalID)
      await ctx.storage.set(APPROVAL_INDEX, index)
    }
  })
}
