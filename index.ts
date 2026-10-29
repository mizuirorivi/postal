/**
 * Postal — session-to-session mail for OpenCode.
 *
 * Two modes (no subagents):
 *
 * 1. Mention mode: a user prompt containing `@ses_XXXX <message>` is forwarded
 *    to that session; the plugin waits for its reply and admits the reply back
 *    to the sender as a queued context message (no agent turn on the sender).
 *
 * 2. Tool mode: `postal_send` delivers immediately (non-blocking) with
 *    `delivery: "steer"`. The receiving AI replies by calling `postal_send`
 *    again, so two AIs can hold a rally. `postal_send` without `to` uses the
 *    peer connected via the Ctrl+P command.
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
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

type MessagePart = { type: string; text?: string; ignored?: boolean; synthetic?: boolean }

/**
 * `ctx.session.context` projects messages as either
 *   { type: "user", id, text, metadata }
 *   { type: "assistant", id, content: Part[] }
 * Older client typings also expose { info, parts }; support both shapes.
 */
type ProjectedMessage = {
  id?: string
  type?: string
  role?: string
  text?: string
  content?: MessagePart[]
  info?: { id?: string; role?: string }
  parts?: MessagePart[]
}

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
    disconnect?: boolean
    resetRally?: boolean
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
    hook(name: "prompt", callback: (event: PromptEvent) => void): Promise<unknown>
    list(input?: Record<string, unknown>): Promise<{ data: Array<{ id: string; title?: string }> }>
    get(input: { sessionID: string }): Promise<{ id: string; title?: string }>
    context(input: { sessionID: string }): Promise<ProjectedMessage[]>
    prompt(input: Record<string, unknown>): Promise<unknown>
    wait(input: { sessionID: string }): Promise<void>
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

type PeerRecord = { id: string; title: string }
type PairResult = { ok: boolean; peerID?: string; title?: string; error?: string }

const MENTION = /@(ses_[A-Za-z0-9_-]+)/g
const ADDRESS_TIMEOUT_MS = 120_000
const POLL_MS = 400

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
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

function roleOf(message: ProjectedMessage): string | undefined {
  return message.info?.role ?? message.role ?? message.type
}

function idOf(message: ProjectedMessage): string | undefined {
  return message.info?.id ?? message.id
}

function partsOf(message: ProjectedMessage): MessagePart[] {
  return message.parts ?? message.content ?? []
}

function assistantIDs(messages: ProjectedMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    if (roleOf(message) !== "assistant") continue
    const id = idOf(message)
    if (id) ids.add(id)
  }
  return ids
}

function messageText(message: ProjectedMessage): string {
  // User messages project their prompt as `text`; assistant messages carry parts.
  if (typeof message.text === "string" && partsOf(message).length === 0) return message.text.trim()
  return partsOf(message)
    .filter((part) => part.type === "text" && !part.ignored && !part.synthetic)
    .map((part) => part.text ?? "")
    .join("\n")
    .trim()
}

/** Wait until the target produces a NEW assistant message containing the reply token. */
async function waitForNewReply(
  ctx: PostalContext,
  sessionID: string,
  before: Set<string>,
  token: string,
  signal?: AbortSignal,
): Promise<string> {
  const started = Date.now()
  let latest = ""
  for (;;) {
    if (signal?.aborted) return "(postal: delivery aborted)"
    try {
      await ctx.session.wait({ sessionID })
    } catch {
      // wait is best-effort; polling below is authoritative.
    }
    const messages = await ctx.session.context({ sessionID })
    const fresh = messages.filter((m) => roleOf(m) === "assistant" && !before.has(idOf(m) ?? ""))
    const texts = fresh.map(messageText).filter((text) => text.length > 0)
    if (texts.length > 0) latest = texts[texts.length - 1]
    const matched = [...texts].reverse().find((text) => text.includes(token))
    if (matched) return matched
    if (Date.now() - started > ADDRESS_TIMEOUT_MS) {
      if (latest) return `${latest}\n(postal: reply token not found; using latest reply)`
      return "(postal: timed out waiting for a reply)"
    }
    await sleep(POLL_MS, signal)
  }
}

/** Deliver a letter immediately (no waiting); the peer replies with postal_send. */
async function postOnly(
  ctx: PostalContext,
  options: { from: string; to: string; body: string; rally: number; max: number },
): Promise<void> {
  const fromLabel = await sessionLabel(ctx, options.from)
  const letter =
    `[postal] from ${fromLabel} (rally ${options.rally}/${options.max}):\n` +
    `(Session mail. To reply, call postal_send with your message and omit 'to'. ` +
    `A normal text reply is not delivered to the peer.)\n\n${options.body}`
  await ctx.session.prompt({
    sessionID: options.to,
    text: letter,
    delivery: "steer",
    metadata: { postal: { relay: true, from: options.from, rally: options.rally } },
  })
}

const DEFAULT_MAX_RALLY = 30
const RALLY_WINDOW_MS = 10 * 60 * 1000

