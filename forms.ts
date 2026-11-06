/**
 * Postal v2 question/answer — host form API and routing records.
 *
 * OpenCode's `question` tool creates an in-memory form in the asking session.
 * This module owns the Postal-side question record, letter rendering, answer
 * shape checks, and the form reply transport. The event flows live in
 * `question-bridge.ts`.
 *
 * Only routing metadata is stored (`question/<formID>`); answer bodies never
 * enter Postal storage. Forms are location-scoped and expire after 10 minutes.
 */
import { readFileSync } from "node:fs"
import { Agent as HttpAgent, request as httpRequest } from "node:http"
import { Agent as HttpsAgent, request as httpsRequest } from "node:https"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Lock } from "./grants.js"

export type FormValue = string | number | boolean | string[]
export type FormAnswer = Record<string, FormValue>

export type FormOption = {
  value: string
  label?: string
  description?: string
}

export type FormField = {
  key: string
  type: string
  title?: string
  description?: string
  required?: boolean
  options?: FormOption[]
  custom?: boolean
}

export type FormInfo = {
  id: string
  sessionID: string
  title: string
  metadata?: Record<string, unknown>
  fields: FormField[]
}

export type QuestionStatus = "pending" | "answered" | "cancelled"

export type QuestionRecord = {
  formID: string
  asker: string
  target: string
  msgID: string
  title: string
  status: QuestionStatus
  createdAt: number
  updatedAt: number
  settlingBy?: string
  settlingAt?: number
  answeredBy?: string
  answeredAt?: number
  cancelledAt?: number
  note?: string
}

export type FormsContext = {
  location?: { directory: string }
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    remove(key: string): Promise<void>
  }
  session?: {
    form?: {
      reply?: (input: {
        sessionID: string
        formID: string
        answer: FormAnswer
      }) => Promise<unknown>
      cancel?: (input: { sessionID: string; formID: string; message?: string }) => Promise<unknown>
    }
  }
  options?: Record<string, unknown>
}

export type PostLetterInput = {
  from: string
  to: string
  kind: "question" | "status"
  body: string
  msgID?: string
  replyTo?: string
  delivery?: "steer" | "queue"
}

export type FormsDeps = {
  lock: Lock
  readParent: (ctx: FormsContext, sessionID: string) => Promise<string | undefined>
  authorizingAncestor: (ctx: FormsContext, actor: string, target: string) => Promise<string | undefined>
  isPaired: (ctx: FormsContext, from: string, to: string) => Promise<boolean>
  postLetter: (input: PostLetterInput) => Promise<{ msgID: string }>
  timeoutMs?: number
  env?: Record<string, string | undefined>
  home?: string
  readFile?: (path: string) => string
}

export type ReplyResult =
  | { ok: true; via: "runtime" | "http" }
  | {
      ok: false
      error: string
      status?: number
      via?: "runtime" | "http"
      /** Host error tag (e.g. `FormNotFoundError`) when the body is structured. */
      hostTag?: string
      /** Host error `id`, used to confirm the error refers to this form. */
      hostID?: string
    }

export type ServiceEndpoint = {
  url: string
  username: string
  password: string
}

const QUESTION_PREFIX = "question/"
const MAX_ANSWER_BYTES = 64 * 1024
const MAX_ANSWER_FIELDS = 64
const MAX_LETTER_BYTES = 8 * 1024
const MAX_RESPONSE_BYTES = 4 * 1024
const DEFAULT_TIMEOUT_MS = 5000

export function questionKey(formID: string): string {
  return `${QUESTION_PREFIX}${encodeURIComponent(formID)}`
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function oneLineText(value: unknown, limit: number): string {
  if (typeof value !== "string") return ""
  return value
    .slice(0, Math.max(limit * 4, 256))
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit)
}

/** Form IDs are host-generated (`frm_...`); restrict them before using them in keys/bodies. */
export function isValidFormID(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value)
}

/** Session IDs are `ses_...`; restrict them before using them in records/letters. */
export function isSessionID(value: unknown): value is string {
  return typeof value === "string" && /^ses_[A-Za-z0-9_-]{1,160}$/.test(value)
}

/**
 * Only the host `question` tool's forms are forwarded. The tool stamps
 * `metadata.tool = { messageID, id }`; requiring it excludes generic forms that
 * merely set `metadata.kind`.
 */
