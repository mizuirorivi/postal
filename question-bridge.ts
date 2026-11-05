/**
 * Postal v2 question/answer — form event flows.
 *
 * `form.created` forwards a host `question` form to the asking session's
 * current parent. `form.replied`/`form.cancelled` close the Postal-side record
 * and tell the parent to stand down when the form was settled elsewhere.
 *
 * A blocking question is delivered with `steer` (interrupt) regardless of the
 * relation's inbox/idle policy: a queued question would deadlock the child.
 */
import { ensureGrant, isRuleActive } from "./grants.js"
import {
  errorText,
  newQuestionMsgID,
  oneLineText,
  questionKey,
  readQuestion,
  renderQuestionBody,
  type FormAnswer,
  type FormInfo,
  type FormsContext,
  type FormsDeps,
  type QuestionRecord,
} from "./forms.js"

export type ForwardResult =
  | { status: "forwarded"; record: QuestionRecord }
  | { status: "duplicate" }
  | { status: "ignored"; reason: string }
  | { status: "failed"; error: string }

async function notifyTarget(
  ctx: FormsContext,
  deps: FormsDeps,
  record: QuestionRecord,
  body: string,
): Promise<void> {
  const grant = await ensureGrant(ctx, deps.lock, record.asker, record.target)
  if (!grant || !isRuleActive(grant.operations.send, "send")) return
  await deps
    .postLetter({
      from: record.asker,
      to: record.target,
      kind: "status",
      body,
      replyTo: record.msgID,
    })
    .catch(() => {})
}

/**
 * Forward a question form to the asking session's current parent.
 *
 * Only forms created by the host `question` tool are forwarded
 * (`metadata.kind === "question"`); elicitation and other forms stay local.
 */
export async function forwardQuestion(
  ctx: FormsContext,
  deps: FormsDeps,
  form: FormInfo,
  now = Date.now(),
): Promise<ForwardResult> {
  if (!form || form.metadata?.kind !== "question") {
    return { status: "ignored", reason: "not_question" }
  }
  if (
    typeof form.id !== "string" ||
    !form.id ||
    typeof form.sessionID !== "string" ||
    !form.sessionID
  ) {
    return { status: "ignored", reason: "invalid_form" }
  }
  const target = await deps.readParent(ctx, form.sessionID)
  if (!target || target === form.sessionID) return { status: "ignored", reason: "no_parent" }
  const grant = await ensureGrant(ctx, deps.lock, form.sessionID, target)
  if (!grant || !isRuleActive(grant.operations.send, "send")) {
    return { status: "ignored", reason: "send_not_granted" }
  }

  const key = questionKey(form.id)
  const reserved = await deps.lock(key, async () => {
    const existing = await readQuestion(ctx, form.id)
    if (existing) return { existing }
    const record: QuestionRecord = {
      formID: form.id,
      asker: form.sessionID,
      target,
      msgID: newQuestionMsgID(),
      title: oneLineText(form.title, 200),
      status: "pending",
      createdAt: now,
      updatedAt: now,
    }
    await ctx.storage.set(key, record)
    return { record }
  })
  if ("existing" in reserved) return { status: "duplicate" }
  const record = reserved.record

  try {
    const sent = await deps.postLetter({
      from: record.asker,
      to: record.target,
      kind: "question",
      body: renderQuestionBody(form),
      msgID: record.msgID,
      delivery: "steer",
    })
    if (sent.msgID && sent.msgID !== record.msgID) {
      await deps.lock(key, async () => {
        const current = await readQuestion(ctx, form.id)
        if (!current || current.status !== "pending") return
        current.msgID = sent.msgID
        current.updatedAt = Date.now()
        await ctx.storage.set(key, current)
      })
      record.msgID = sent.msgID
    }
    return { status: "forwarded", record }
  } catch (error) {
    await deps.lock(key, async () => {
      const current = await readQuestion(ctx, form.id)
      if (current?.status === "pending" && current.msgID === record.msgID) {
        await ctx.storage.remove(key)
      }
    })
    return { status: "failed", error: errorText(error) }
  }
}

export async function handleFormReplied(
  ctx: FormsContext,
  deps: FormsDeps,
  event: { data: { id: string; sessionID: string; answer: FormAnswer } },
  now = Date.now(),
): Promise<QuestionRecord | undefined> {
  const key = questionKey(event.data.id)
  const updated = await deps.lock(key, async () => {
    const record = await readQuestion(ctx, event.data.id)
    if (!record || record.asker !== event.data.sessionID || record.status !== "pending") {
      return undefined
    }
    record.status = "answered"
    if (record.settlingBy) record.answeredBy = record.settlingBy
    delete record.settlingBy
    record.answeredAt = now
    record.updatedAt = now
    await ctx.storage.set(key, record)
    return record
  })
  if (!updated) return undefined
  if (updated.answeredBy !== updated.target) {
    const by = updated.answeredBy ? ` by ${updated.answeredBy}` : ""
    await notifyTarget(
      ctx,
      deps,
      updated,
      `Question ${updated.formID} ("${updated.title}") was answered${by}. You do not need to answer it.`,
    )
  }
  return updated
}

export async function handleFormCancelled(
  ctx: FormsContext,
  deps: FormsDeps,
  event: { data: { id: string; sessionID: string } },
  now = Date.now(),
): Promise<QuestionRecord | undefined> {
  const key = questionKey(event.data.id)
  const updated = await deps.lock(key, async () => {
    const record = await readQuestion(ctx, event.data.id)
    if (!record || record.asker !== event.data.sessionID || record.status !== "pending") {
      return undefined
    }
    record.status = "cancelled"
    delete record.settlingBy
    record.cancelledAt = now
    record.updatedAt = now
    await ctx.storage.set(key, record)
    return record
  })
  if (!updated) return undefined
  await notifyTarget(
    ctx,
    deps,
    updated,
    `Question ${updated.formID} ("${updated.title}") was cancelled. You do not need to answer it.`,
  )
  return updated
}
