/**
 * Postal — session-to-session mail for OpenCode.
 *
 * Two modes (no subagents):
 *
 * 1. Mention mode: a user prompt containing `@ses_XXXX <message>` is forwarded
 *    to that session immediately, then the sender is free. The receiver
 *    replies with `postal_send`, which starts the sender's next turn. Nothing
 *    is parked in the sender's inbox.
 *
 * 2. Tool mode: `postal_send` delivers immediately (non-blocking) with
 *    `delivery: "steer"`. The receiving AI replies by calling `postal_send`
 *    again, so two AIs can hold a rally. `postal_send` without `to` uses the
 *    peer connected via the Ctrl+P command.
 *
 * All deliveries use `steer`; Postal never queues replies or notices.
 *
 * Loop safety: every prompt this plugin sends carries
 * `metadata.postal.relay = true` and the prompt hook ignores those. Assistant
 * messages never run prompt hooks, so forwarding only happens for explicit
 * mentions or tool calls. The shared rally counter (maxRally, default 30 per
 * 10-minute window) bounds AI-to-AI conversations.
 *
 * Message bodies are untrusted data: they are forwarded verbatim and only
 * `@ses_*` tokens are interpreted as addresses.
 */
import { PostalRpc } from "./rpc.js"
import { serialized } from "./lock.js"
import { defaultLockStorePath, openLockStore } from "./state.js"
import {
  allowedOperations,
  ensureGrant,
  grantOperations,
  isRuleActive,
  listGrants,
  OPERATION_SPECS,
  OPERATIONS,
  readSpawnFact,
  revokeOperations,
  wouldCreateParentCycle,
  writeSpawnFact,
  type Lock,
  type Operation,
} from "./grants.js"
import { renderSessionTree } from "./tree.js"
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { readFileSync, realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

type PromptEvent = {
  readonly sessionID: string
  prompt: { text?: string; files?: unknown[]; agents?: unknown[]; skills?: unknown[] }
  metadata?: Record<string, unknown>
  delivery?: "steer" | "queue"
}

type PostalMeta = {
  postal?: {
    relay?: boolean
    from?: string
    connect?: string
    disconnect?: boolean | string
    resetRally?: boolean
    msgID?: string
    replyTo?: string
    kind?: string
    taskID?: string
    signature?: string
    keyID?: string
    issuedAt?: number
    sigVersion?: number
    reason?: string
    peer?: { id?: string; title?: string }
  }
}

type ToolEditor = {
  namespace(input: { name: string; description: string }): void
  add(tool: {
    name: string
    description: string
    input: Record<string, unknown>
    execute: (input: unknown, context: { sessionID: string; signal?: AbortSignal }) => Promise<{ content: string }>
  }): void
}

type PostalContext = {
  location: { directory: string }
  options?: Record<string, unknown>
  session: {
    hook(name: "prompt", callback: (event: PromptEvent) => void | Promise<void>): Promise<unknown>
    list(input?: Record<string, unknown>): Promise<{
      data: Array<{
        id: string
        title?: string
        parentID?: string
        location?: { directory?: string }
      }>
      cursor?: { next?: string }
    }>
    get(input: { sessionID: string }): Promise<{ id: string; title?: string }>
    create?(input: {
      title?: string
      agent?: string
      model?: { id: string; providerID: string; variant?: string }
      location?: { directory: string }
      permissions?: Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }>
    }): Promise<{ id: string; title?: string } | { data?: { id: string; title?: string } }>
    context?(input: { sessionID: string }): Promise<ProjectedMessage[]>
    interrupt?(input: { sessionID: string }): Promise<unknown>
    remove?(input: { sessionID: string }): Promise<unknown>
    prompt(input: Record<string, unknown>): Promise<unknown>
    instructions: {
      entry: {
        put(input: { sessionID: string; key: string; value: string }): Promise<void>
        remove?(input: { sessionID: string; key: string }): Promise<void>
      }
    }
  }
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    remove(key: string): Promise<void>
    scan?(input: {
      prefix: string
      after?: string
      limit?: number
    }): Promise<{ entries: Array<{ key: string; value: unknown }>; next?: string }>
  }
  tool: { transform(callback: (editor: ToolEditor) => void): Promise<unknown> }
  skill?: {
    transform(callback: (editor: { add?: (skill: Record<string, unknown>) => void }) => void): Promise<unknown>
  }
  rpc: {
    register(
      contract: unknown,
      implementation: Record<string, (input: Record<string, unknown>) => Promise<unknown>>,
    ): Promise<unknown>
  }
}

type ProjectedPart = { type?: string; text?: string; ignored?: boolean; synthetic?: boolean }
type ProjectedMessage = {
  id?: string
  type?: string
  role?: string
  text?: string
  content?: ProjectedPart[]
  parts?: ProjectedPart[]
  info?: { id?: string; role?: string }
}

type PeerRecord = { id: string; title: string }
type PairResult = { ok: boolean; peerID?: string; title?: string; peers?: PeerRecord[]; error?: string }

type EnvelopeKind = "task" | "status" | "verify" | "error" | "letter" | "system"
type EnvelopeArtifact = { path: string; sha256?: string }
type EnvelopeCommand = { cmd: string; exit?: number }
type Envelope = {
  kind: EnvelopeKind
  taskID?: string
  replyTo?: string
  msgID: string
  artifacts: EnvelopeArtifact[]
  commands: EnvelopeCommand[]
}

type ClaimRecord = { scope: string; owner: string; expiresAt: number }

type PresenceItem = { id?: string; type?: string; source?: string }
type PresenceRecord = {
  id: string
  title: string
  state: "idle" | "running" | "unknown"
  pending: PresenceItem[]
  reportedAt: number
}

type ParentRecord = { parentID: string; createdAt: number }

type HmacKey = { keyID: string; key: string; createdAt: number; validUntil?: number }
type HmacRecord = { current: HmacKey; previous: HmacKey[] }

type OutboxStatus = "pending" | "delivered" | "acked" | "rejected" | "revoked" | "failed"
type OutboxRecord = {
  msgID: string
  from: string
  to: string
  body: string
  envelope: Envelope
  rally: number
  max: number
  createdAt: number
  attempts: number
  nextAt: number
  status: OutboxStatus
  lastError?: string
  admittedAt?: number
  authorizedBy?: string
  ackedAt?: number
  queuedForWindow?: boolean
  nudges?: number
  lastNudgeAt?: number
  resendCount?: number
}

type ReceiptRecord = {
  msgID: string
  from: string
  to: string
  kind: string
  taskID?: string
  status: "accepted" | "rejected"
  reason?: string
  authorizedBy?: string
  verifiedAt: number
}

const MENTION = /@(ses_[A-Za-z0-9_-]+)/g
const ADDRESS = /^\s*@(ses_[A-Za-z0-9_-]+)/

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function unwrapSession(value: unknown): { id: string; title?: string } | undefined {
  if (!value || typeof value !== "object") return undefined
  const direct = value as { id?: unknown; title?: unknown }
  if (typeof direct.id === "string") return { id: direct.id, title: typeof direct.title === "string" ? direct.title : undefined }
  const wrapped = (value as { data?: unknown }).data
  if (!wrapped || typeof wrapped !== "object") return undefined
  const info = wrapped as { id?: unknown; title?: unknown }
  if (typeof info.id === "string") return { id: info.id, title: typeof info.title === "string" ? info.title : undefined }
  return undefined
}

/** Parse `provider/model[#variant]` without guessing at slash positions. */
function parseModel(ref: string): {
  model?: { id: string; providerID: string; variant?: string }
  error?: string
} {
  const [target, ...variantParts] = ref.split("#")
  const variant = variantParts.join("#") || undefined
  const slash = target.indexOf("/")
  if (slash <= 0 || slash === target.length - 1) {
    return { error: "model must be provider/model[#variant]" }
  }
  return {
    model: {
      providerID: target.slice(0, slash),
      id: target.slice(slash + 1),
      ...(variant ? { variant } : {}),
    },
  }
}

const ENVELOPE_KINDS = new Set<EnvelopeKind>(["task", "status", "verify", "error", "letter", "system"])

function parseKind(value: unknown): EnvelopeKind | undefined {
  return typeof value === "string" && ENVELOPE_KINDS.has(value as EnvelopeKind)
    ? (value as EnvelopeKind)
    : undefined
}

