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
  cancelForm,
  errorText,
  isQuestionForm,
  isSessionID,
  isValidFormID,
  newQuestionMsgID,
  oneLineText,
  questionKey,
  readQuestion,
  renderQuestionBody,
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
  if (!form || !isQuestionForm(form)) {
    return { status: "ignored", reason: "not_question" }
  }
  if (!isValidFormID(form.id) || !isSessionID(form.sessionID)) {
    return { status: "ignored", reason: "invalid_form" }
  }
  const ignore = (reason: string): ForwardResult => {
    if (reason === "no_parent" || reason === "not_paired" || reason === "send_not_granted") {
      console.warn(`postal: question ignored (${reason}) for ${form.id}`)
    }
    return { status: "ignored", reason }
  }
  const target = await deps.readParent(ctx, form.sessionID)
  if (!isSessionID(target) || target === form.sessionID) {
    return ignore("no_parent")
  }
  if (!(await deps.isPaired(ctx, form.sessionID, target))) {
    return ignore("not_paired")
  }
  const grant = await ensureGrant(ctx, deps.lock, form.sessionID, target)
  if (!grant || !isRuleActive(grant.operations.send, "send")) {
    return ignore("send_not_granted")
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

  const letter = {
    from: record.asker,
    to: record.target,
    kind: "question" as const,
    body: renderQuestionBody(form),
    msgID: record.msgID,
    delivery: "steer" as const,
  }
  let sent: { msgID: string } | undefined
  let deliveryError: unknown
  try {
    sent = await deps.postLetter(letter)
  } catch (error) {
    deliveryError = error
  }

  if (!sent) {
    const message = oneLineText(errorText(deliveryError), 200)
    // Mark the record as cancelling under the lock, then run the host cancel in
    // the background so a slow host never holds the question lock.
    await deps.lock(key, async () => {
      const current = await readQuestion(ctx, form.id)
      if (!current || current.status !== "pending") return
      current.cancelling = true
      current.cancellingAt = Date.now()
      current.updatedAt = Date.now()
      await ctx.storage.set(key, current)
    })
    void finishCancellation(ctx, deps, form, message)
    return { status: "failed", error: message }
  }

  // Delivery succeeded. Post-processing errors must never cancel the host form.
  if (sent.msgID && sent.msgID !== record.msgID) {
    try {
      await deps.lock(key, async () => {
        const current = await readQuestion(ctx, form.id)
        if (!current || current.status !== "pending") return
        current.msgID = sent.msgID
        current.updatedAt = Date.now()
        await ctx.storage.set(key, current)
      })
      record.msgID = sent.msgID
    } catch (error) {
      console.warn(
        `postal: question msgID update failed for ${form.id}: ${oneLineText(errorText(error), 200)}`,
      )
    }
  }
  return { status: "forwarded", record }
}

/**
 * Background host-form cancel after a delivery failure. Never throws: all
 * errors are caught and the cancelling marker is always cleared.
 */
async function finishCancellation(
  ctx: FormsContext,
  deps: FormsDeps,
  form: FormInfo,
  message: string,
): Promise<void> {
  const key = questionKey(form.id)
  try {
    const cancelResult = await cancelForm(ctx, deps, {
      sessionID: form.sessionID,
      formID: form.id,
      message: "Postal could not deliver this question to the parent, so it was cancelled.",
    })
    const cancelled = cancelResult.ok
    await deps.lock(key, async () => {
      const current = await readQuestion(ctx, form.id)
      if (!current) return
      delete current.cancelling
      delete current.cancellingAt
      if (current.status === "pending") {
        if (current.settlingBy) {
          // An answer reserved while the cancel was in flight. Leave the record
          // pending and let answerQuestion decide the final state.
          current.note = "cancel_raced: answer in flight"
        } else if (cancelled) {
          current.status = "cancelled"
          delete current.settlingBy
          delete current.settlingAt
          current.cancelledAt = Date.now()
          current.note = `delivery_failed: ${message}`.slice(0, 200)
        } else {
          // The host form is still open; keep the record actionable.
          current.note = `cancel_failed: ${oneLineText(cancelResult.error ?? "unknown", 200)}`.slice(0, 200)
        }
      }
      current.updatedAt = Date.now()
      await ctx.storage.set(key, current)
    })
    console.warn(
      `postal: question delivery failed for ${form.id}: ${message}` +
        (cancelled ? "" : ` (host form not cancelled: ${cancelResult.error ?? "unknown"})`),
    )
  } catch (error) {
    console.warn(
      `postal: question cancel failed for ${form.id}: ${oneLineText(errorText(error), 200)}`,
    )
    await deps
      .lock(key, async () => {
        const current = await readQuestion(ctx, form.id)
        if (!current) return
        if (current.status === "pending") {
          current.note = `cancel_failed: ${oneLineText(errorText(error), 200)}`.slice(0, 200)
        }
        delete current.cancelling
        delete current.cancellingAt
        current.updatedAt = Date.now()
        await ctx.storage.set(key, current)
      })
      .catch(() => {})
  }
}

export async function handleFormReplied(
  ctx: FormsContext,
  deps: FormsDeps,
  event: { data?: { id?: unknown; sessionID?: unknown } },
  now = Date.now(),
): Promise<QuestionRecord | undefined> {
  const formID = typeof event.data?.id === "string" ? event.data.id : ""
  const sessionID = typeof event.data?.sessionID === "string" ? event.data.sessionID : ""
  if (!isValidFormID(formID) || !isSessionID(sessionID)) return undefined
  const key = questionKey(formID)
  let wasSettling = false
  const updated = await deps.lock(key, async () => {
    const record = await readQuestion(ctx, formID)
    if (!record || record.asker !== sessionID || record.status !== "pending") {
      return undefined
    }
    wasSettling = Boolean(record.settlingBy)
    delete record.cancelling
    delete record.cancellingAt
    record.status = "answered"
    // Never credit the actor here: `answeredBy` is set only by answerQuestion
    // after the host confirms the reply.
    delete record.settlingBy
    delete record.settlingAt
    record.answeredAt = now
    record.updatedAt = now
    await ctx.storage.set(key, record)
    return record
  })
  if (!updated) return undefined
  // An in-flight postal_answer will notify nothing; an external settle (human
  // answer, another ancestor) sends the stand-down.
  if (!wasSettling && updated.answeredBy !== updated.target) {
    const by = updated.answeredBy ? ` by ${updated.answeredBy}` : ""
    await notifyTarget(
      ctx,
      deps,
      updated,
      `Question ${oneLineText(updated.formID, 160)} ("${updated.title}") was answered${by}. You do not need to answer it.`,
    )
  }
  return updated
}

export async function handleFormCancelled(
  ctx: FormsContext,
  deps: FormsDeps,
  event: { data?: { id?: unknown; sessionID?: unknown } },
  now = Date.now(),
): Promise<QuestionRecord | undefined> {
  const formID = typeof event.data?.id === "string" ? event.data.id : ""
  const sessionID = typeof event.data?.sessionID === "string" ? event.data.sessionID : ""
  if (!isValidFormID(formID) || !isSessionID(sessionID)) return undefined
  const key = questionKey(formID)
  const updated = await deps.lock(key, async () => {
    const record = await readQuestion(ctx, formID)
    if (!record || record.asker !== sessionID || record.status !== "pending") {
      return undefined
    }
    record.status = "cancelled"
    delete record.settlingBy
    delete record.settlingAt
    delete record.cancelling
    delete record.cancellingAt
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
    `Question ${oneLineText(updated.formID, 160)} ("${updated.title}") was cancelled. You do not need to answer it.`,
  )
  return updated
}
