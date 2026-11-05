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
  answeredBy?: string
  answeredAt?: number
  cancelledAt?: number
  note?: string
}

export type FormsContext = {
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
  postLetter: (input: PostLetterInput) => Promise<{ msgID: string }>
  fetch?: typeof fetch
  env?: Record<string, string | undefined>
  home?: string
  readFile?: (path: string) => string
}

export type ReplyResult =
  | { ok: true; via: "runtime" | "http" }
  | { ok: false; error: string; status?: number; via?: "runtime" | "http" }

export type ServiceEndpoint = {
  url: string
  username: string
  password: string
}

const QUESTION_PREFIX = "question/"
const MAX_ANSWER_BYTES = 64 * 1024
const MAX_ANSWER_FIELDS = 64
const MAX_LETTER_BYTES = 8 * 1024

export function questionKey(formID: string): string {
  return `${QUESTION_PREFIX}${encodeURIComponent(formID)}`
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function oneLineText(value: unknown, limit: number): string {
  if (typeof value !== "string") return ""
  return value.replace(/\s+/g, " ").trim().slice(0, limit)
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
  if (typeof record.asker !== "string" || !record.asker) return undefined
  if (typeof record.target !== "string" || !record.target) return undefined
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
  const lines = [
    `Question from ${form.sessionID}${from ? ` (${from})` : ""}: ${title}`,
    `form_id: ${form.id}`,
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
  lines.push(`Answer with postal_answer({ form_id: "${form.id}", answer: { ... } }).`)
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
      await runtime.reply({
        sessionID: input.sessionID,
        formID: input.formID,
        answer: input.answer,
      })
      return { ok: true, via: "runtime" }
    } catch (error) {
      return { ok: false, error: `form reply failed: ${errorText(error)}`, via: "runtime" }
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
  const url = new URL(
    `/api/session/${encodeURIComponent(input.sessionID)}/form/${encodeURIComponent(input.formID)}/reply`,
    endpoint.url,
  )
  const auth = `Basic ${Buffer.from(`${endpoint.username}:${endpoint.password}`).toString("base64")}`
  try {
    const response = await (deps.fetch ?? fetch)(url, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ answer: input.answer }),
      signal: AbortSignal.timeout(5000),
    })
    if (response.status === 204) return { ok: true, via: "http" }
    const text = await response.text().catch(() => "")
    return {
      ok: false,
      status: response.status,
      error: `form reply failed (HTTP ${response.status})${text ? `: ${sanitizeError(text)}` : ""}`,
      via: "http",
    }
  } catch (error) {
    return { ok: false, error: `form reply request failed: ${errorText(error)}`, via: "http" }
  }
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
    if (
      url.protocol === "http:" &&
      !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)
    ) {
      return undefined
    }
    return url.toString().replace(/\/$/, "")
  } catch {
    return undefined
  }
}