export function isQuestionForm(form: FormInfo): boolean {
  const metadata = form?.metadata
  if (!metadata || metadata.kind !== "question") return false
  const tool = metadata.tool
  return Boolean(tool && typeof tool === "object" && typeof (tool as { id?: unknown }).id === "string")
}

export function newQuestionMsgID(): string {
  return `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export async function readQuestion(
  ctx: FormsContext,
  formID: string,
): Promise<QuestionRecord | undefined> {
  const value = await ctx.storage.get(questionKey(formID))
  return normalizeQuestion(value, formID)
}

function normalizeQuestion(value: unknown, formID: string): QuestionRecord | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Partial<QuestionRecord>
  if (!isSessionID(record.asker) || !isSessionID(record.target)) return undefined
  if (typeof record.msgID !== "string") return undefined
  return {
    formID,
    asker: record.asker,
    target: record.target,
    msgID: record.msgID,
    title: oneLineText(record.title, 200),
    status:
      record.status === "answered" || record.status === "cancelled" ? record.status : "pending",
    createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
    ...(typeof record.settlingBy === "string" && record.settlingBy
      ? { settlingBy: record.settlingBy }
      : {}),
    ...(typeof record.settlingAt === "number" ? { settlingAt: record.settlingAt } : {}),
    ...(typeof record.answeredBy === "string" && record.answeredBy
      ? { answeredBy: record.answeredBy }
      : {}),
    ...(typeof record.answeredAt === "number" ? { answeredAt: record.answeredAt } : {}),
    ...(typeof record.cancelledAt === "number" ? { cancelledAt: record.cancelledAt } : {}),
    ...(typeof record.note === "string" && record.note ? { note: record.note.slice(0, 200) } : {}),
  }
}

/** Render the question letter. Field metadata is untrusted, so every value is capped. */
export function renderQuestionBody(form: FormInfo, askerTitle?: string): string {
  const title = oneLineText(form.title, 200) || "(untitled question)"
  const from = oneLineText(askerTitle, 120)
  const formID = oneLineText(form.id, 160)
  const lines = [
    `Question from ${oneLineText(form.sessionID, 160)}${from ? ` (${from})` : ""}: ${title}`,
    `form_id: ${formID}`,
    "fields:",
  ]
  for (const field of form.fields.slice(0, 32)) {
    const flags = [oneLineText(field.type, 32) || "string", field.required ? "required" : "optional"].join(", ")
    const detail = [oneLineText(field.title, 120), oneLineText(field.description, 500)]
      .filter(Boolean)
      .join(": ")
    lines.push(
      `- ${oneLineText(field.key, 128)} (${flags})${detail ? ` ${detail}` : ""}`.trimEnd(),
    )
    if (field.options?.length) {
      const options = field.options
        .slice(0, 32)
        .map((option) => {
          const value = oneLineText(option.value, 120)
          const label = oneLineText(option.label, 80)
          return label && label !== value ? `${value} (${label})` : value
        })
        .join(", ")
      lines.push(`  options: ${options}`)
    }
  }
  lines.push(`Answer with postal_answer({ form_id: "${formID}", answer: { ... } }).`)
  lines.push("The asking session is blocked until the form is answered or cancelled.")
  return lines.join("\n").slice(0, MAX_LETTER_BYTES)
}

/** Validate the wire shape before the host validates field values. */
export function validateAnswer(
  value: unknown,
): { ok: true; answer: FormAnswer } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "answer must be a JSON object" }
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > MAX_ANSWER_FIELDS) return { ok: false, error: "answer has too many fields" }
  const answer: FormAnswer = {}
  for (const [key, raw] of entries) {
    if (
      !key ||
      key.length > 128 ||
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype"
    ) {
      return { ok: false, error: `invalid answer field: ${key}` }
    }
    if (typeof raw === "string") {
      if (raw.length > 32_768) return { ok: false, error: `answer field is too long: ${key}` }
      answer[key] = raw
    } else if (typeof raw === "number") {
      if (!Number.isFinite(raw)) return { ok: false, error: `answer field is not finite: ${key}` }
      answer[key] = raw
    } else if (typeof raw === "boolean") {
      answer[key] = raw
    } else if (Array.isArray(raw)) {
      if (raw.length > 64) return { ok: false, error: `too many selections: ${key}` }
      if (raw.some((item) => typeof item !== "string" || item.length > 1024)) {
        return { ok: false, error: `invalid selection: ${key}` }
      }
      answer[key] = raw as string[]
    } else {
      return { ok: false, error: `invalid value for answer field: ${key}` }
    }
  }
  if (JSON.stringify(answer).length > MAX_ANSWER_BYTES) {
    return { ok: false, error: "answer is too large" }
  }
  return { ok: true, answer }
}

/** Resolve the host form API. Runtime API first, loopback OpenAPI second. */
export async function replyToForm(
  ctx: FormsContext,
  deps: FormsDeps,
  input: { sessionID: string; formID: string; answer: FormAnswer },
): Promise<ReplyResult> {
  const runtime = ctx.session?.form
  if (runtime && typeof runtime.reply === "function") {
    try {
      await withTimeout(
        Promise.resolve(
          runtime.reply({
            sessionID: input.sessionID,
            formID: input.formID,
            answer: input.answer,
          }),
        ),
        deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      )
      return { ok: true, via: "runtime" }
    } catch (error) {
      return {
        ok: false,
        error: `form reply failed: ${oneLineText(errorText(error), 300)}`,
        via: "runtime",
      }
    }
  }

  const endpoint = discoverService(deps)
  if (!endpoint) {
    return {
      ok: false,
      error:
        "form reply API not available: ctx.session.form.reply is missing and no loopback OpenCode service registration was found",
    }
  }
  const path = `/api/session/${encodeURIComponent(input.sessionID)}/form/${encodeURIComponent(input.formID)}/reply`
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  try {
    const response = await postFormReply(endpoint, path, { answer: input.answer }, timeoutMs)
    if (response.status === 204) return { ok: true, via: "http" }
    const host = parseHostError(response.text)
    return {
      ok: false,
      status: response.status,
      error: `form reply failed (HTTP ${response.status})${response.text ? `: ${sanitizeError(response.text)}` : ""}`,
      via: "http",
      ...(host.tag ? { hostTag: host.tag } : {}),
      ...(host.id ? { hostID: host.id } : {}),
    }
  } catch (error) {
    return {
      ok: false,
      error: `form reply request failed: ${oneLineText(errorText(error), 300)}`,
      via: "http",
    }
  }
}

/** Parse a structured host error body (`{ _tag, id, message }`) when present. */
function parseHostError(text: string): { tag?: string; id?: string } {
  try {
    const parsed = JSON.parse(text) as { _tag?: unknown; id?: unknown }
    return {
      ...(typeof parsed._tag === "string" ? { tag: parsed._tag } : {}),
      ...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
    }
  } catch {
    return {}
  }
}

/**
 * Cancel a form the host owns. Runtime API first, loopback OpenAPI second.
 * Used when a question cannot be delivered, so the blocked session does not
 * stay blocked forever.
 */
export async function cancelForm(
  ctx: FormsContext,
  deps: FormsDeps,
  input: { sessionID: string; formID: string; message?: string },
): Promise<{ ok: boolean; error?: string; via?: "runtime" | "http" }> {
  const runtime = ctx.session?.form
  if (runtime && typeof runtime.cancel === "function") {
    try {
      await withTimeout(
        Promise.resolve(
          runtime.cancel({
            sessionID: input.sessionID,
            formID: input.formID,
            ...(input.message ? { message: input.message } : {}),
          }),
        ),
        deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      )
      return { ok: true, via: "runtime" }
    } catch (error) {
      return { ok: false, error: oneLineText(errorText(error), 300), via: "runtime" }
    }
  }

  const endpoint = discoverService(deps)
  if (!endpoint) return { ok: false, error: "form cancel API not available" }
  const query = input.message ? `?message=${encodeURIComponent(input.message)}` : ""
  const path = `/api/session/${encodeURIComponent(input.sessionID)}/form/${encodeURIComponent(input.formID)}${query}`
  try {
    const response = await formRequest(
      endpoint,
      { method: "DELETE", path },
      deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
    if (response.status === 204) return { ok: true, via: "http" }
    return {
      ok: false,
      error: `form cancel failed (HTTP ${response.status})${response.text ? `: ${sanitizeError(response.text)}` : ""}`,
      via: "http",
    }
  } catch (error) {
    return { ok: false, error: `form cancel request failed: ${oneLineText(errorText(error), 300)}`, via: "http" }
  }
}

/**
 * Send a form request directly with node:http/https.
 *
 * Bun's `fetch` honors HTTP_PROXY/HTTPS_PROXY and forwards Authorization
 * headers through the proxy, which would leak the local server password.
 * node:http ignores proxy environment variables, does not follow redirects,
 * and lets us cap the response body and the total request lifetime.
 *
 * A dedicated, non-keepalive agent is used per request (never the shared
 * `globalAgent`). A total-time timer destroys the request, the body read stops
 * at `MAX_RESPONSE_BYTES` instead of waiting for `end`, and a `settled` guard
 * makes resolve/reject exactly once.
 */
function formRequest(
  endpoint: ServiceEndpoint,
  options: { method: "POST" | "DELETE"; path: string; body?: unknown },
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(options.path, endpoint.url)
    const isHttps = url.protocol === "https:"
    const send = isHttps ? httpsRequest : httpRequest
    const agent = isHttps ? new HttpsAgent({ keepAlive: false }) : new HttpAgent({ keepAlive: false })
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
    const headers: Record<string, string> = {
      authorization: `Basic ${Buffer.from(
        `${endpoint.username}:${endpoint.password}`,
      ).toString("base64")}`,
    }
    if (payload !== undefined) {
      headers["content-type"] = "application/json"
      headers["content-length"] = String(Buffer.byteLength(payload))
    }

    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let request: ReturnType<typeof httpRequest>
    const teardown = (): void => {
      request.destroy()
      agent.destroy()
    }
    const finish = (status: number, text: string): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      teardown()
      resolve({ status, text })
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      teardown()
      reject(error)
    }

    try {
      request = send(url, { method: options.method, agent, headers }, (response) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on("data", (chunk: Buffer) => {
          if (settled) return
          const remaining = MAX_RESPONSE_BYTES - size
          if (remaining > 0) {
            const part = chunk.subarray(0, remaining)
            chunks.push(part)
            size += part.length
          }
          if (size >= MAX_RESPONSE_BYTES) {
            // Stop at the cap; a large or slow body must not hang the caller.
            finish(response.statusCode ?? 0, Buffer.concat(chunks).toString("utf8"))
          }
        })
        response.on("end", () => finish(response.statusCode ?? 0, Buffer.concat(chunks).toString("utf8")))
        response.on("error", fail)
      })
    } catch (error) {
      // `send` can throw synchronously (e.g. invalid URL/headers); the timer is
      // not set yet, so only the agent needs tearing down.
      settled = true
      agent.destroy()
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    // Overall deadline, not just socket inactivity.
    timer = setTimeout(() => fail(new Error(`form request timed out after ${timeoutMs}ms`)), timeoutMs)
    timer.unref?.()
    request.on("error", fail)
    request.end(payload)
  })
}

function postFormReply(
  endpoint: ServiceEndpoint,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  return formRequest(endpoint, { method: "POST", path, body }, timeoutMs)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`form reply timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function sanitizeError(text: string): string {
  try {
    const parsed = JSON.parse(text) as { message?: unknown; error?: unknown }
    const message = typeof parsed.message === "string" ? parsed.message : parsed.error
    if (typeof message === "string" && message) return oneLineText(message, 300)
  } catch {
    // Fall back to a capped plain-text message.
  }
  return oneLineText(text, 300)
}

/** Read the OpenCode service registration without exposing the password. */
export function discoverService(
  deps: Pick<FormsDeps, "env" | "home" | "readFile"> = {},
): ServiceEndpoint | undefined {
  const env = deps.env ?? process.env
  const home = deps.home ?? homedir()
  const read = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"))
  const username = env.OPENCODE_SERVER_USERNAME || "opencode"
  const envPassword = env.OPENCODE_SERVER_PASSWORD || env.OPENCODE_PASSWORD
  const envURL = env.OPENCODE_SERVER_URL
  if (envURL && envPassword) {
    const safe = safeServiceURL(envURL)
    if (safe) return { url: safe, username, password: envPassword }
  }

  const stateHome = env.XDG_STATE_HOME || join(home, ".local", "state")
  for (const path of [
    join(stateHome, "opencode", "service.json"),
    join(home, ".config", "opencode", "service.json"),
  ]) {
    try {
      const parsed = JSON.parse(read(path)) as { url?: unknown; password?: unknown }
      if (
        typeof parsed.url !== "string" ||
        typeof parsed.password !== "string" ||
        !parsed.password
      ) {
        continue
      }
      const safe = safeServiceURL(parsed.url)
      if (safe) return { url: safe, username, password: parsed.password }
    } catch {
      // Missing or malformed registrations are not fatal.
    }
  }
  return undefined
}

function safeServiceURL(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
    if (url.username || url.password) return undefined
    if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)) return undefined
    return url.toString().replace(/\/$/, "")
  } catch {
    return undefined
  }
}