function generateMsgID(): string {
  return `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function normalizeArtifacts(value: unknown): EnvelopeArtifact[] {
  if (!Array.isArray(value)) return []
  const artifacts: EnvelopeArtifact[] = []
  for (const item of value) {
    if (!item || typeof item !== "object") continue
    const path = (item as { path?: unknown }).path
    if (typeof path !== "string" || path.length === 0) continue
    const sha256 = (item as { sha256?: unknown }).sha256
    artifacts.push({ path, ...(typeof sha256 === "string" && sha256 ? { sha256 } : {}) })
  }
  return artifacts
}

function normalizeCommands(value: unknown): EnvelopeCommand[] {
  if (!Array.isArray(value)) return []
  const commands: EnvelopeCommand[] = []
  for (const item of value) {
    if (!item || typeof item !== "object") continue
    const cmd = (item as { cmd?: unknown }).cmd
    if (typeof cmd !== "string" || cmd.length === 0) continue
    const exit = (item as { exit?: unknown }).exit
    commands.push({ cmd, ...(typeof exit === "number" && Number.isFinite(exit) ? { exit } : {}) })
  }
  return commands
}

const MAX_ARTIFACT_BYTES = 1024 * 1024

/** Resolve an artifact inside the project, rejecting absolute paths and symlink escapes. */
function containedArtifactPath(ctx: PostalContext, artifactPath: string): string | undefined {
  if (artifactPath.includes("\0")) return undefined
  let root: string
  let target: string
  try {
    root = realpathSync(ctx.location.directory)
    target = realpathSync(resolve(ctx.location.directory, artifactPath))
  } catch {
    return undefined
  }
  const rel = relative(root, target)
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined
  return target
}

function verifyArtifact(ctx: PostalContext, artifact: EnvelopeArtifact): string {
  const path = containedArtifactPath(ctx, artifact.path)
  if (!path) return `${artifact.path}: outside project or missing`
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(path)
  } catch (error) {
    return `${artifact.path}: unreadable (${errorText(error)})`
  }
  if (!stat.isFile()) return `${artifact.path}: not a regular file`
  if (stat.size > MAX_ARTIFACT_BYTES) return `${artifact.path}: too large (${stat.size} bytes)`
  if (!artifact.sha256) return `${artifact.path}: exists`
  if (!/^[0-9a-f]{64}$/i.test(artifact.sha256)) return `${artifact.path}: invalid sha256`
  try {
    const hash = createHash("sha256").update(readFileSync(path)).digest("hex")
    return hash.toLowerCase() === artifact.sha256.toLowerCase()
      ? `${artifact.path}: ok`
      : `${artifact.path}: sha256 mismatch`
  } catch (error) {
    return `${artifact.path}: unreadable (${errorText(error)})`
  }
}

function stripMentions(text: string): string {
  return text.replace(MENTION, "").replace(/\n{3,}/g, "\n\n").trim()
}

async function sessionLabel(ctx: PostalContext, sessionID: string): Promise<string> {
  try {
    const info = await ctx.session.get({ sessionID })
    return info?.title ? `${sessionID} (${info.title})` : sessionID
  } catch {
    return sessionID
  }
}

function messageRole(message: ProjectedMessage): string {
  return message.info?.role ?? message.role ?? message.type ?? "unknown"
}

function messageID(message: ProjectedMessage): string {
  return message.info?.id ?? message.id ?? ""
}

function messageText(message: ProjectedMessage): string {
  if (typeof message.text === "string" && message.text.length > 0) return message.text
  return (message.parts ?? message.content ?? [])
    .filter((part) => (part.type ?? "text") === "text" && !part.ignored && !part.synthetic)
    .map((part) => part.text ?? "")
    .join("\n")
    .trim()
}

const PRESENCE_TTL_MS = 30_000
const SEEN_TTL_MS = 24 * 60 * 60 * 1000

/** Direct parent recorded when this session was spawned by another session. */
async function readParent(ctx: PostalContext, sessionID: string): Promise<ParentRecord | undefined> {
  const value = await ctx.storage.get(`parent/${sessionID}`)
  if (!value || typeof value !== "object") return undefined
  const record = value as ParentRecord
  return typeof record.parentID === "string" ? record : undefined
}

async function readChildren(ctx: PostalContext, sessionID: string): Promise<string[]> {
  const value = await ctx.storage.get(`children/${sessionID}`)
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []
}

async function writeParent(ctx: PostalContext, childID: string, parentID: string): Promise<void> {
  if (childID === parentID) throw new Error("postal: relation cycle rejected (self-parent)")
  await crossProcessLock(ctx, "parent-tree", async () => {
    if (await wouldCreateParentCycle(ctx, childID, parentID)) {
      throw new Error(`postal: relation cycle rejected: ${childID} -> ${parentID}`)
    }
    const previous = await readParent(ctx, childID)
    if (previous?.parentID && previous.parentID !== parentID) {
      const siblings = await readChildren(ctx, previous.parentID)
      const next = siblings.filter((id) => id !== childID)
      if (next.length === 0) await ctx.storage.remove(`children/${previous.parentID}`)
      else await ctx.storage.set(`children/${previous.parentID}`, next)
    }
    await ctx.storage.set(`parent/${childID}`, { parentID, createdAt: Date.now() } satisfies ParentRecord)
    const children = await readChildren(ctx, parentID)
    if (!children.includes(childID)) {
      children.push(childID)
      await ctx.storage.set(`children/${parentID}`, children)
    }
  })
}

async function removeParent(ctx: PostalContext, childID: string): Promise<void> {
  await crossProcessLock(ctx, "parent-tree", async () => {
    const previous = await readParent(ctx, childID)
    if (!previous) return
    await ctx.storage.remove(`parent/${childID}`)
    const siblings = await readChildren(ctx, previous.parentID)
    const next = siblings.filter((id) => id !== childID)
    if (next.length === 0) await ctx.storage.remove(`children/${previous.parentID}`)
    else await ctx.storage.set(`children/${previous.parentID}`, next)
  })
}

/** A session may inspect itself, or a session that granted it `history`. */
async function canInspect(ctx: PostalContext, actor: string, target: string): Promise<boolean> {
  if (target === actor) return true
  const grant = await ensureGrant(ctx, stateLock(ctx), actor, target)
  return Boolean(grant && isRuleActive(grant.operations.history, "history"))
}

/** A session may interrupt/close itself or a session that granted it that operation. */
async function canOperate(
  ctx: PostalContext,
  actor: string,
  target: string,
  operation: "interrupt" | "close",
): Promise<boolean> {
  if (actor === target) return true
  const grant = await ensureGrant(ctx, stateLock(ctx), actor, target)
  return Boolean(grant && isRuleActive(grant.operations[operation], operation))
}

/** Check whether actor is the direct parent of target, or an ancestor when enabled. */
async function isAuthorizedParent(
  ctx: PostalContext,
  actor: string,
  target: string,
): Promise<boolean> {
  const allowAncestors = ctx.options?.allowAncestorCommands === true
  let current = target
  for (let depth = 0; depth < 16; depth += 1) {
    const parent = await readParent(ctx, current)
    if (!parent) return false
    if (parent.parentID === actor) return true
    if (!allowAncestors) return false
    current = parent.parentID
  }
  return false
}

type OrphanPolicy = "reparent" | "terminate" | "detach"

function orphanPolicy(ctx: PostalContext): OrphanPolicy {
  const value = ctx.options?.orphanPolicy
  return value === "terminate" || value === "detach" ? value : "reparent"
}

/** Recursively stop and delete a child that is being terminated by policy. */
async function terminateSession(ctx: PostalContext, sessionID: string, depth = 0): Promise<void> {
  if (depth > 16) return
  const children = await readChildren(ctx, sessionID)
  for (const child of children) await terminateSession(ctx, child, depth + 1)
  try {
    await disconnect(ctx, sessionID)
  } catch {
    // Best effort.
  }
  if (typeof ctx.session.remove === "function") {
    await ctx.session.remove({ sessionID }).catch(() => {})
  }
  await removeParent(ctx, sessionID)
  await ctx.storage.remove(`children/${sessionID}`)
}

/** Tell the grandparent which children it now owns. */
async function notifyReparent(
  ctx: PostalContext,
  closedParent: string,
  grandparent: string,
  children: string[],
): Promise<void> {
  try {
    await dispatchLetter(ctx, {
      from: closedParent,
      to: grandparent,
      body:
        `Reparented after ${closedParent} was closed: ${children.join(", ")}. ` +
        `You are now their direct parent.`,
      envelope: { kind: "system", msgID: generateMsgID(), artifacts: [], commands: [] },
      queueOnLimit: true,
    })
  } catch (error) {
    console.warn(`postal: reparent notification failed: ${errorText(error)}`)
  }
}

/**
 * Apply the configured orphan policy before the parent is deleted:
 * - reparent: promote children to the grandparent and notify it
 * - terminate: stop and delete descendants
 * - detach: remove parent links; nobody can close the children
 */
async function applyOrphanPolicy(ctx: PostalContext, sessionID: string): Promise<void> {
  const parent = await readParent(ctx, sessionID)
  const children = await readChildren(ctx, sessionID)
  const policy = orphanPolicy(ctx)
  if (policy === "terminate") {
    for (const child of children) await terminateSession(ctx, child)
  } else if (policy === "reparent") {
    const reparented: string[] = []
    for (const child of children) {
      await removeParent(ctx, child)
      if (parent?.parentID) {
        await writeParent(ctx, child, parent.parentID)
        reparented.push(child)
      }
    }
    if (parent?.parentID && reparented.length > 0) {
      await notifyReparent(ctx, sessionID, parent.parentID, reparented)
    }
  } else {
    for (const child of children) await removeParent(ctx, child)
  }
  await removeParent(ctx, sessionID)
  await ctx.storage.remove(`children/${sessionID}`)
}

/** Read a TUI-published presence record, ignoring stale reports. */
async function readPresence(ctx: PostalContext, sessionID: string): Promise<PresenceRecord | undefined> {
  const value = await ctx.storage.get(`presence/${sessionID}`)
  if (!value || typeof value !== "object") return undefined
  const record = value as PresenceRecord
  if (typeof record.reportedAt !== "number" || Date.now() - record.reportedAt > PRESENCE_TTL_MS) {
    return undefined
  }
  return record
}

const hmacLocks = new Map<string, Promise<unknown>>()

function hmacWindowMs(ctx: PostalContext): number {
  const configured = Number(ctx.options?.hmacWindowSeconds)
  const seconds = Number.isFinite(configured) && configured > 0 ? configured : 120
  return Math.max(30, Math.min(3600, seconds)) * 1000
}

function keyGraceMs(ctx: PostalContext): number {
  const configured = Number(ctx.options?.keyGraceHours)
  const hours = Number.isFinite(configured) && configured > 0 ? configured : 24
  return Math.max(1, Math.min(168, hours)) * 60 * 60 * 1000
}

function newHmacKey(): HmacKey {
  return {
    keyID: `hk_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`,
    key: randomBytes(32).toString("base64"),
    createdAt: Date.now(),
  }
}

function hmacStorageKey(a: string, b: string): string {
  return `hmac/${rallyKey(a, b)}`
}

async function readHmacRecord(ctx: PostalContext, a: string, b: string): Promise<HmacRecord | undefined> {
  const value = await ctx.storage.get(hmacStorageKey(a, b))
  if (!value || typeof value !== "object") return undefined
  const record = value as HmacRecord
  if (!record.current || typeof record.current.key !== "string" || typeof record.current.keyID !== "string") {
    return undefined
  }
  return { current: record.current, previous: Array.isArray(record.previous) ? record.previous : [] }
}

/** Create the pair key once; pairing itself also calls this. */
async function ensureHmacRecord(ctx: PostalContext, a: string, b: string): Promise<HmacRecord> {
  return crossProcessLock(ctx, hmacStorageKey(a, b), () =>
    serialized(hmacLocks, hmacStorageKey(a, b), async () => {
      const existing = await readHmacRecord(ctx, a, b)
      if (existing) return existing
      const record: HmacRecord = { current: newHmacKey(), previous: [] }
      await ctx.storage.set(hmacStorageKey(a, b), record)
      return record
    }),
  )
}

const HMAC_VERSION = 2

/** Canonical signed payload: the rendered letter plus every metadata field used for decisions. */
function signaturePayload(input: {
  keyID: string
  issuedAt: number
  from: string
  to: string
  msgID: string
  kind: string
  taskID?: string
  replyTo?: string
  letter: string
}): string {
  return JSON.stringify([
    "postal-hmac-v2",
    input.keyID,
    input.issuedAt,
    input.from,
    input.to,
    input.msgID,
    input.kind,
    input.taskID ?? null,
    input.replyTo ?? null,
    input.letter,
  ])
}

async function signLetter(
  ctx: PostalContext,
  from: string,
  to: string,
  letter: string,
  envelope: Envelope,
): Promise<{ signature: string; keyID: string; issuedAt: number; sigVersion: number }> {
  const record = await ensureHmacRecord(ctx, from, to)
  const issuedAt = Date.now()
  const signature = createHmac("sha256", record.current.key)
    .update(
      signaturePayload({
        keyID: record.current.keyID,
        issuedAt,
        from,
        to,
        msgID: envelope.msgID,
        kind: envelope.kind,
        taskID: envelope.taskID,
        replyTo: envelope.replyTo,
        letter,
      }),
    )
    .digest("hex")
  return { signature, keyID: record.current.keyID, issuedAt, sigVersion: HMAC_VERSION }
}

async function verifyLetter(
  ctx: PostalContext,
  from: string,
  to: string,
  letter: string,
  meta: {
    signature?: string
    keyID?: string
    issuedAt?: number
    sigVersion?: number
    msgID?: string
    kind?: string
    taskID?: string
    replyTo?: string
  },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!from || !to || !meta.signature || !meta.keyID || typeof meta.issuedAt !== "number") {
    return { ok: false, reason: "missing_signature" }
  }
  if (meta.sigVersion !== HMAC_VERSION) return { ok: false, reason: "unsupported_signature_version" }
  if (!meta.msgID || !meta.kind) return { ok: false, reason: "missing_signature" }
  if (Math.abs(Date.now() - meta.issuedAt) > hmacWindowMs(ctx)) {
    return { ok: false, reason: "stale_signature" }
  }
  const record = await readHmacRecord(ctx, from, to)
  if (!record) return { ok: false, reason: "unknown_key" }
  const now = Date.now()
  const candidates = [record.current, ...record.previous].filter(
    (key) => key.keyID === meta.keyID && (key.keyID === record.current.keyID || !key.validUntil || key.validUntil > now),
  )
  if (candidates.length === 0) return { ok: false, reason: "unknown_key" }
  const expected = createHmac("sha256", candidates[0].key)
    .update(
      signaturePayload({
        keyID: meta.keyID,
        issuedAt: meta.issuedAt,
        from,
        to,
        msgID: meta.msgID,
        kind: meta.kind,
        taskID: meta.taskID,
        replyTo: meta.replyTo,
        letter,
      }),
    )
    .digest("hex")
  if (expected.length !== meta.signature.length) return { ok: false, reason: "invalid_signature" }
  try {
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(meta.signature))) {
      return { ok: false, reason: "invalid_signature" }
    }
  } catch {
    return { ok: false, reason: "invalid_signature" }
  }
  return { ok: true }
}

function watchdogAfterMs(ctx: PostalContext): number {
  const configured = Number(ctx.options?.watchdogAfterSeconds)
  const seconds = Number.isFinite(configured) && configured >= 0 ? configured : 300
  return Math.max(0, Math.min(86_400, seconds)) * 1000
}

function watchdogIntervalMs(ctx: PostalContext): number {
  const configured = Number(ctx.options?.watchdogIntervalSeconds)
  const seconds = Number.isFinite(configured) && configured > 0 ? configured : 600
  return Math.max(30, Math.min(86_400, seconds)) * 1000
}

function watchdogMaxNudges(ctx: PostalContext): number {
  const configured = Number(ctx.options?.watchdogMaxNudges)
  return Number.isFinite(configured) && configured > 0 ? Math.max(1, Math.min(10, Math.floor(configured))) : 2
}

function outboxTtlMs(ctx: PostalContext): number {
  const configured = Number(ctx.options?.outboxTtlDays)
  const days = Number.isFinite(configured) && configured > 0 ? configured : 7
  return Math.max(1, Math.min(90, days)) * 24 * 60 * 60 * 1000
}

function maxResends(ctx: PostalContext): number {
  const configured = Number(ctx.options?.maxResends)
  return Number.isFinite(configured) && configured >= 0 ? Math.min(20, Math.floor(configured)) : 5
}

/** Return the ancestor that authorizes `actor` to task `target`, if any. */
async function authorizingAncestor(
  ctx: PostalContext,
  actor: string,
  target: string,
): Promise<string | undefined> {
  let current = target
  for (let depth = 0; depth < 16; depth += 1) {
    const parent = await readParent(ctx, current)
    if (!parent) return undefined
    if (parent.parentID === actor) return actor
    current = parent.parentID
  }
  return undefined
}

async function isAncestorOf(ctx: PostalContext, actor: string, target: string): Promise<boolean> {
  return Boolean(await authorizingAncestor(ctx, actor, target))
}

/** Deliver a letter immediately (no waiting); the peer replies with postal_send. */
async function postOnly(
  ctx: PostalContext,
  options: {
    from: string
    to: string
    body: string
    rally: number
    max: number
    envelope?: Partial<Envelope>
  },
): Promise<Envelope> {
  const envelope: Envelope = {
    kind: options.envelope?.kind ?? "letter",
    taskID: options.envelope?.taskID,
    replyTo: options.envelope?.replyTo,
    msgID: options.envelope?.msgID || generateMsgID(),
    artifacts: options.envelope?.artifacts ?? [],
    commands: options.envelope?.commands ?? [],
  }
  const fromLabel = await sessionLabel(ctx, options.from)
  const header = [
    `[postal] from ${fromLabel} (rally ${options.rally}/${options.max})`,
    `[msg: ${envelope.msgID}]`,
    `[kind: ${envelope.kind}]`,
    ...(envelope.taskID ? [`[task: ${envelope.taskID}]`] : []),
    ...(envelope.replyTo ? [`[reply_to: ${envelope.replyTo}]`] : []),
  ].join(" ")
  const instructions =
    `(Session mail. Reply with postal_send and pass to: ${options.from}. ` +
    `If replying to this letter, also pass reply_to: ${envelope.msgID}. ` +
    `You may omit 'to' only when exactly one peer is connected. A normal text reply is not delivered.)`
  let letter = `${header}\n${instructions}\n\n${options.body}`

  const verification = envelope.artifacts.map((artifact) => verifyArtifact(ctx, artifact))
  const hasDetails =
    envelope.kind !== "letter" ||
    Boolean(envelope.taskID || envelope.replyTo) ||
    envelope.artifacts.length > 0 ||
    envelope.commands.length > 0
  if (hasDetails) {
    letter += "\n\n--- postal envelope ---"
    letter += `\nkind: ${envelope.kind}`
    if (envelope.taskID) letter += `\ntask_id: ${envelope.taskID}`
    if (envelope.replyTo) letter += `\nreply_to: ${envelope.replyTo}`
    letter += `\nmsg_id: ${envelope.msgID}`
    if (envelope.artifacts.length > 0) {
      letter += "\nartifacts:"
      for (const artifact of envelope.artifacts) {
        letter += `\n- ${artifact.path}${artifact.sha256 ? ` (sha256: ${artifact.sha256})` : ""}`
      }
    }
    if (envelope.commands.length > 0) {
      letter += "\ncommands:"
      for (const command of envelope.commands) {
        letter += `\n- ${command.cmd}${command.exit !== undefined ? ` (exit: ${command.exit})` : ""}`
      }
    }
    if (verification.length > 0) {
      letter += "\nverification:"
      for (const line of verification) letter += `\n- ${line}`
    }
  }

  const signed = await signLetter(ctx, options.from, options.to, letter, envelope)
  await ctx.session.prompt({
    sessionID: options.to,
    text: letter,
    delivery: "steer",
    metadata: {
      postal: {
        relay: true,
        from: options.from,
        rally: options.rally,
        msgID: envelope.msgID,
        replyTo: envelope.replyTo,
        kind: envelope.kind,
        taskID: envelope.taskID,
        signature: signed.signature,
        keyID: signed.keyID,
        issuedAt: signed.issuedAt,
        sigVersion: signed.sigVersion,
      },
    },
  })
  const now = Date.now()
  await ctx.storage.set(messageKey(options.from, envelope.msgID), now).catch(() => {})
  await ctx.storage.set(`last/${rallyKey(options.from, options.to)}`, now).catch(() => {})
  return envelope
}

const DEFAULT_MAX_RALLY = 30
const DEFAULT_RALLY_WINDOW_MINUTES = 10

function maxRally(ctx: PostalContext): number {
  const configured = Number(ctx.options?.maxRally)
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_MAX_RALLY
}

function rallyWindowMs(ctx: PostalContext): number {
  const configured = Number(ctx.options?.rallyWindowMinutes)
  const minutes =
    Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_RALLY_WINDOW_MINUTES
  return minutes * 60 * 1000
}

/** Shared rally key for a conversation (order-independent). */
function rallyKey(a: string, b: string): string {
  const [first, second] = a < b ? [a, b] : [b, a]
  return `rally/${first}:${second}`
}

const rallyLocks = new Map<string, Promise<unknown>>()

/** Count letters in the current rally (serialized per conversation). */
async function nextRally(ctx: PostalContext, from: string, to: string): Promise<number> {
  const key = rallyKey(from, to)
  return serialized(rallyLocks, key, async () => {
    const now = Date.now()
    const windowMs = rallyWindowMs(ctx)
    const previous = (await ctx.storage.get(key)) as { count?: number; at?: number } | undefined
    const count = previous && previous.at && now - previous.at < windowMs ? (previous.count ?? 0) + 1 : 1
    await ctx.storage.set(key, { count, at: now })
    return count
  })
}

/** Current rally usage without incrementing it. */
async function rallyRemaining(
  ctx: PostalContext,
  from: string,
  to: string,
): Promise<{ used: number; max: number; remaining: number; lastAt?: number; resetAt?: number }> {
  const key = rallyKey(from, to)
  const now = Date.now()
  const windowMs = rallyWindowMs(ctx)
  const previous = (await ctx.storage.get(key)) as { count?: number; at?: number } | undefined
  const used = previous && previous.at && now - previous.at < windowMs ? previous.count ?? 0 : 0
  const last = (await ctx.storage.get(`last/${key}`)) as number | undefined
  const max = maxRally(ctx)
  return {
    used,
    max,
    remaining: Math.max(0, max - used),
    ...(typeof last === "number" ? { lastAt: last } : {}),
    ...(previous?.at ? { resetAt: previous.at + windowMs } : {}),
  }
}

const OUTBOX_INDEX = "outbox/index"
const outboxLocks = new Map<string, Promise<unknown>>()
const claimLocks = new Map<string, Promise<unknown>>()
const peerLocks = new Map<string, Promise<unknown>>()
const outboxTimers = new Map<string, ReturnType<typeof setInterval>>()
const lastOutboxCleanupAt = new Map<string, number>()
const MAX_OUTBOX_ATTEMPTS = 6
const RETRY_INTERVAL_MS = 15_000

function retryDelay(attempts: number): number {
  return Math.min(5 * 60_000, 1000 * 2 ** Math.max(0, attempts - 1))
}

/** Sender-scoped keys so one session's msg_id cannot block another session's mail. */
function outboxKey(from: string, msgID: string): string {
  return `outbox/${encodeURIComponent(from)}/${encodeURIComponent(msgID)}`
}

function messageKey(from: string, msgID: string): string {
  return `msg/${encodeURIComponent(from)}/${encodeURIComponent(msgID)}`
}

function pairLockKey(a: string, b: string): string {
  return [a, b].sort().join(":")
}

/** Serialize a critical section across OpenCode server processes when SQLite is available. */
async function crossProcessLock<T>(
  ctx: PostalContext,
  key: string,
  task: () => Promise<T> | T,
): Promise<T> {
  const configured =
    typeof ctx.options?.statePath === "string" ? ctx.options.statePath : defaultLockStorePath()
  const store = await openLockStore(configured)
  if (!store) return task()
  return store.withLock(key, task)
}

function stateLock(ctx: PostalContext): Lock {
  return (key, task) => crossProcessLock(ctx, key, task)
}

async function treeGrantAnnotations(ctx: PostalContext): Promise<Record<string, string>> {
  const annotations: Record<string, string> = {}
  for (const grant of await listGrants(ctx)) {
    const allowed = allowedOperations(grant)
    if (allowed.length === 0) continue
    const label = `[${allowed.join(",")}]`
    annotations[grant.from] = `${annotations[grant.from] ?? ""} →${grant.to}${label}`.trim()
    annotations[grant.to] = `${annotations[grant.to] ?? ""} ←${grant.from}${label}`.trim()
  }
  return annotations
}

async function readOutboxIndex(ctx: PostalContext): Promise<string[]> {
  const value = await ctx.storage.get(OUTBOX_INDEX)
  if (!Array.isArray(value)) return []
  return value
    .filter((id): id is string => typeof id === "string")
    .map((id) => (id.startsWith("outbox/") ? id : `outbox/${id}`))
}

async function writeOutboxIndex(ctx: PostalContext, keys: string[]): Promise<void> {
  if (keys.length === 0) await ctx.storage.remove(OUTBOX_INDEX)
  else await ctx.storage.set(OUTBOX_INDEX, keys)
}

async function addOutboxIndex(ctx: PostalContext, key: string): Promise<void> {
  await serialized(outboxLocks, "index", () =>
    crossProcessLock(ctx, "outbox/index", async () => {
      const index = await readOutboxIndex(ctx)
      if (!index.includes(key)) {
        index.push(key)
        await writeOutboxIndex(ctx, index)
      }
    }),
  )
}

async function removeOutboxIndex(ctx: PostalContext, key: string): Promise<void> {
  await serialized(outboxLocks, "index", () =>
    crossProcessLock(ctx, "outbox/index", async () => {
      const index = await readOutboxIndex(ctx)
      const next = index.filter((entry) => entry !== key)
      if (next.length !== index.length) await writeOutboxIndex(ctx, next)
    }),
  )
}

async function getOutbox(
  ctx: PostalContext,
  msgID: string,
  from: string,
): Promise<OutboxRecord | undefined> {
  const value = await ctx.storage.get(outboxKey(from, msgID))
  if (value && typeof value === "object") return value as OutboxRecord
  const legacy = await ctx.storage.get(`outbox/${msgID}`)
  if (legacy && typeof legacy === "object" && (legacy as OutboxRecord).from === from) {
    return legacy as OutboxRecord
  }
  return undefined
}

async function putOutbox(ctx: PostalContext, record: OutboxRecord): Promise<void> {
  const key = outboxKey(record.from, record.msgID)
  await crossProcessLock(ctx, key, async () => {
    await ctx.storage.set(key, record)
    try {
      await addOutboxIndex(ctx, key)
    } catch (error) {
      // Never leave a record that the index cannot reach.
      await ctx.storage.remove(key).catch(() => {})
      throw error
    }
  })
}

async function updateOutbox(ctx: PostalContext, record: OutboxRecord): Promise<void> {
  const key = outboxKey(record.from, record.msgID)
  await ctx.storage.set(key, record)
  await addOutboxIndex(ctx, key)
  const legacyKey = `outbox/${record.msgID}`
  if (legacyKey !== key) {
    const legacy = await ctx.storage.get(legacyKey)
    if (legacy && typeof legacy === "object" && (legacy as OutboxRecord).from === record.from) {
      await ctx.storage.remove(legacyKey)
      await removeOutboxIndex(ctx, legacyKey)
    }
  }
}

const RECEIPT_INDEX = "receipt/index"

function receiptKey(from: string, to: string, msgID: string): string {
  return `receipt/${encodeURIComponent(from)}/${encodeURIComponent(to)}/${encodeURIComponent(msgID)}`
}

async function readReceiptIndex(ctx: PostalContext): Promise<string[]> {
  const value = await ctx.storage.get(RECEIPT_INDEX)
  return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : []
}

async function writeReceiptIndex(ctx: PostalContext, keys: string[]): Promise<void> {
  if (keys.length === 0) await ctx.storage.remove(RECEIPT_INDEX)
  else await ctx.storage.set(RECEIPT_INDEX, keys)
}

async function readReceipt(
  ctx: PostalContext,
  from: string,
  to: string,
  msgID: string,
): Promise<ReceiptRecord | undefined> {
  const value = await ctx.storage.get(receiptKey(from, to, msgID))
  return value && typeof value === "object" ? (value as ReceiptRecord) : undefined
}

async function putReceipt(ctx: PostalContext, receipt: ReceiptRecord): Promise<void> {
  const key = receiptKey(receipt.from, receipt.to, receipt.msgID)
  const existing = (await ctx.storage.get(key)) as ReceiptRecord | undefined
  // Never overwrite an explicit acceptance with a rejection.
  if (existing?.status === "accepted") return
  await ctx.storage.set(key, receipt)
  await serialized(outboxLocks, "receipt-index", async () => {
    const index = await readReceiptIndex(ctx)
    if (!index.includes(key)) {
      index.push(key)
      await writeReceiptIndex(ctx, index)
    }
  })
}

async function removeReceipt(ctx: PostalContext, from: string, to: string, msgID: string): Promise<void> {
  const key = receiptKey(from, to, msgID)
  await ctx.storage.remove(key)
  await serialized(outboxLocks, "receipt-index", async () => {
    const index = await readReceiptIndex(ctx)
    const next = index.filter((entry) => entry !== key)
    if (next.length !== index.length) await writeReceiptIndex(ctx, next)
  })
}

/** Apply receiver receipts to delivered records (rejected + admitted time). */
async function reconcileOutbox(ctx: PostalContext): Promise<void> {
  const records = await listOutboxRaw(ctx)
  for (const record of records) {
    if (record.status !== "delivered") continue
    await crossProcessLock(ctx, outboxKey(record.from, record.msgID), async () => {
      const current = await getOutbox(ctx, record.msgID, record.from)
      if (!current || current.status !== "delivered") return
      const receipt = await readReceipt(ctx, current.from, current.to, current.msgID)
      if (!receipt) return
      if (receipt.status === "rejected") {
        current.status = "rejected"
        current.lastError = receipt.reason ?? "rejected"
        await updateOutbox(ctx, current)
      } else if (current.admittedAt !== receipt.verifiedAt || current.authorizedBy !== receipt.authorizedBy) {
        current.admittedAt = receipt.verifiedAt
        current.authorizedBy = receipt.authorizedBy
        await updateOutbox(ctx, current)
      }
    })
  }
}

async function listOutboxRaw(ctx: PostalContext, from?: string): Promise<OutboxRecord[]> {
  const keys = await readOutboxIndex(ctx)
  const records = await Promise.all(
    keys.map(async (key) => {
      const value = await ctx.storage.get(key)
      return value && typeof value === "object" ? (value as OutboxRecord) : undefined
    }),
  )
  return records.filter((record): record is OutboxRecord => Boolean(record) && (!from || record!.from === from))
}

async function listOutbox(ctx: PostalContext, from?: string): Promise<OutboxRecord[]> {
  await reconcileOutbox(ctx)
  return listOutboxRaw(ctx, from)
}

async function markOutboxAcked(
  ctx: PostalContext,
  msgID: string,
  expected: { sessionID: string; peerID: string },
): Promise<void> {
  await crossProcessLock(ctx, outboxKey(expected.sessionID, msgID), () =>
    serialized(outboxLocks, `record/${expected.sessionID}/${msgID}`, async () => {
      const record = await getOutbox(ctx, msgID, expected.sessionID)
      if (!record) return
      if (record.from !== expected.sessionID || record.to !== expected.peerID) return
      if (record.status === "delivered" || record.status === "pending") {
        record.status = "acked"
        record.ackedAt = Date.now()
        await updateOutbox(ctx, record)
      }
    }),
  )
}

/** Retry one outbox record and persist its new state. */
async function attemptOutbox(ctx: PostalContext, input: OutboxRecord): Promise<OutboxRecord> {
  return crossProcessLock(ctx, outboxKey(input.from, input.msgID), () =>
    serialized(outboxLocks, `record/${input.from}/${input.msgID}`, async () => {
    const record = await getOutbox(ctx, input.msgID, input.from)
    if (!record) {
      return { ...input, status: "failed", lastError: "outbox record missing", nextAt: 0 }
    }
    if (record.status !== "pending") return record
    // F-08: a grant may have been revoked after the record was created.
    const operation: Operation = record.envelope.kind === "task" ? "task" : "send"
    const relation = await ensureGrant(ctx, stateLock(ctx), record.from, record.to)
    if (!relation || !isRuleActive(relation.operations[operation], operation)) {
      record.status = "revoked"
      record.lastError = "grant_revoked"
      await updateOutbox(ctx, record)
      return record
    }
    if (record.queuedForWindow) {
      // The rally window has passed; count this delivery as the first letter
      // of the new window.
      record.rally = await nextRally(ctx, record.from, record.to)
      record.queuedForWindow = false
    }
    try {
      await postOnly(ctx, {
        from: record.from,
        to: record.to,
        body: record.body,
        rally: record.rally,
        max: record.max,
        envelope: record.envelope,
      })
      record.status = "delivered"
      record.attempts += 1
      record.nextAt = 0
      record.lastError = undefined
    } catch (error) {
      record.attempts += 1
      record.lastError = errorText(error)
      if (record.attempts >= MAX_OUTBOX_ATTEMPTS) {
        record.status = "failed"
      } else {
        record.status = "pending"
        record.nextAt = Date.now() + retryDelay(record.attempts)
      }
    }
      await updateOutbox(ctx, record)
      return record
    }),
  )
}

async function dispatchLetter(
  ctx: PostalContext,
  options: {
    from: string
    to: string
    body: string
    envelope: Envelope
    queueOnLimit?: boolean
  },
): Promise<{
  ok: boolean
  msgID: string
  status: "delivered" | "queued" | "retry" | "failed" | "duplicate" | "rally-limit"
  error?: string
  nextAt?: number
  attempts?: number
}> {
  return crossProcessLock(
    ctx,
    `msg/${encodeURIComponent(options.from)}/${encodeURIComponent(options.envelope.msgID)}`,
    () => dispatchLetterLocked(ctx, options),
  )
}

/** Deliver immediately, or persist a retry/queued record when delivery fails. */
async function dispatchLetterLocked(
  ctx: PostalContext,
  options: {
    from: string
    to: string
    body: string
    envelope: Envelope
    queueOnLimit?: boolean
  },
): Promise<{
  ok: boolean
  msgID: string
  status: "delivered" | "queued" | "retry" | "failed" | "duplicate" | "rally-limit"
  error?: string
  nextAt?: number
  attempts?: number
}> {
  const existingMessage = await ctx.storage.get(messageKey(options.from, options.envelope.msgID))
  const existingOutbox = await getOutbox(ctx, options.envelope.msgID, options.from)
  if (existingMessage || existingOutbox) {
    return { ok: true, msgID: options.envelope.msgID, status: "duplicate" }
  }

  const max = maxRally(ctx)
  const rally = await nextRally(ctx, options.from, options.to)
  if (rally > max) {
    if (!options.queueOnLimit) {
      return {
        ok: false,
        msgID: options.envelope.msgID,
        status: "rally-limit",
        error: `rally limit reached (${max} letters)`,
      }
    }
    const state = (await ctx.storage.get(rallyKey(options.from, options.to))) as { at?: number } | undefined
    const nextAt = (state?.at ?? Date.now()) + rallyWindowMs(ctx)
    const record: OutboxRecord = {
      msgID: options.envelope.msgID,
      from: options.from,
      to: options.to,
      body: options.body,
      envelope: options.envelope,
      rally: 1,
      max,
      createdAt: Date.now(),
      attempts: 0,
      nextAt,
      status: "pending",
      queuedForWindow: true,
    }
    await putOutbox(ctx, record)
    return { ok: true, msgID: options.envelope.msgID, status: "queued", nextAt }
  }

  const record: OutboxRecord = {
    msgID: options.envelope.msgID,
    from: options.from,
    to: options.to,
    body: options.body,
    envelope: options.envelope,
    rally,
    max,
    createdAt: Date.now(),
    attempts: 0,
    nextAt: 0,
    status: "pending",
  }
  await putOutbox(ctx, record)
  const result = await attemptOutbox(ctx, record)
  if (result.status === "delivered") {
    return { ok: true, msgID: result.msgID, status: "delivered" }
  }
  if (result.status === "failed") {
    return { ok: false, msgID: result.msgID, status: "failed", error: result.lastError, attempts: result.attempts }
  }
  return {
    ok: false,
    msgID: result.msgID,
    status: "retry",
    error: result.lastError,
    nextAt: result.nextAt,
    attempts: result.attempts,
  }
}

const retryInFlight = new Set<string>()

/** Retry due records in parallel; a hung destination only holds its own slot. */
async function retryOutbox(ctx: PostalContext, from?: string): Promise<void> {
  const now = Date.now()
  const records = await listOutbox(ctx, from)
  const due = records.filter((record) => {
    if (record.status !== "pending" || record.nextAt > now) return false
    return !retryInFlight.has(`${ctx.location.directory}:${record.from}/${record.msgID}`)
  })
  await Promise.allSettled(
    due.map(async (record) => {
      const id = `${ctx.location.directory}:${record.from}/${record.msgID}`
      retryInFlight.add(id)
      try {
        await attemptOutbox(ctx, record)
      } finally {
        retryInFlight.delete(id)
      }
    }),
  )
}

/** Nudge idle workers that still have an unacked task letter. */
async function runWatchdog(
  ctx: PostalContext,
  options: { dryRun?: boolean; afterSeconds?: number; nudgeUnknown?: boolean; from?: string } = {},
): Promise<{ candidates: OutboxRecord[]; nudged: string[] }> {
  const afterMs =
    typeof options.afterSeconds === "number" && options.afterSeconds >= 0
      ? options.afterSeconds * 1000
      : watchdogAfterMs(ctx)
  const intervalMs = watchdogIntervalMs(ctx)
  const maxNudges = watchdogMaxNudges(ctx)
  const nudgeUnknown = options.nudgeUnknown === true || ctx.options?.watchdogNudgeUnknown === true
  const now = Date.now()
  const records = await listOutbox(ctx, options.from)
  const candidates = records.filter(
    (record) =>
      record.status === "delivered" &&
      record.envelope.kind === "task" &&
      now - record.createdAt >= afterMs &&
      (record.nudges ?? 0) < maxNudges &&
      (!record.lastNudgeAt || now - record.lastNudgeAt >= intervalMs),
  )
  const nudged: string[] = []
  if (options.dryRun) return { candidates, nudged }

  for (const record of candidates) {
    const presence = await readPresence(ctx, record.to)
    const state = presence?.state ?? "unknown"
    if (state !== "idle" && !(state === "unknown" && nudgeUnknown)) continue
    const task = record.envelope.taskID ? `task ${record.envelope.taskID}` : `message ${record.msgID}`
    const result = await dispatchLetter(ctx, {
      from: record.from,
      to: record.to,
      body:
        `Watchdog: ${task} is still open and the worker appears ${state}. ` +
        `Please report status or complete it. Reply with postal_send and pass reply_to: ${record.msgID}.`,
      envelope: {
        kind: "system",
        taskID: record.envelope.taskID,
        replyTo: record.msgID,
        msgID: generateMsgID(),
        artifacts: [],
        commands: [],
      },
      queueOnLimit: true,
    })
    if (result.status !== "failed" && result.status !== "rally-limit") {
      await crossProcessLock(ctx, outboxKey(record.from, record.msgID), async () => {
        const current = await getOutbox(ctx, record.msgID, record.from)
        if (!current) return
        current.nudges = (current.nudges ?? 0) + 1
        current.lastNudgeAt = now
        await updateOutbox(ctx, current)
      })
      nudged.push(record.msgID)
    }
  }
  return { candidates, nudged }
}

/** Remove expired receiver dedupe markers. */
async function cleanupSeen(ctx: PostalContext): Promise<void> {
  if (typeof ctx.storage.scan !== "function") return
  let after: string | undefined
  for (let page = 0; page < 20; page += 1) {
    const result = await ctx.storage.scan({
      prefix: "seen/",
      limit: 200,
      ...(after ? { after } : {}),
    })
    for (const entry of result.entries ?? []) {
      const value = entry.value
      if (typeof value !== "number" || Date.now() - value > SEEN_TTL_MS) {
        await ctx.storage.remove(entry.key)
      }
    }
    after = result.next
    if (!after) break
  }
}

/** Remove old delivered/acked/failed outbox records; msg markers stay for idempotency. */
async function cleanupOutbox(
  ctx: PostalContext,
  options: { dryRun?: boolean; from?: string } = {},
): Promise<OutboxRecord[]> {
  const ttl = outboxTtlMs(ctx)
  const now = Date.now()
  const records = await listOutbox(ctx, options.from)
  const expired = records.filter(
    (record) =>
      (record.status === "delivered" ||
        record.status === "acked" ||
        record.status === "rejected" ||
        record.status === "revoked" ||
        record.status === "failed") &&
      now - record.createdAt > ttl,
  )
  if (options.dryRun || expired.length === 0) return expired
  const keys = new Set<string>()
  const receiptKeys = new Set<string>()
  for (const record of expired) {
    await crossProcessLock(ctx, outboxKey(record.from, record.msgID), async () => {
      const key = outboxKey(record.from, record.msgID)
      keys.add(key)
      await ctx.storage.remove(key)
      const receipt = receiptKey(record.from, record.to, record.msgID)
      receiptKeys.add(receipt)
      await ctx.storage.remove(receipt)
      const legacyKey = `outbox/${record.msgID}`
      keys.add(legacyKey)
      const legacy = await ctx.storage.get(legacyKey)
      if (legacy && typeof legacy === "object" && (legacy as OutboxRecord).from === record.from) {
        await ctx.storage.remove(legacyKey)
      }
    })
  }
  await serialized(outboxLocks, "index", () =>
    crossProcessLock(ctx, "outbox/index", async () => {
      const index = await readOutboxIndex(ctx)
      await writeOutboxIndex(ctx, index.filter((key) => !keys.has(key)))
    }),
  )
  await serialized(outboxLocks, "receipt-index", async () => {
    const index = await readReceiptIndex(ctx)
    const keep: string[] = []
    for (const key of index) {
      if (receiptKeys.has(key)) continue
      if (options.from === undefined) {
        const value = (await ctx.storage.get(key)) as ReceiptRecord | undefined
        if (!value || now - value.verifiedAt > ttl) {
          await ctx.storage.remove(key)
          continue
        }
      }
      keep.push(key)
    }
    await writeReceiptIndex(ctx, keep)
  })
  return expired
}

/**
 * Mention path: forward immediately. The receiver answers with postal_send,
 * which starts the sender's next turn. Nothing waits and nothing is queued.
 */
async function relayMention(ctx: PostalContext, input: { from: string; to: string; body: string }): Promise<void> {
  const { from, to, body } = input
  if (from === to) return
  const max = maxRally(ctx)
  const rally = await nextRally(ctx, from, to)
  if (rally > max) {
    console.warn(`postal: mention rally limit reached (${max} letters) ${from} -> ${to}`)
    return
  }
  try {
    await postOnly(ctx, { from, to, body, rally, max })
  } catch (error) {
    console.warn(`postal: mention delivery to ${to} failed: ${errorText(error)}`)
  }
}

/** Clear a session's postal-peer instruction note (best effort). */
async function clearNote(ctx: PostalContext, sessionID: string): Promise<void> {
  try {
    const entries = ctx.session.instructions.entry
    if (entries.remove) {
      await entries.remove({ sessionID, key: "postal-peer" }).catch(() => {})
    } else {
      await entries.put({ sessionID, key: "postal-peer", value: "" }).catch(() => {})
    }
  } catch {
    // Instruction entries are optional in some runtimes.
  }
}

function isPeerRecord(value: unknown): value is PeerRecord {
  return Boolean(value && typeof value === "object" && typeof (value as PeerRecord).id === "string")
}

/** Read all peers for a session, migrating the old single-peer record. */
async function readPeers(ctx: PostalContext, sessionID: string): Promise<PeerRecord[]> {
  const stored = await ctx.storage.get(`peers/${sessionID}`)
  if (Array.isArray(stored)) return stored.filter(isPeerRecord)
  const legacy = (await ctx.storage.get(`peer/${sessionID}`)) as PeerRecord | undefined
  if (!legacy?.id) return []
  const peers = [legacy]
  await ctx.storage.set(`peers/${sessionID}`, peers)
  await ctx.storage.remove(`peer/${sessionID}`)
  return peers
}

async function writePeers(ctx: PostalContext, sessionID: string, peers: PeerRecord[]): Promise<void> {
  if (peers.length === 0) await ctx.storage.remove(`peers/${sessionID}`)
  else await ctx.storage.set(`peers/${sessionID}`, peers)
}

async function addPeer(ctx: PostalContext, sessionID: string, peer: PeerRecord): Promise<void> {
  const peers = await readPeers(ctx, sessionID)
  if (!peers.some((item) => item.id === peer.id)) peers.push(peer)
  await writePeers(ctx, sessionID, peers)
}

async function removePeer(ctx: PostalContext, sessionID: string, peerID: string): Promise<boolean> {
  const peers = await readPeers(ctx, sessionID)
  const next = peers.filter((peer) => peer.id !== peerID)
  if (next.length === peers.length) return false
  await writePeers(ctx, sessionID, next)
  return true
}

/** Refresh the instruction note so the AI sees every connected peer. */
async function refreshNote(ctx: PostalContext, sessionID: string): Promise<void> {
  try {
    const peers = await readPeers(ctx, sessionID)
    if (peers.length === 0) {
      await clearNote(ctx, sessionID)
      return
    }
    const listing = peers.map((peer) => `${peer.id}${peer.title ? ` (${peer.title})` : ""}`).join(", ")
    const note =
      peers.length === 1
        ? `Postal peer: ${listing}. Use postal_send without 'to' to write to this peer.`
        : `Postal peers: ${listing}. Pass 'to' explicitly when more than one peer is connected.`
    await ctx.session.instructions.entry.put({ sessionID, key: "postal-peer", value: note })
  } catch {
    // Instruction entries are optional; never fall back to a queued message.
  }
}

/** Pair two sessions; both sides keep every peer they have connected. */
async function pair(ctx: PostalContext, from: string, peerID: string): Promise<PairResult> {
  if (!peerID || peerID === from) return { ok: false, error: "invalid peer" }
  return crossProcessLock(ctx, "peers", () =>
    serialized(peerLocks, pairLockKey(from, peerID), async () => {
      try {
        const [self, peer] = await Promise.all([
          ctx.session.get({ sessionID: from }),
          ctx.session.get({ sessionID: peerID }),
        ])
        await addPeer(ctx, from, { id: peerID, title: peer.title ?? "" })
        await addPeer(ctx, peerID, { id: from, title: self.title ?? "" })
        await ensureHmacRecord(ctx, from, peerID)
        await ensureGrant(ctx, stateLock(ctx), from, peerID)
        await ensureGrant(ctx, stateLock(ctx), peerID, from)
        await Promise.all([refreshNote(ctx, from), refreshNote(ctx, peerID)])
        return { ok: true, peerID, title: peer.title ?? "" }
      } catch (error) {
        console.warn(`postal: pairing ${from} <-> ${peerID} failed: ${errorText(error)}`)
        return { ok: false, error: errorText(error) }
      }
    }),
  )
}

/** Read all peers for a session, dropping records whose session is gone. */
async function peerStatus(ctx: PostalContext, sessionID: string): Promise<PairResult> {
  try {
    const peers = await readPeers(ctx, sessionID)
    const live = (
      await Promise.all(
        peers.map(async (peer) => {
          try {
            const info = await ctx.session.get({ sessionID: peer.id })
            return { id: peer.id, title: info?.title ?? peer.title ?? "" }
          } catch {
            return undefined
          }
        }),
      )
    ).filter((peer): peer is PeerRecord => Boolean(peer))
    // Read-only: a transient lookup failure must not delete the pair.
    // Explicit disconnect (or a future prune command) owns removal.
    const result: PairResult = { ok: true, peers: live }
    if (live[0]) {
      result.peerID = live[0].id
      result.title = live[0].title
    }
    return result
  } catch (error) {
    return { ok: false, error: errorText(error) }
  }
}

/** Disconnect one peer, or every peer when peerID is omitted. */
async function disconnect(ctx: PostalContext, sessionID: string, peerID?: string): Promise<PairResult> {
  return crossProcessLock(ctx, "peers", () => disconnectLocked(ctx, sessionID, peerID))
}

async function disconnectLocked(ctx: PostalContext, sessionID: string, peerID?: string): Promise<PairResult> {
  try {
    const peers = await readPeers(ctx, sessionID)
    const targets = peerID ? peers.filter((peer) => peer.id === peerID) : peers
    if (peerID && targets.length === 0) {
      // The other side may still have a one-sided record; clean it anyway.
      await removePeer(ctx, peerID, sessionID)
      await clearNote(ctx, sessionID)
      return { ok: true, peerID }
    }
    for (const peer of targets) {
      await removePeer(ctx, peer.id, sessionID)
    }
    if (peerID) await removePeer(ctx, sessionID, peerID)
    else await writePeers(ctx, sessionID, [])
    await refreshNote(ctx, sessionID)
    await Promise.all(targets.map((peer) => refreshNote(ctx, peer.id)))
    const result: PairResult = { ok: true }
    const chosen = peerID ?? targets[0]?.id
    if (chosen) result.peerID = chosen
    if (targets[0]?.title) result.title = targets[0].title
    return result
  } catch (error) {
    console.warn(`postal: disconnect ${sessionID} failed: ${errorText(error)}`)
    return { ok: false, error: errorText(error) }
  }
}

async function setup(ctx: PostalContext): Promise<void> {
  try {
    await ctx.rpc.register(PostalRpc, {
      connect: async (input) => pair(ctx, String(input.sessionID), String(input.peerID)),
      disconnect: async (input) =>
        disconnect(ctx, String(input.sessionID), typeof input.peerID === "string" ? input.peerID : undefined),
      status: async (input) => peerStatus(ctx, String(input.sessionID)),
      tree: async (input) => {
        const sessionID = String(input.sessionID)
        const root = typeof input.root === "string" ? input.root : undefined
        const rawDepth = Number(input.depth)
        const depth = Number.isFinite(rawDepth) ? Math.max(1, Math.floor(rawDepth)) : undefined
        const annotations = await treeGrantAnnotations(ctx)
        const tree = await renderSessionTree(ctx, {
          callerID: sessionID,
          root,
          depth,
          all: input.all === true,
          annotations,
        })
        const spawn = await readSpawnFact(ctx, sessionID)
        return { ok: true, tree: `SPAWNED_BY\t${spawn?.spawnedBy ?? "-"}\n${tree}` }
      },
      presence: async (input) => {
        const sessions = Array.isArray(input.sessions) ? input.sessions : []
        const now = Date.now()
        try {
          for (const raw of sessions.slice(0, 50)) {
            if (!raw || typeof raw !== "object") continue
            const item = raw as {
              id?: unknown
              title?: unknown
              state?: unknown
              pending?: unknown
            }
            const id = typeof item.id === "string" ? item.id : ""
            if (!id.startsWith("ses")) continue
            const state =
              item.state === "running" || item.state === "idle" || item.state === "unknown"
                ? item.state
                : "unknown"
            const pending: PresenceItem[] = []
            if (Array.isArray(item.pending)) {
              for (const entry of item.pending.slice(0, 20)) {
                if (!entry || typeof entry !== "object") continue
                const value = entry as { id?: unknown; type?: unknown; source?: unknown }
                pending.push({
                  ...(typeof value.id === "string" && value.id ? { id: value.id } : {}),
                  ...(typeof value.type === "string" && value.type ? { type: value.type } : {}),
                  ...(typeof value.source === "string" && value.source ? { source: value.source } : {}),
                })
              }
            }
            const record: PresenceRecord = {
              id,
              title: typeof item.title === "string" ? item.title.slice(0, 200) : "",
              state,
              pending,
              reportedAt: now,
            }
            await ctx.storage.set(`presence/${id}`, record)
          }
          return { ok: true }
        } catch (error) {
          return { ok: false, error: errorText(error) }
        }
      },
    })
  } catch (error) {
    console.warn(`postal: rpc registration failed: ${errorText(error)}`)
  }

  // Register the Postal skill when the runtime exposes skill transforms.
  try {
    if (ctx.skill && typeof ctx.skill.transform === "function") {
      const skillPath = join(dirname(fileURLToPath(import.meta.url)), "skills", "postal", "SKILL.md")
      const content = readFileSync(skillPath, "utf8")
      await ctx.skill.transform((editor) => {
        const add = editor.add
        if (typeof add !== "function") return
        add({
          id: "postal",
          name: "Postal",
          description:
            "Send mail between OpenCode sessions with @ses_ mentions or postal_send; " +
            "pair peers, continue AI-to-AI rallies, and troubleshoot delivery.",
          path: skillPath,
          content,
          autoinvoke: true,
        })
      })
    }
  } catch (error) {
    console.warn(`postal: skill registration skipped: ${errorText(error)}`)
  }

  // Tool: address book + sending (used by agents).
  await ctx.tool.transform((editor) => {
    editor.namespace({ name: "postal", description: "Session-to-session postal service" })

    editor.add({
      name: "directory",
      description:
        "List OpenCode sessions (mail addresses) in this project. Returns session IDs and titles. " +
        "Address another session as @ses_ID in a prompt, or send it mail with postal_send.",
      input: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_input, context) => {
        const page = await ctx.session.list({ limit: 50, directory: ctx.location.directory })
        const rows = (page.data ?? [])
          .filter((session) => session.id !== context.sessionID)
          .map((session) => `${session.id}\t${session.title ?? "(untitled)"}`)
        return { content: ["SESSION_ID\tTITLE", ...rows].join("\n") }
      },
    })

    editor.add({
      name: "peers",
      description:
        "List the sessions connected to this session via Postal. Returns PEER_ID<TAB>TITLE. " +
        "Use these IDs with postal_send when more than one peer is connected.",
      input: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_input, context) => {
        const status = await peerStatus(ctx, context.sessionID)
        const rows = (status.peers ?? []).map((peer) => `${peer.id}\t${peer.title || "(untitled)"}`)
        return { content: ["PEER_ID\tTITLE", ...rows].join("\n") }
      },
    })

    editor.add({
      name: "tree",
      description:
        "Show the session parent/child/ancestor tree. Defaults to the caller's root; use all for every root.",
      input: {
        type: "object",
        properties: {
          root: { type: "string", description: "Session ID to render as the root" },
          depth: { type: "number", description: "Maximum tree depth (default 32)" },
          all: { type: "boolean", description: "Show every root in this server" },
        },
        additionalProperties: false,
      },
      execute: async (input, context) => {
        const value = input as { root?: string; depth?: number; all?: boolean }
        const depth = Number.isFinite(value.depth) ? Math.max(1, Math.floor(value.depth as number)) : undefined
        const annotations = await treeGrantAnnotations(ctx)
        const tree = await renderSessionTree(ctx, {
          callerID: context.sessionID,
          root: value.root?.trim() || undefined,
          depth,
          all: value.all === true,
          annotations,
        })
        const spawn = await readSpawnFact(ctx, context.sessionID)
        return { content: `SPAWNED_BY\t${spawn?.spawnedBy ?? "-"}\n${tree}` }
      },
    })

    editor.add({
      name: "status",
      description:
        "Show connected peers, remaining rally budget, and the last letter time. " +
        "Pass sessionID to inspect another session.",
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
        },
        additionalProperties: false,
      },
      execute: async (input, context) => {
        const target =
          typeof (input as { sessionID?: unknown }).sessionID === "string" &&
          (input as { sessionID: string }).sessionID.length > 0
            ? (input as { sessionID: string }).sessionID
            : context.sessionID
        if (!(await canInspect(ctx, context.sessionID, target))) {
          return { content: "postal: not authorized to inspect another session" }
        }
        const status = await peerStatus(ctx, target)
        if (status.ok === false) return { content: `postal: status failed: ${status.error ?? "unknown error"}` }
        const peers = status.peers ?? []
        const outbox = await listOutbox(ctx, target)
        const selfPresence = await readPresence(ctx, target)
        const parent = await readParent(ctx, target)
        const rows = await Promise.all(
          peers.map(async (peer) => {
            const rally = await rallyRemaining(ctx, target, peer.id)
            const last = rally.lastAt ? new Date(rally.lastAt).toISOString() : "-"
            const reset = rally.resetAt ? new Date(rally.resetAt).toISOString() : "-"
            const presence = await readPresence(ctx, peer.id)
            const state = presence?.state ?? "unknown"
            const inbox = presence?.pending.length ?? 0
            const seen = presence ? new Date(presence.reportedAt).toISOString() : "-"
            return `${peer.id}\t${peer.title || "(untitled)"}\t${rally.remaining}/${rally.max}\t${last}\t${reset}\t${state}\t${inbox}\t${seen}`
          }),
        )
        return {
          content: [
            `SESSION_ID\t${target}`,
            `SESSION_STATE\t${selfPresence?.state ?? "unknown"}`,
            `SESSION_INBOX\t${selfPresence?.pending.length ?? 0}`,
            `SESSION_PARENT\t${parent?.parentID ?? "-"}`,
            `SESSION_ORPHAN\t${parent ? "no" : "yes — no parent; no one can close this session"}`,
            `OUTBOX_PENDING\t${outbox.filter((record) => record.status === "pending").length}`,
            `OUTBOX_REJECTED\t${outbox.filter((record) => record.status === "rejected").length}`,
            `OUTBOX_REVOKED\t${outbox.filter((record) => record.status === "revoked").length}`,
            "PEER_ID\tTITLE\tRALLY_REMAINING\tLAST_LETTER\tRALLY_RESET_AT\tSTATE\tINBOX_COUNT\tPRESENCE_AT",
            ...rows,
          ].join("\n"),
        }
      },
    })

    editor.add({
      name: "grant",
      description:
        "Grant operations to a paired or spawned relation. The caller grants its own operations toward 'to'.",
      input: {
        type: "object",
        properties: {
          to: { type: "string", description: "Target session ID" },
          operations: {
            type: "array",
            items: { type: "string", enum: [...OPERATIONS] },
          },
          approvalRequired: { type: "boolean" },
          expiresAt: { type: "number", description: "Epoch milliseconds" },
        },
        required: ["to", "operations"],
        additionalProperties: false,
      },
      execute: async (input, context) => {
        const value = input as {
          to?: string
          operations?: unknown
          approvalRequired?: boolean
          expiresAt?: number
        }
        const to = value.to?.trim()
        if (!to) return { content: "postal: 'to' is required" }
        const operations = Array.isArray(value.operations)
          ? value.operations.filter(
              (operation): operation is Operation =>
                typeof operation === "string" && (OPERATIONS as readonly string[]).includes(operation),
            )
          : []
        if (operations.length === 0) return { content: "postal: at least one valid operation is required" }
        const authority = operations.filter((operation) => operation !== "send")
        if (authority.length > 0) {
          const parentRecord = (await ctx.storage.get(`parent/${to}`)) as { parentID?: unknown } | undefined
          const spawn = await readSpawnFact(ctx, to)
          const owner =
            typeof parentRecord?.parentID === "string" ? parentRecord.parentID : spawn?.spawnedBy
          if (owner !== context.sessionID) {
            return { content: "postal: only the spawn parent can grant authority over a session" }
          }
        }
        try {
          const grant = await grantOperations(ctx, stateLock(ctx), context.sessionID, to, operations, {
            ...(typeof value.approvalRequired === "boolean" ? { approvalRequired: value.approvalRequired } : {}),
            ...(typeof value.expiresAt === "number" ? { expiresAt: value.expiresAt } : {}),
          })
          return {
            content: [
              `GRANTED\t${to}`,
              `OPERATIONS\t${operations.join(",")}`,
              `UPDATED_AT\t${new Date(grant.updatedAt).toISOString()}`,
            ].join("\n"),
          }
        } catch (error) {
          return { content: `postal: grant failed: ${errorText(error)}` }
        }
      },
    })

    editor.add({
      name: "revoke",
      description: "Revoke operations from a relation. Omit operations to revoke all of them.",
      input: {
        type: "object",
        properties: {
          to: { type: "string" },
          operations: {
            type: "array",
            items: { type: "string", enum: [...OPERATIONS] },
          },
        },
        required: ["to"],
        additionalProperties: false,
      },
      execute: async (input, context) => {
        const value = input as { to?: string; operations?: unknown }
        const to = value.to?.trim()
        if (!to) return { content: "postal: 'to' is required" }
        const operations = Array.isArray(value.operations)
          ? value.operations.filter(
              (operation): operation is Operation =>
                typeof operation === "string" && (OPERATIONS as readonly string[]).includes(operation),
            )
          : undefined
        const grant = await revokeOperations(ctx, stateLock(ctx), context.sessionID, to, operations)
        if (!grant) return { content: `postal: no grant for ${to}` }
        return { content: `postal: revoked ${operations?.join(",") ?? "all"} for ${to}` }
      },
    })

    editor.add({
      name: "relations",
      description: "Show outgoing and incoming grants, spawn fact, enforceable flags, and approval requirements.",
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
        },
        additionalProperties: false,
      },
      execute: async (input, context) => {
        const value = input as { sessionID?: string }
        const target = value.sessionID?.trim() || context.sessionID
        if (!(await canInspect(ctx, context.sessionID, target))) {
          return { content: "postal: not authorized to inspect another session" }
        }
        const grants = await listGrants(ctx, target)
        const spawn = await readSpawnFact(ctx, target)
        const rows = grants.map((grant) => {
          const direction = grant.from === target ? "out" : "in"
          const peer = grant.from === target ? grant.to : grant.from
          const allowed = allowedOperations(grant)
          const enforceable = [...new Set(allowed.map((operation) => OPERATION_SPECS[operation].enforceable))].join(",")
          const approval = allowed.filter((operation) => grant.operations[operation].approvalRequired)
          const expiries = allowed
            .map((operation) => grant.operations[operation].expiresAt)
            .filter((value): value is number => typeof value === "number")
          const expires = expiries.length > 0 ? new Date(Math.min(...expiries)).toISOString() : "-"
          return [
            direction,
            peer,
            allowed.join(",") || "-",
            enforceable || "-",
            approval.join(",") || "-",
            expires,
            grant.revokedAt ? "revoked" : "active",
          ].join("\t")
        })
        return {
          content: [
            `SESSION_ID\t${target}`,
            `SPAWNED_BY\t${spawn?.spawnedBy ?? "-"}`,
            "DIRECTION\tPEER\tOPERATIONS\tENFORCEABLE\tAPPROVAL_REQUIRED\tEXPIRES\tSTATE",
            ...(rows.length > 0 ? rows : ["(no grants)"]),
          ].join("\n"),
        }
      },
    })

    editor.add({
      name: "log",
      description:
        "Show recent [postal] messages from a session transcript for audit. " +
        "Pass sessionID for another session and limit (default 20).",
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          limit: { type: "number" },
        },
        additionalProperties: false,
      },
      execute: async (input, context) => {
        const value = input as { sessionID?: string; limit?: number }
        const target = value.sessionID?.trim() || context.sessionID
        if (!(await canInspect(ctx, context.sessionID, target))) {
          return { content: "postal: not authorized to inspect another session" }
        }
        const limit = Number.isFinite(value.limit)
          ? Math.max(1, Math.min(100, Math.floor(value.limit as number)))
          : 20
        if (typeof ctx.session.context !== "function") {
          return { content: "postal: session context is not available in this OpenCode version" }
        }
        try {
          const messages = await ctx.session.context({ sessionID: target })
          const postal = messages
            .filter((message) => messageText(message).trim().startsWith("[postal]"))
            .slice(-limit)
          if (postal.length === 0) return { content: "postal: no postal messages" }
          return {
            content: postal
              .map((message) => `--- ${messageID(message)} ${messageRole(message)} ---\n${messageText(message)}`)
              .join("\n\n"),
          }
        } catch (error) {
          return { content: `postal: log failed: ${errorText(error)}` }
        }
      },
    })

    editor.add({
      name: "spawn",
      description:
        "Create a new OpenCode session (worker) and optionally pair it with this session. " +
        "Returns the new ses_... ID; use postal_send to give it work. " +
        "model accepts provider/model[#variant].",
      input: {
        type: "object",
        properties: {
          title: { type: "string", description: "Title for the new session" },
          model: { type: "string", description: "Model as provider/model, optionally #variant" },
          agent: { type: "string", description: "Agent ID for the new session" },
          directory: {
            type: "string",
            description: "Absolute project directory; defaults to this session's location",
          },
          autoPair: { type: "boolean", description: "Pair the new session with this one (default true)" },
          permissions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                action: { type: "string" },
                resource: { type: "string" },
                effect: { type: "string", enum: ["allow", "deny", "ask"] },
              },
              required: ["action", "resource", "effect"],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      execute: async (input, context) => {
        const {
          title,
          model,
          agent,
          directory,
          permissions,
          autoPair = true,
        } = input as {
          title?: string
          model?: string
          agent?: string
          directory?: string
          permissions?: Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }>
          autoPair?: boolean
        }
        if (typeof ctx.session.create !== "function") {
          return { content: "postal: session creation is not supported by this OpenCode version" }
        }
        let models: { id: string; providerID: string; variant?: string } | undefined
        if (model) {
          const parsed = parseModel(model)
          if (parsed.error) return { content: `postal: ${parsed.error}` }
          models = parsed.model
        }
        try {
          const created = unwrapSession(
            await ctx.session.create({
              ...(title ? { title } : {}),
              ...(agent ? { agent } : {}),
              ...(models ? { model: models } : {}),
              location: { directory: directory || ctx.location.directory },
              ...(permissions ? { permissions } : {}),
            }),
          )
          if (!created) throw new Error("session create returned no id")
          await writeSpawnFact(
            ctx,
            stateLock(ctx),
            created.id,
            context.sessionID,
            directory || ctx.location.directory,
          )
          await writeParent(ctx, created.id, context.sessionID)
          await ensureGrant(ctx, stateLock(ctx), context.sessionID, created.id)
          await ensureGrant(ctx, stateLock(ctx), created.id, context.sessionID)
          let paired = false
          let pairError = ""
          if (autoPair) {
            const result = await pair(ctx, context.sessionID, created.id)
            paired = result.ok
            if (!result.ok) pairError = result.error ?? "pairing failed"
          }
          const suffix = autoPair ? (paired ? " and paired" : ` but pairing failed: ${pairError}`) : ""
          return {
            content:
              `postal: spawned ${created.id}${created.title ? ` (${created.title})` : ""}${suffix}. ` +
              `Use postal_send to give it work.`,
          }
        } catch (error) {
          return { content: `postal: spawn failed: ${errorText(error)}` }
        }
      },
    })

    editor.add({
      name: "send",
      description:
        "Send mail to another OpenCode session. Delivers immediately (non-blocking); " +
        "the peer receives it as [postal] from ... (rally n/m) and can continue by calling postal_send. " +
        "Omit 'to' only when exactly one peer is connected; use postal_peers to list peers. " +
        "Supports a structured envelope (kind/task_id/reply_to/artifacts/commands/msg_id).",
      input: {
        type: "object",
        properties: {
          to: { type: "string", description: "Target session ID (ses_...). Omit when exactly one peer is connected." },
          text: { type: "string", description: "Letter body to deliver" },
          kind: { type: "string", enum: ["task", "status", "verify", "error", "letter", "system"] },
          task_id: { type: "string" },
          reply_to: { type: "string" },
          msg_id: { type: "string", description: "Idempotency key; generated when omitted" },
          queueOnLimit: {
            type: "boolean",
            description: "If the rally limit is reached, retry after the window instead of rejecting",
          },
          artifacts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                sha256: { type: "string" },
              },
              required: ["path"],
              additionalProperties: false,
            },
          },
          commands: {
            type: "array",
            items: {
              type: "object",
              properties: {
                cmd: { type: "string" },
                exit: { type: "number" },
              },
              required: ["cmd"],
              additionalProperties: false,
            },
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
      execute: async (input, context) => {
        const value = input as {
          to?: string
          text: string
          kind?: string
          task_id?: string
          reply_to?: string
          msg_id?: string
          queueOnLimit?: boolean
          artifacts?: unknown
          commands?: unknown
        }
        const { text } = value
        let to = value.to
        let validated = false
        if (!text) return { content: "postal: 'text' is required" }
        const kind = value.kind ? parseKind(value.kind) : undefined
        if (value.kind && !kind) return { content: `postal: invalid kind: ${value.kind}` }
        const msgID = value.msg_id?.trim() || generateMsgID()
        if (!msgID || msgID.length > 128) return { content: "postal: msg_id must be 1-128 characters" }
        const taskID = value.task_id?.trim() || undefined
        const replyTo = value.reply_to?.trim() || undefined
        const artifacts = normalizeArtifacts(value.artifacts)
        const commands = normalizeCommands(value.commands)
        // R-01/R-02: only an active pair is a valid recipient. Never infer a
        // target from a live session lookup; the pair is the authorization and
        // the disconnect is the revocation point.
        const pairedPeers = await readPeers(ctx, context.sessionID)
        if (!to) {
          if (pairedPeers.length === 1) {
            to = pairedPeers[0]?.id
            validated = true
          } else if (pairedPeers.length > 1) {
            const listing = pairedPeers
              .map((peer) => `${peer.id}${peer.title ? ` (${peer.title})` : ""}`)
              .join(", ")
            return {
              content:
                `postal: ${pairedPeers.length} peers are paired (${listing}). ` +
                `Pass 'to' explicitly or call postal_peers for the list.`,
            }
          }
        }
        if (!to) {
          return {
            content:
              "postal: no paired recipient. Connect a peer with the Postal command (Ctrl+P) " +
              "or call postal_send with an explicitly paired session ID.",
          }
        }
        if (to === context.sessionID) return { content: "postal: cannot send mail to yourself" }
        if (!pairedPeers.some((peer) => peer.id === to)) {
          return {
            content: `postal: recipient is not a paired peer: ${to}. Connect it first; disconnected sessions cannot receive mail.`,
          }
        }
        if (!validated) {
          try {
            await ctx.session.get({ sessionID: to })
          } catch {
            return { content: `postal: delivery failed: session not found: ${to}` }
          }
        }
        const relation = await ensureGrant(ctx, stateLock(ctx), context.sessionID, to)
        const operation: Operation = kind === "task" ? "task" : "send"
        if (!relation || !isRuleActive(relation.operations[operation], operation)) {
          return {
            content: `postal: ${operation} is not granted for ${to}; inspect postal_relations.`,
          }
        }
        const envelope: Envelope = {
          kind: kind ?? "letter",
          taskID,
          replyTo,
          msgID,
          artifacts,
          commands,
        }
        const result = await dispatchLetter(ctx, {
          from: context.sessionID,
          to,
          body: text,
          envelope,
          queueOnLimit: value.queueOnLimit === true,
        })
        if (result.status === "duplicate") {
          return { content: `postal: duplicate msg_id ${msgID}; already delivered or queued.` }
        }
        if (result.status === "rally-limit") {
          return {
            content:
              `postal: rally limit reached (${maxRally(ctx)} letters). ` +
              `Wait for the window to reset, or pass queueOnLimit: true to schedule it.`,
          }
        }
        if (result.status === "queued") {
          const when = result.nextAt ? new Date(result.nextAt).toISOString() : "after the window"
          return {
            content:
              `postal: rally limit reached; letter queued for retry at ${when} ` +
              `(msg_id ${msgID}, kind ${envelope.kind}). No prompt was queued.`,
          }
        }
        if (result.status === "delivered") {
          return {
            content:
              `postal: letter delivered to ${to} (msg_id ${msgID}, kind ${envelope.kind}). ` +
              `The peer can continue the conversation with postal_send.`,
          }
        }
        if (result.status === "retry") {
          const when = result.nextAt ? new Date(result.nextAt).toISOString() : "shortly"
          return {
            content:
              `postal: delivery failed; retry ${result.attempts ?? 1} scheduled at ${when} ` +
              `(msg_id ${msgID}). Use postal_inbox to inspect pending letters.`,
          }
        }
        return {
          content:
            `postal: delivery failed after ${result.attempts ?? "multiple"} attempts: ` +
            `${result.error ?? "unknown error"} (msg_id ${msgID}).`,
        }
      },
    })

    editor.add({
      name: "broadcast",
      description:
        "Send the same letter to every connected peer. Each recipient gets its own outbox entry " +
        "and rally accounting. Pass msg_id to make retries idempotent.",
      input: {
        type: "object",
        properties: {
          text: { type: "string" },
          kind: { type: "string", enum: ["task", "status", "verify", "error", "letter", "system"] },
          task_id: { type: "string" },
          reply_to: { type: "string" },
          msg_id: { type: "string", description: "Base idempotency key; per-peer suffixes are added" },
          queueOnLimit: { type: "boolean" },
          artifacts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                sha256: { type: "string" },
              },
              required: ["path"],
              additionalProperties: false,
            },
          },
          commands: {
            type: "array",
            items: {
              type: "object",
              properties: {
                cmd: { type: "string" },
                exit: { type: "number" },
              },
              required: ["cmd"],
              additionalProperties: false,
            },
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
      execute: async (input, context) => {
        const value = input as {
          text?: string
          kind?: string
          task_id?: string
          reply_to?: string
          msg_id?: string
          queueOnLimit?: boolean
          artifacts?: unknown
          commands?: unknown
        }
        const text = value.text ?? ""
        if (!text) return { content: "postal: 'text' is required" }
        const kind = value.kind ? parseKind(value.kind) : undefined
        if (value.kind && !kind) return { content: `postal: invalid kind: ${value.kind}` }
        const peers = await readPeers(ctx, context.sessionID)
        if (peers.length === 0) return { content: "postal: no paired peers" }
        const base = value.msg_id?.trim() || generateMsgID()
        const artifacts = normalizeArtifacts(value.artifacts)
        const commands = normalizeCommands(value.commands)
        const rows: string[] = []
        for (const peer of peers) {
          const msgID = `${base}_${peer.id}`
          if (msgID.length > 128) {
            rows.push(`${peer.id}	error	-	msg_id too long`)
            continue
          }
          const grant = await ensureGrant(ctx, stateLock(ctx), context.sessionID, peer.id)
          const operation: Operation = kind === "task" ? "task" : "send"
          if (!grant || !isRuleActive(grant.operations[operation], operation)) {
            rows.push(`${peer.id}	not-granted	${msgID}	${operation} not granted`)
            continue
          }
          const envelope: Envelope = {
            kind: kind ?? "letter",
            taskID: value.task_id?.trim() || undefined,
            replyTo: value.reply_to?.trim() || undefined,
            msgID,
            artifacts,
            commands,
          }
          const result = await dispatchLetter(ctx, {
            from: context.sessionID,
            to: peer.id,
            body: text,
            envelope,
            queueOnLimit: value.queueOnLimit === true,
          })
          rows.push(`${peer.id}	${result.status}	${result.msgID}	${result.error ?? ""}`)
        }
        return { content: ["PEER_ID	STATUS	MSG_ID	ERROR", ...rows].join("\n") }
      },
    })

    editor.add({
      name: "inbox",
      description:
        "List this session's outbox: pending, delivered, rejected, revoked, acked, or failed letters. " +
        "This is the delivery queue, not the AI inbox.",
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          limit: { type: "number" },
        },
        additionalProperties: false,
      },
      execute: async (input, context) => {
        const value = input as { sessionID?: string; limit?: number }
        const target = value.sessionID?.trim() || context.sessionID
        if (!(await canInspect(ctx, context.sessionID, target))) {
          return { content: "postal: not authorized to inspect another session" }
        }
        const limit = Number.isFinite(value.limit)
          ? Math.max(1, Math.min(200, Math.floor(value.limit as number)))
          : 50
        const records = (await listOutbox(ctx, target))
          .sort((left, right) => right.createdAt - left.createdAt)
          .slice(0, limit)
        const outboxRows = records.map((record) => {
          const nextAt = record.nextAt ? new Date(record.nextAt).toISOString() : "-"
          const admittedAt = record.admittedAt ? new Date(record.admittedAt).toISOString() : "-"
          return [
            record.msgID,
            record.to,
            record.status,
            record.attempts,
            nextAt,
            record.envelope.kind,
            admittedAt,
            record.authorizedBy ?? "-",
            record.lastError ?? "",
          ].join("\t")
        })
        const peers = (await peerStatus(ctx, target)).peers ?? []
        const presence = await Promise.all(
          peers.map(async (peer) => ({ peer, record: await readPresence(ctx, peer.id) })),
        )
        const peerRows = presence.map(({ peer, record }) =>
          [peer.id, peer.title || "(untitled)", record?.state ?? "unknown", record?.pending.length ?? 0].join("\t"),
        )
        const itemRows = presence.flatMap(({ peer, record }) =>
          (record?.pending ?? []).map((item) =>
            [peer.id, item.id ?? "-", item.type ?? "-", item.source ?? "-"].join("\t"),
          ),
        )
        const sections = [
          "--- outbox ---",
          "MSG_ID\tTO\tSTATUS\tATTEMPTS\tNEXT_AT\tKIND\tADMITTED_AT\tAUTHORIZED_BY\tLAST_ERROR",
          ...(outboxRows.length > 0 ? outboxRows : ["(empty)"]),
          "--- peer inbox ---",
          "PEER_ID\tTITLE\tSTATE\tINBOX_COUNT",
          ...(peerRows.length > 0 ? peerRows : ["(no connected peers)"]),
        ]
        if (itemRows.length > 0) {
          sections.push("--- pending items ---", "PEER_ID\tITEM_ID\tTYPE\tSOURCE", ...itemRows)
        }
        return { content: sections.join("\n") }
      },
    })

    editor.add({
      name: "resend",
      description: "Reset an outbox letter and try delivering it again now.",
      input: {
        type: "object",
        properties: {
          msg_id: { type: "string" },
        },
        required: ["msg_id"],
        additionalProperties: false,
      },
      execute: async (input, context) => {
        const msgID = String((input as { msg_id?: unknown }).msg_id ?? "")
        if (!msgID) return { content: "postal: 'msg_id' is required" }
        const prepared = await crossProcessLock(ctx, outboxKey(context.sessionID, msgID), async () => {
          const current = await getOutbox(ctx, msgID, context.sessionID)
          if (!current) return { ok: false as const, content: `postal: outbox entry not found: ${msgID}` }
          if (current.from !== context.sessionID) {
            return { ok: false as const, content: "postal: cannot resend another session's letter" }
          }
          const limit = maxResends(ctx)
          if ((current.resendCount ?? 0) >= limit) {
            return {
              ok: false as const,
              content: `postal: resend limit reached (${limit}) for ${msgID}; send a new msg_id.`,
            }
          }
          await removeReceipt(ctx, current.from, current.to, current.msgID)
          current.status = "pending"
          current.attempts = 0
          current.nextAt = 0
          current.lastError = undefined
          current.queuedForWindow = false
          current.resendCount = (current.resendCount ?? 0) + 1
          await updateOutbox(ctx, current)
          return { ok: true as const, record: current }
        })
        if (!prepared.ok) return { content: prepared.content }
        const result = await attemptOutbox(ctx, prepared.record)
        if (result.status === "delivered") return { content: `postal: resent ${msgID}` }
        if (result.status === "revoked") {
          return { content: `postal: resend refused: grant revoked for ${prepared.record.to}` }
        }
        if (result.status === "failed") {
          return { content: `postal: resend failed: ${result.lastError ?? "unknown error"}` }
        }
        return { content: `postal: resend scheduled (attempt ${result.attempts})` }
      },
    })

    editor.add({
      name: "retry",
      description: "Scan this session's pending outbox records and retry the due ones now.",
      input: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_input, context) => {
        await retryOutbox(ctx, context.sessionID)
        const records = await listOutbox(ctx, context.sessionID)
        const pending = records.filter((record) => record.status === "pending").length
        return { content: ["RETRY_DONE", `PENDING\t${pending}`].join("\n") }
      },
    })

    editor.add({
      name: "claim",
      description:
        "Take an advisory lock for a path or task. Re-claim before the TTL expires to heartbeat. " +
        "This coordinates workers but does not enforce filesystem access.",
      input: {
        type: "object",
        properties: {
          scope: { type: "string", description: "Path, task ID, or other lock key" },
          ttl: { type: "number", description: "Seconds before the lock expires (default 60)" },
        },
        required: ["scope"],
        additionalProperties: false,
      },
      execute: async (input, context) => {
        const scope = String((input as { scope?: unknown }).scope ?? "").trim()
        if (!scope) return { content: "postal: 'scope' is required" }
        if (scope.length > 200) return { content: "postal: scope must be 200 characters or fewer" }
        const rawTtl = Number((input as { ttl?: unknown }).ttl)
        const ttl = Number.isFinite(rawTtl) ? Math.max(5, Math.min(3600, Math.floor(rawTtl))) : 60
        const key = `claim/${scope}`
        return serialized(claimLocks, scope, () =>
          crossProcessLock(ctx, `claim/${scope}`, async () => {
            const existing = (await ctx.storage.get(key)) as ClaimRecord | undefined
            const now = Date.now()
            if (existing && existing.expiresAt > now && existing.owner !== context.sessionID) {
              return {
                content:
                  `postal: claim busy: ${scope} is owned by ${existing.owner} ` +
                  `until ${new Date(existing.expiresAt).toISOString()}`,
              }
            }
            await ctx.storage.set(key, {
              scope,
              owner: context.sessionID,
              expiresAt: now + ttl * 1000,
            } satisfies ClaimRecord)
            return { content: `postal: claimed ${scope} for ${ttl}s` }
          }),
        )
      },
    })

    editor.add({
      name: "release",
      description: "Release an advisory claim owned by this session.",
      input: {
        type: "object",
        properties: {
          scope: { type: "string" },
        },
        required: ["scope"],
        additionalProperties: false,
      },
      execute: async (input, context) => {
        const scope = String((input as { scope?: unknown }).scope ?? "").trim()
        if (!scope) return { content: "postal: 'scope' is required" }
        const key = `claim/${scope}`
        return serialized(claimLocks, scope, () =>
          crossProcessLock(ctx, `claim/${scope}`, async () => {
            const existing = (await ctx.storage.get(key)) as ClaimRecord | undefined
            if (!existing) return { content: `postal: claim not held: ${scope}` }
            if (existing.owner !== context.sessionID) {
              return { content: `postal: claim owned by ${existing.owner}: ${scope}` }
            }
            await ctx.storage.remove(key)
            return { content: `postal: released ${scope}` }
          }),
        )
      },
    })

    editor.add({
      name: "rekey",
      description:
        "Rotate the HMAC key for a connected peer. The old key verifies for keyGraceHours " +
        "and new letters use the new key immediately.",
      input: {
        type: "object",
        properties: {
          peerID: { type: "string", description: "Peer session ID; required when multiple peers are connected" },
        },
        additionalProperties: false,
      },
      execute: async (input, context) => {
        let peerID = String((input as { peerID?: unknown }).peerID ?? "").trim()
        if (!peerID) {
          const peers = await readPeers(ctx, context.sessionID)
          if (peers.length === 1) peerID = peers[0]!.id
          else if (peers.length === 0) return { content: "postal: no paired peers" }
          else return { content: "postal: multiple peers paired; pass peerID explicitly" }
        }
        const peers = await readPeers(ctx, context.sessionID)
        if (!peers.some((peer) => peer.id === peerID)) {
          return { content: `postal: peer not paired: ${peerID}` }
        }
        const key = hmacStorageKey(context.sessionID, peerID)
        const result = await crossProcessLock(ctx, key, () =>
          serialized(hmacLocks, key, async () => {
            const existing = await readHmacRecord(ctx, context.sessionID, peerID)
          if (!existing) {
            const current = newHmacKey()
            await ctx.storage.set(key, { current, previous: [] } satisfies HmacRecord)
            return { keyID: current.keyID, oldKeyID: undefined as string | undefined, graceUntil: undefined as number | undefined }
          }
          const now = Date.now()
          const graceUntil = now + keyGraceMs(ctx)
          const previous = [
            { ...existing.current, validUntil: graceUntil },
            ...existing.previous.filter((old) => !old.validUntil || old.validUntil > now),
          ]
          const current = newHmacKey()
            await ctx.storage.set(key, { current, previous } satisfies HmacRecord)
            return { keyID: current.keyID, oldKeyID: existing.current.keyID, graceUntil }
          }),
        )
        return {
          content:
            `postal: rekeyed ${peerID}; new keyID ${result.keyID}` +
            (result.oldKeyID && result.graceUntil
              ? `; old ${result.oldKeyID} verifies until ${new Date(result.graceUntil).toISOString()}`
              : ""),
        }
      },
    })

    editor.add({
      name: "watchdog",
      description:
        "Find delivered task letters that are still unacked and nudge idle workers with a system letter. " +
        "Use dryRun to inspect candidates without sending.",
      input: {
        type: "object",
        properties: {
          dryRun: { type: "boolean" },
          afterSeconds: { type: "number", description: "Override the minimum task age for this run" },
          nudgeUnknown: { type: "boolean", description: "Nudge workers whose presence is unknown" },
        },
        additionalProperties: false,
      },
      execute: async (input, context) => {
        const value = input as { dryRun?: boolean; afterSeconds?: number; nudgeUnknown?: boolean }
        const result = await runWatchdog(ctx, { ...value, from: context.sessionID })
        const rows = result.candidates.map((record) => {
          const age = Math.max(0, Math.floor((Date.now() - record.createdAt) / 1000))
          return [
            record.msgID,
            record.to,
            record.envelope.taskID ?? "-",
            age,
            record.nudges ?? 0,
          ].join("\t")
        })
        return {
          content: [
            value.dryRun ? "WATCHDOG_DRY_RUN" : "WATCHDOG_RUN",
            "CANDIDATE_MSG_ID\tTO\tTASK_ID\tAGE_SECONDS\tNUDGES",
            ...(rows.length > 0 ? rows : ["(none)"]),
            `NUDGED\t${result.nudged.length > 0 ? result.nudged.join(",") : "-"}`,
          ].join("\n"),
        }
      },
    })

    editor.add({
      name: "cleanup",
      description:
        "Remove delivered/acked/failed outbox records older than outboxTtlDays. " +
        "Defaults to a dry run; pass dryRun: false to delete.",
      input: {
        type: "object",
        properties: {
          dryRun: { type: "boolean" },
        },
        additionalProperties: false,
      },
      execute: async (input, context) => {
        const dryRun = (input as { dryRun?: boolean }).dryRun !== false
        const expired = await cleanupOutbox(ctx, { dryRun, from: context.sessionID })
        return {
          content: [
            dryRun ? "CLEANUP_DRY_RUN" : "CLEANUP_REMOVED",
            `COUNT\t${expired.length}`,
            ...expired.map((record) => `${record.msgID}\t${record.to}\t${record.status}\t${record.envelope.kind}`),
          ].join("\n"),
        }
      },
    })

    editor.add({
      name: "interrupt",
      description: "Interrupt a running session. Defaults to this session.",
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
        },
        additionalProperties: false,
      },
      execute: async (input, context) => {
        if (typeof ctx.session.interrupt !== "function") {
          return { content: "postal: interrupting sessions is not supported by this OpenCode version" }
        }
        const target = String((input as { sessionID?: unknown }).sessionID ?? context.sessionID)
        if (!target) return { content: "postal: no session to interrupt" }
        if (target !== context.sessionID) {
          const allowed = await canOperate(ctx, context.sessionID, target, "interrupt")
          if (!allowed) {
            return {
              content: "postal: not authorized; the target has not granted interrupt to this session",
            }
          }
        }
        try {
          await ctx.session.interrupt({ sessionID: target })
          return { content: `postal: interrupted ${target}` }
        } catch (error) {
          return { content: `postal: interrupt failed: ${errorText(error)}` }
        }
      },
    })

    editor.add({
      name: "close",
      description: "Delete another session and disconnect all of its postal peers.",
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      execute: async (input, context) => {
        const target = String((input as { sessionID?: unknown }).sessionID ?? "").trim()
        if (!target) return { content: "postal: 'sessionID' is required" }
        if (target === context.sessionID) return { content: "postal: cannot close the calling session" }
        if (typeof ctx.session.remove !== "function") {
          return { content: "postal: deleting sessions is not supported by this OpenCode version" }
        }
        const allowed = await canOperate(ctx, context.sessionID, target, "close")
        if (!allowed) {
          return {
            content: "postal: not authorized; the target has not granted close to this session",
          }
        }
        // Delete first: if the irreversible step fails, leave parent/child and
        // peer records untouched so the caller can retry.
        try {
          await ctx.session.remove({ sessionID: target })
        } catch (error) {
          return { content: `postal: close failed: ${errorText(error)}` }
        }
        try {
          await disconnect(ctx, target)
        } catch (error) {
          console.warn(`postal: disconnect after close failed: ${errorText(error)}`)
        }
        try {
          await applyOrphanPolicy(ctx, target)
        } catch (error) {
          console.warn(`postal: orphan policy after close failed: ${errorText(error)}`)
        }
        return { content: `postal: closed ${target} and disconnected its peers` }
      },
    })
  })

  // Delivery retries run in the server process; unref keeps the timer from
  // holding the process open.
  try {
    const timerKey = ctx.location.directory
    const previousTimer = outboxTimers.get(timerKey)
    if (previousTimer) clearInterval(previousTimer)
    const timer = setInterval(() => {
      void retryOutbox(ctx)
      void runWatchdog(ctx)
      const lastCleanup = lastOutboxCleanupAt.get(timerKey) ?? 0
      if (Date.now() - lastCleanup > 60 * 60 * 1000) {
        lastOutboxCleanupAt.set(timerKey, Date.now())
        // Background cleanup is not a dry run; the tool keeps the dry-run default.
        void cleanupOutbox(ctx, { dryRun: false })
        void cleanupSeen(ctx)
      }
    }, RETRY_INTERVAL_MS)
    timer.unref?.()
    outboxTimers.set(timerKey, timer)
  } catch {
    // Timers are optional in restricted runtimes.
  }

  // Mention path: "@ses_XXXX ..." in a user prompt forwards the rest of the text.
  // Relay deliveries from this plugin are marked and never re-forwarded.
  // Connect handshake (from the TUI command) carries metadata.postal.connect.
  await ctx.session.hook("prompt", async (event) => {
    const meta = event.metadata as PostalMeta | undefined
    if (meta?.postal?.resetRally) {
      if (event.sessionID) {
        void (async () => {
          try {
            await ctx.storage.remove(`rally/${event.sessionID}`)
            const peers = await readPeers(ctx, event.sessionID)
            for (const peer of peers) {
              await ctx.storage.remove(rallyKey(event.sessionID, peer.id))
            }
          } catch (error) {
            console.warn(`postal: reset rally failed: ${errorText(error)}`)
          }
        })()
      }
      event.prompt.text = "[postal] Rally counter reset"
      return
    }
    if (meta?.postal?.disconnect) {
      const peerID = typeof meta.postal.disconnect === "string" ? meta.postal.disconnect : undefined
      if (event.sessionID) void disconnect(ctx, event.sessionID, peerID)
      event.prompt.text = "[postal] Pair disconnected"
      return
    }
    if (meta?.postal?.connect) {
      const peerID = String(meta.postal.connect)
      if (event.sessionID && peerID && peerID !== event.sessionID) {
        void pair(ctx, event.sessionID, peerID)
      }
      event.prompt.text = "[postal] Connection updated"
      return
    }
    if (meta?.postal?.relay) {
      const from = typeof meta.postal.from === "string" ? meta.postal.from : ""
      const msgID = typeof meta.postal.msgID === "string" ? meta.postal.msgID : ""
      const kind = typeof meta.postal.kind === "string" ? meta.postal.kind : "letter"
      const taskID = typeof meta.postal.taskID === "string" ? meta.postal.taskID : undefined
      const receiptBase =
        from && msgID
          ? { msgID, from, to: event.sessionID, kind, ...(taskID ? { taskID } : {}) }
          : undefined
      const verification = await verifyLetter(
        ctx,
        from,
        event.sessionID,
        event.prompt?.text ?? "",
        meta.postal,
      )
      if (!verification.ok) {
        // A receipt is trustworthy only when the pair key matched the signature
        // (invalid_signature means the keyID was valid but the payload was not).
        if (verification.reason === "invalid_signature" && receiptBase) {
          await putReceipt(ctx, {
            ...receiptBase,
            status: "rejected",
            reason: verification.reason,
            verifiedAt: Date.now(),
          })
        }
        event.prompt.text = ""
        meta.postal.reason = verification.reason
        return
      }
      let authorizedBy: string | undefined
      if (kind === "task") {
        const taskGrant = from ? await ensureGrant(ctx, stateLock(ctx), from, event.sessionID) : undefined
        authorizedBy = taskGrant && isRuleActive(taskGrant.operations.task, "task") ? from : undefined
        if (!authorizedBy) {
          if (receiptBase) {
            await putReceipt(ctx, {
              ...receiptBase,
              status: "rejected",
              reason: "unauthorized_task",
              verifiedAt: Date.now(),
            })
          }
          event.prompt.text = ""
          meta.postal.reason = "unauthorized_task"
          return
        }
        meta.postal.authorizedBy = authorizedBy
      }
      // R-03: reject a replay of an already admitted msgID. The seen marker is
      // written only after signature and task authorization succeed.
      if (msgID) {
        const seenKey = `seen/${encodeURIComponent(from)}/${encodeURIComponent(event.sessionID)}/${encodeURIComponent(msgID)}`
        const duplicate = await crossProcessLock(ctx, seenKey, async () => {
          const previous = await ctx.storage.get(seenKey)
          if (typeof previous === "number" && Date.now() - previous < SEEN_TTL_MS) return true
          await ctx.storage.set(seenKey, Date.now())
          return false
        })
        if (duplicate) {
          event.prompt.text = ""
          meta.postal.reason = "duplicate"
          return
        }
      }
      if (receiptBase) {
        await putReceipt(ctx, {
          ...receiptBase,
          status: "accepted",
          verifiedAt: Date.now(),
          ...(authorizedBy ? { authorizedBy } : {}),
        })
      }
      // ACK means "the peer replied to this letter", never "the envelope was admitted".
      // System nudges must not acknowledge the task they are watching.
      if (
        kind !== "system" &&
        typeof meta.postal.replyTo === "string" &&
        meta.postal.replyTo.length > 0
      ) {
        void markOutboxAcked(ctx, meta.postal.replyTo, {
          sessionID: event.sessionID,
          peerID: from,
        })
      }
      return
    }
    const text = event.prompt?.text ?? ""
    // Only a prompt that starts with an address is forwarded. Mentions in
    // prose, examples, or code fences must not send the prompt anywhere.
    const match = ADDRESS.exec(text)
    if (!match) return
    const to = match[1]
    const from = event.sessionID
    if (!from || !to || to === from) return
    const body = stripMentions(text)
    if (!body) return
    void relayMention(ctx, { from, to, body })
  })
}

// OpenCode validates this default shape. Keep the local plugin dependency-free
// (same pattern as the bundled openwolf plugin).
const plugin = {
  id: "postal",
  setup,
}

export default plugin