function maxRally(ctx: PostalContext): number {
  const configured = Number(ctx.options?.maxRally)
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_MAX_RALLY
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
    const previous = (await ctx.storage.get(key)) as { count?: number; at?: number } | undefined
    const count = previous && previous.at && now - previous.at < RALLY_WINDOW_MS ? (previous.count ?? 0) + 1 : 1
    await ctx.storage.set(key, { count, at: now })
    return count
  })
}

/** Deliver a letter and block until the target produced a reply. */
async function deliver(
  ctx: PostalContext,
  options: { from: string; to: string; body: string; signal?: AbortSignal },
): Promise<string> {
  const { from, to, body, signal } = options
  const fromLabel = await sessionLabel(ctx, from)
  const before = assistantIDs(await ctx.session.context({ sessionID: to }))
  const token = `postal#${Math.random().toString(36).slice(2, 8)}`
  const letter =
    `[postal] from ${fromLabel} [${token}]:\n` +
    `(Session mail. Answer with a normal text reply that starts with [${token}]; ` +
    `do not call postal tools to answer.)\n\n${body}`
  await ctx.session.prompt({
    sessionID: to,
    text: letter,
    // steer starts the target immediately even when it is idle; queue would
    // park the letter in the inbox until the session becomes active.
    delivery: "steer",
    metadata: { postal: { relay: true, from, token } },
  })
  return waitForNewReply(ctx, to, before, token, signal)
}

