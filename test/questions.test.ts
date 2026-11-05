import { describe, expect, it } from "bun:test"
import {
  forwardQuestion,
  handleFormCancelled,
  handleFormReplied,
} from "../question-bridge.js"
import {
  questionKey,
  readQuestion,
  type FormInfo,
  type FormsContext,
  type FormsDeps,
  type PostLetterInput,
} from "../forms.js"
import type { Lock } from "../grants.js"

function makeLock(): Lock {
  const tails = new Map<string, Promise<unknown>>()
  return async <T>(key: string, task: () => Promise<T> | T): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    tails.set(key, next.catch(() => {}))
    return next as Promise<T>
  }
}

function harness() {
  const storage = new Map<string, unknown>()
  const parents = new Map<string, string>()
  const letters: PostLetterInput[] = []
  const replies: Array<{ sessionID: string; formID: string; answer: unknown }> = []
  const ctx: FormsContext = {
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value)
      },
      remove: async (key: string) => {
        storage.delete(key)
      },
    },
    options: {},
    session: {
      form: {
        reply: async (input) => {
          replies.push(input)
        },
      },
    },
  }
  const deps: FormsDeps = {
    lock: makeLock(),
    readParent: async (_ctx, id) => parents.get(id),
    authorizingAncestor: async (_ctx, actor, target) => {
      let current = target
      for (let depth = 0; depth < 16; depth += 1) {
        const parent = parents.get(current)
        if (!parent) return undefined
        if (parent === actor) return actor
        current = parent
      }
      return undefined
    },
    isPaired: async () => true,
    postLetter: async (input) => {
      letters.push(input)
      return { msgID: input.msgID ?? "msg_generated" }
    },
    env: {},
    home: "/nonexistent-postal-test-home",
    readFile: () => {
      throw new Error("missing")
    },
  }
  return { ctx, deps, storage, parents, letters, replies }
}

function setParent(test: ReturnType<typeof harness>, child: string, parent: string): void {
  test.parents.set(child, parent)
  test.storage.set(`parent/${child}`, { parentID: parent, createdAt: 1 })
}

function clearParent(test: ReturnType<typeof harness>, child: string): void {
  test.parents.delete(child)
  test.storage.delete(`parent/${child}`)
}

const form: FormInfo = {
  id: "form_1",
  sessionID: "ses_child",
  title: "Pick a database",
  metadata: { kind: "question", tool: { id: "tool_1", messageID: "msg_1" } },
  fields: [{ key: "q0", type: "string", required: true }],
}

describe("question forwarding", () => {
  it("forwards a question form to the current parent exactly once", async () => {
    const test = harness()
    setParent(test, "ses_child", "ses_parent")
    expect(await forwardQuestion(test.ctx, test.deps, form)).toMatchObject({ status: "forwarded" })
    expect(test.letters).toHaveLength(1)
    expect(test.letters[0]).toMatchObject({
      from: "ses_child",
      to: "ses_parent",
      kind: "question",
      delivery: "steer",
    })
    expect(test.letters[0].body).toContain("form_id: form_1")
    expect(await readQuestion(test.ctx, "form_1")).toMatchObject({
      status: "pending",
      asker: "ses_child",
      target: "ses_parent",
    })
    expect(await forwardQuestion(test.ctx, test.deps, form)).toMatchObject({ status: "duplicate" })
    expect(test.letters).toHaveLength(1)
  })

  it("ignores non-question forms, forms without a parent, and revoked send", async () => {
    const test = harness()
    setParent(test, "ses_child", "ses_parent")
    expect(
      await forwardQuestion(test.ctx, test.deps, { ...form, metadata: { kind: "mcp" } }),
    ).toMatchObject({ status: "ignored", reason: "not_question" })
    expect(
      await forwardQuestion(test.ctx, test.deps, { ...form, metadata: { kind: "question" } }),
    ).toMatchObject({ status: "ignored", reason: "not_question" })
    expect(
      await forwardQuestion(test.ctx, test.deps, { ...form, id: "bad id" }),
    ).toMatchObject({ status: "ignored", reason: "invalid_form" })
    expect(
      await forwardQuestion(test.ctx, { ...test.deps, isPaired: async () => false }, form),
    ).toMatchObject({ status: "ignored", reason: "not_paired" })

    clearParent(test, "ses_child")
    expect(await forwardQuestion(test.ctx, test.deps, form)).toMatchObject({
      status: "ignored",
      reason: "no_parent",
    })

    setParent(test, "ses_child", "ses_parent")
    test.storage.set("grants/ses_child/ses_parent", {
      from: "ses_child",
      to: "ses_parent",
      operations: { send: { allowed: false, approvalRequired: false } },
      delivery: "interrupt",
      initialized: true,
      createdAt: 1,
      updatedAt: 1,
    })
    expect(await forwardQuestion(test.ctx, test.deps, form)).toMatchObject({
      status: "ignored",
      reason: "send_not_granted",
    })
    expect(test.letters).toHaveLength(0)
  })

  it("removes the record when delivery fails so a retry can forward", async () => {
    const test = harness()
    setParent(test, "ses_child", "ses_parent")
    const deps: FormsDeps = {
      ...test.deps,
      postLetter: async () => {
        throw new Error("delivery failed")
      },
    }
    expect(await forwardQuestion(test.ctx, deps, form)).toMatchObject({ status: "failed" })
    expect(await readQuestion(test.ctx, "form_1")).toBeUndefined()
  })
})

describe("question resolution", () => {
  it("marks a replied question answered and tells the parent to stand down", async () => {
    const test = harness()
    setParent(test, "ses_child", "ses_parent")
    await forwardQuestion(test.ctx, test.deps, form)
    const replied = await handleFormReplied(test.ctx, test.deps, {
      data: { id: "form_1", sessionID: "ses_child", answer: { q0: "postgres" } },
    })
    expect(replied).toMatchObject({ status: "answered" })
    expect(test.letters).toHaveLength(2)
    expect(test.letters[1]).toMatchObject({
      from: "ses_child",
      to: "ses_parent",
      kind: "status",
      replyTo: test.letters[0].msgID,
    })
    expect(await readQuestion(test.ctx, "form_1")).toMatchObject({ status: "answered" })
    expect(
      await handleFormReplied(test.ctx, test.deps, {
        data: { id: "form_1", sessionID: "ses_child", answer: {} },
      }),
    ).toBeUndefined()
    expect(test.letters).toHaveLength(2)
  })

  it("does not notify the target when the target answered", async () => {
    const test = harness()
    setParent(test, "ses_child", "ses_parent")
    await forwardQuestion(test.ctx, test.deps, form)
    const stored = test.storage.get(questionKey("form_1")) as Record<string, unknown>
    test.storage.set(questionKey("form_1"), { ...stored, settlingBy: "ses_parent" })
    await handleFormReplied(test.ctx, test.deps, {
      data: { id: "form_1", sessionID: "ses_child", answer: { q0: "postgres" } },
    })
    expect(test.letters).toHaveLength(1)
  })

  it("marks a cancelled question and tells the parent to stand down", async () => {
    const test = harness()
    setParent(test, "ses_child", "ses_parent")
    await forwardQuestion(test.ctx, test.deps, form)
    const cancelled = await handleFormCancelled(test.ctx, test.deps, {
      data: { id: "form_1", sessionID: "ses_child" },
    })
    expect(cancelled).toMatchObject({ status: "cancelled" })
    expect(test.letters).toHaveLength(2)
    expect(test.letters[1].body).toContain("cancelled")
  })
})
