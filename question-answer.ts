/**
 * Postal v2 question/answer — postal_answer.
 *
 * The actor must be an ancestor of the asking session and hold the `task`
 * grant for it (the same authority M1 uses for assignments). The host form
 * service performs field validation; this module only checks the wire shape
 * and the Postal authority.
 */
import { ensureGrant, isRuleActive } from "./grants.js"
import {
  isValidFormID,
  questionKey,
  readQuestion,
  replyToForm,
  validateAnswer,
  type FormsContext,
  type FormsDeps,
  type QuestionRecord,
} from "./forms.js"

export type AnswerResult =
  | { ok: true; record: QuestionRecord }
  | { ok: false; error: string; status?: number }

/** A crashed/hung answerer must not block the question forever. */
const STALE_SETTLING_MS = 30_000

export async function answerQuestion(
  ctx: FormsContext,
  deps: FormsDeps,
  input: { actor: string; formID: string; answer: unknown },
  now = Date.now(),
): Promise<AnswerResult> {
  const formID = typeof input.formID === "string" ? input.formID.trim() : ""
  if (!formID) return { ok: false, error: "form_id is required" }
  if (!isValidFormID(formID)) return { ok: false, error: `invalid form_id: ${formID}` }
  const record = await readQuestion(ctx, formID)
  if (!record) {
    return {
      ok: false,
      error: `unknown question: ${formID} (not forwarded by Postal, or outside this location)`,
    }
  }
  if (record.status !== "pending") {
    return { ok: false, error: `question already ${record.status}: ${formID}` }
  }
  const ancestor = await deps.authorizingAncestor(ctx, input.actor, record.asker)
  if (!ancestor) {
    return {
      ok: false,
      error: `not authorized: ${input.actor} is not an ancestor of ${record.asker}`,
    }
  }
  const grant = await ensureGrant(ctx, deps.lock, input.actor, record.asker)
  if (!grant || !isRuleActive(grant.operations.task, "task")) {
    return {
      ok: false,
      error: `not authorized: task grant required from ${input.actor} to ${record.asker}`,
    }
  }
  const validation = validateAnswer(input.answer)
  if (!validation.ok) return { ok: false, error: validation.error }

  const key = questionKey(formID)
  const reserved = await deps.lock(key, async () => {
    const current = await readQuestion(ctx, formID)
    if (!current || current.status !== "pending") {
      return { error: `question already settled: ${formID}` }
    }
    if (current.settlingBy) {
      // A marker without a timestamp cannot be trusted; treat it as stale so a
      // crashed answerer never blocks the question forever.
      const stale =
        typeof current.settlingAt !== "number" || now - current.settlingAt > STALE_SETTLING_MS
      if (!stale) return { error: `question is being answered by ${current.settlingBy}` }
    }
    current.settlingBy = input.actor
    current.settlingAt = now
    current.updatedAt = now
    await ctx.storage.set(key, current)
    return { record: current }
  })
  if ("error" in reserved) return { ok: false, error: reserved.error }

  const reply = await replyToForm(ctx, deps, {
    sessionID: record.asker,
    formID,
    answer: validation.answer,
  })
  if (!reply.ok) {
    await deps.lock(key, async () => {
      const current = await readQuestion(ctx, formID)
      if (!current || current.status !== "pending" || current.settlingBy !== input.actor) return
      delete current.settlingBy
      delete current.settlingAt
      current.updatedAt = Date.now()
      // Confirm from the structured host error, not the status code or prose:
      // a different service or a spoofed message must not settle the record.
      // Require the HTTP status too, so a 200/500 body that merely carries a
      // tag/id cannot settle it.
      const hostNotFound =
        reply.status === 404 && reply.hostTag === "FormNotFoundError" && reply.hostID === formID
      const hostSettled =
        reply.status === 409 &&
        reply.hostTag === "FormAlreadySettledError" &&
        reply.hostID === formID
      if (hostNotFound) {
        current.status = "cancelled"
        current.cancelledAt = Date.now()
        current.note = "form_not_found"
      } else if (hostSettled) {
        // The host rejected this answer; do not credit the actor.
        current.status = "answered"
        current.note = "form_already_settled"
      } else {
        current.note = "form_state_unknown"
      }
      await ctx.storage.set(key, current)
    })
    return {
      ok: false,
      error: reply.error,
      ...(typeof reply.status === "number" ? { status: reply.status } : {}),
    }
  }

  const final = await deps.lock(key, async () => {
    const current = await readQuestion(ctx, formID)
    if (!current) return { kind: "missing" as const }
    if (current.status === "pending") {
      current.status = "answered"
      current.answeredBy = input.actor
      current.answeredAt = Date.now()
      current.updatedAt = Date.now()
      delete current.settlingBy
      delete current.settlingAt
      await ctx.storage.set(key, current)
      return { kind: "answered" as const, record: current }
    }
    if (current.status === "answered") {
      if (!current.answeredBy) {
        current.answeredBy = input.actor
        current.updatedAt = Date.now()
        await ctx.storage.set(key, current)
      }
      return { kind: "answered" as const, record: current }
    }
    // Cancelled (or any other terminal state) must not be reported as success.
    return { kind: "cancelled" as const, record: current }
  })
  if (final.kind === "cancelled") {
    return { ok: false, error: `question was cancelled: ${formID}` }
  }
  if (final.kind === "missing") {
    return { ok: false, error: `question record disappeared: ${formID}` }
  }
  return { ok: true, record: final.record }
}
