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

export async function answerQuestion(
  ctx: FormsContext,
  deps: FormsDeps,
  input: { actor: string; formID: string; answer: unknown },
  now = Date.now(),
): Promise<AnswerResult> {
  const formID = typeof input.formID === "string" ? input.formID.trim() : ""
  if (!formID || formID.length > 256) return { ok: false, error: "form_id is required" }
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
    if (current.settlingBy && current.settlingBy !== input.actor) {
      return { error: `question is being answered by ${current.settlingBy}` }
    }
    current.settlingBy = input.actor
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
      current.updatedAt = Date.now()
      if (reply.status === 404) {
        current.status = "cancelled"
        current.cancelledAt = Date.now()
        current.note = "form_not_found"
      } else if (reply.status === 409) {
        current.status = "answered"
        current.answeredBy = input.actor
        current.answeredAt = Date.now()
        current.note = "form_already_settled"
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
    if (!current) return undefined
    if (current.status === "pending") {
      current.status = "answered"
      current.answeredBy = input.actor
      current.answeredAt = Date.now()
      current.updatedAt = Date.now()
      delete current.settlingBy
      await ctx.storage.set(key, current)
    } else if (current.status === "answered" && !current.answeredBy) {
      current.answeredBy = input.actor
      current.updatedAt = Date.now()
      await ctx.storage.set(key, current)
    }
    return current
  })
  return { ok: true, record: final ?? record }
}