/** Mention path: forward to the target, then admit its reply to the sender. */
async function relayMention(ctx: PostalContext, input: { from: string; to: string; body: string }): Promise<void> {
  const { from, to, body } = input
  if (from === to) return
  try {
    const reply = await deliver(ctx, { from, to, body })
    const toLabel = await sessionLabel(ctx, to)
    await ctx.session.prompt({
      sessionID: from,
      text: `[postal reply from ${toLabel}]\n${reply}`,
      resume: false,
      delivery: "queue",
      metadata: { postal: { relay: true, from: to } },
    })
  } catch (error) {
    await ctx.session
      .prompt({
        sessionID: from,
        text: `[postal] delivery to ${to} failed: ${errorText(error)}`,
        resume: false,
        delivery: "queue",
        metadata: { postal: { relay: true, from: to } },
      })
      .catch(() => {})
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

/** Remove a session's pairing only when it still points at expectedPeerID. */
async function unlink(ctx: PostalContext, sessionID: string, expectedPeerID: string): Promise<void> {
  try {
    const peer = (await ctx.storage.get(`peer/${sessionID}`)) as PeerRecord | undefined
    if (peer?.id !== expectedPeerID) return
    await ctx.storage.remove(`peer/${sessionID}`)
    await clearNote(ctx, sessionID)
  } catch (error) {
    console.warn(`postal: unlink ${sessionID} failed: ${errorText(error)}`)
  }
}

/** Pair two sessions: remember each peer and teach both AIs the address. */
async function pair(ctx: PostalContext, from: string, peerID: string): Promise<PairResult> {
  if (!peerID || peerID === from) return { ok: false, error: "invalid peer" }
  const teach = async (sessionID: string, id: string, title: string) => {
    const note = `Postal peer: ${id}${title ? ` (${title})` : ""}. Use postal_send without 'to' to write to this peer.`
    try {
      await ctx.session.instructions.entry.put({ sessionID, key: "postal-peer", value: note })
    } catch {
      // Older runtimes may not expose instruction entries to plugins; teach the
      // peer through a context message instead (relay-marked, no agent turn).
      await ctx.session
        .prompt({
          sessionID,
          text: `[postal] ${note}`,
          resume: false,
          delivery: "queue",
          metadata: { postal: { relay: true, peer: { id, title } } },
        })
        .catch(() => {})
    }
  }
  try {
    const [self, peer] = await Promise.all([
      ctx.session.get({ sessionID: from }),
      ctx.session.get({ sessionID: peerID }),
    ])
    // Clean stale back-references on both sides before overwriting storage.
    const previous = (await ctx.storage.get(`peer/${from}`)) as PeerRecord | undefined
    if (previous?.id && previous.id !== peerID) {
      await unlink(ctx, previous.id, from)
    }
    const existing = (await ctx.storage.get(`peer/${peerID}`)) as PeerRecord | undefined
    if (existing?.id && existing.id !== from) {
      await unlink(ctx, existing.id, peerID)
    }
    await ctx.storage.set(`peer/${from}`, { id: peerID, title: peer.title ?? "" })
    await ctx.storage.set(`peer/${peerID}`, { id: from, title: self.title ?? "" })
    await Promise.all([
      teach(from, peerID, peer.title ?? ""),
      teach(peerID, from, self.title ?? ""),
    ])
    return { ok: true, peerID, title: peer.title ?? "" }
  } catch (error) {
    console.warn(`postal: pairing ${from} <-> ${peerID} failed: ${errorText(error)}`)
    return { ok: false, error: errorText(error) }
  }
}

/** Forget the pairing on both sides (best effort). */
async function disconnect(ctx: PostalContext, sessionID: string): Promise<PairResult> {
  try {
    const peer = (await ctx.storage.get(`peer/${sessionID}`)) as PeerRecord | undefined
    await ctx.storage.remove(`peer/${sessionID}`)
    // Clear the caller's note even when no peer record exists.
    await clearNote(ctx, sessionID)
    if (peer?.id) await unlink(ctx, peer.id, sessionID)
    return { ok: true, peerID: peer?.id, title: peer?.title }
  } catch (error) {
    console.warn(`postal: disconnect ${sessionID} failed: ${errorText(error)}`)
    return { ok: false, error: errorText(error) }
  }
}

async function setup(ctx: PostalContext): Promise<void> {
  try {
    await ctx.rpc.register(PostalRpc, {
      connect: async (input) => pair(ctx, String(input.sessionID), String(input.peerID)),
      disconnect: async (input) => disconnect(ctx, String(input.sessionID)),
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
      name: "send",
      description:
        "Send mail to another OpenCode session. Delivers immediately (non-blocking); " +
        "the peer receives it as [postal] from ... (rally n/m) and can continue by calling postal_send. " +
        "Omit 'to' to write to the peer connected via the Postal Ctrl+P command. " +
        "Use postal_directory to list sessions.",
      input: {
        type: "object",
        properties: {
          to: { type: "string", description: "Target session ID (ses_...). Omit for the connected peer." },
          text: { type: "string", description: "Letter body to deliver" },
        },
        required: ["text"],
        additionalProperties: false,
      },
      execute: async (input, context) => {
        const { text } = input as { to?: string; text: string }
        let to = (input as { to?: string }).to
        let validated = false
        if (!text) return { content: "postal: 'text' is required" }
        if (!to) {
          const peer = (await ctx.storage.get(`peer/${context.sessionID}`)) as PeerRecord | undefined
          if (peer?.id) {
            try {
              await ctx.session.get({ sessionID: peer.id })
              to = peer.id
              validated = true
            } catch {
              // Peer session was deleted: forget the stale pairing.
              await ctx.storage.remove(`peer/${context.sessionID}`).catch(() => {})
            }
          }
        }
        if (!to) {
          return {
            content:
              "postal: no recipient (stale pairings are cleaned automatically). " +
              "Connect a peer with the Postal command (Ctrl+P), or pass 'to' explicitly.",
          }
        }
        if (to === context.sessionID) return { content: "postal: cannot send mail to yourself" }
        if (!validated) {
          try {
            await ctx.session.get({ sessionID: to })
          } catch {
            return { content: `postal: delivery failed: session not found: ${to}` }
          }
        }
        // AI-to-AI conversation: deliver immediately and let the peer reply with
        // postal_send. No blocking wait, no queued relay.
        const max = maxRally(ctx)
        const rally = await nextRally(ctx, context.sessionID, to)
        if (rally > max) {
          return {
            content:
              `postal: rally limit reached (${max} letters). Conversation stopped. ` +
              `Wait for the window to reset, or use Ctrl+P → Postal: Reset rally.`,
          }
        }
        try {
          await postOnly(ctx, { from: context.sessionID, to, body: text, rally, max })
        } catch (error) {
          await ctx.session
            .prompt({
              sessionID: context.sessionID,
              text: `[postal] delivery to ${to} failed: ${errorText(error)}`,
              resume: false,
              delivery: "queue",
              metadata: { postal: { relay: true, from: to } },
            })
            .catch(() => {})
          return { content: `postal: delivery failed: ${errorText(error)}` }
        }
        return {
          content:
            `postal: letter delivered to ${to}. The peer can continue the conversation with postal_send.`,
        }
      },
    })
  })

  // Mention path: "@ses_XXXX ..." in a user prompt forwards the rest of the text.
  // Relay deliveries from this plugin are marked and never re-forwarded.
  // Connect handshake (from the TUI command) carries metadata.postal.connect.
  await ctx.session.hook("prompt", (event) => {
    const meta = event.metadata as PostalMeta | undefined
    if (meta?.postal?.resetRally) {
      if (event.sessionID) {
        void (async () => {
          try {
            await ctx.storage.remove(`rally/${event.sessionID}`)
            const peer = (await ctx.storage.get(`peer/${event.sessionID}`)) as PeerRecord | undefined
            if (peer?.id) await ctx.storage.remove(rallyKey(event.sessionID, peer.id))
          } catch (error) {
            console.warn(`postal: reset rally failed: ${errorText(error)}`)
          }
        })()
      }
      event.prompt.text = "[postal] Rally counter reset"
      return
    }
    if (meta?.postal?.disconnect) {
      if (event.sessionID) void disconnect(ctx, event.sessionID)
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
    if (meta?.postal?.relay) return
    const text = event.prompt?.text ?? ""
    MENTION.lastIndex = 0
    const match = MENTION.exec(text)
    MENTION.lastIndex = 0
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
