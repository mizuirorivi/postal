import { describe, expect, it } from "bun:test"
import { answerQuestion } from "../question-answer.js"
import { questionKey, readQuestion, type FormsContext, type FormsDeps } from "../forms.js"
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
  const parents = new Map<string, string>([["ses_child", "ses_parent"]])
  const replies: Array<{ sessionID: string; formID: string; answer: unknown }> = []
  storage.set("parent/ses_child", { parentID: "ses_parent", createdAt: 1 })
  storage.set(questionKey("form_1"), {
    formID: "form_1",
    asker: "ses_child",
    target: "ses_parent",
    msgID: "msg_1",
    title: "Pick a database",
    status: "pending",
    createdAt: 1,
    updatedAt: 1,
  })
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
    postLetter: async (input) => ({ msgID: input.msgID ?? "msg_generated" }),
    env: {},
    home: "/nonexistent-postal-test-home",
    readFile: () => {
      throw new Error("missing")
    },
  }
  return { ctx, deps, storage, replies }
}

function revokeTask(test: ReturnType<typeof harness>): void {
  test.storage.set("grants/ses_parent/ses_child", {
    from: "ses_parent",
    to: "ses_child",
    operations: { task: { allowed: false, approvalRequired: false } },
    delivery: "interrupt",
    initialized: true,
    createdAt: 1,
    updatedAt: 1,
  })
}

describe("postal_answer", () => {
  it("answers as the parent and records who answered", async () => {
    const test = harness()
    const result = await answerQuestion(test.ctx, test.deps, {
      actor: "ses_parent",
      formID: "form_1",
      answer: { q0: "postgres" },
    })
    expect(result.ok).toBe(true)
    expect(test.replies).toEqual([
      { sessionID: "ses_child", formID: "form_1", answer: { q0: "postgres" } },
    ])
    expect(await readQuestion(test.ctx, "form_1")).toMatchObject({
      status: "answered",
      answeredBy: "ses_parent",
    })
  })

  it("rejects a non-ancestor and an ancestor without the task grant", async () => {
    const test = harness()
    expect(
      await answerQuestion(test.ctx, test.deps, {
        actor: "ses_other",
        formID: "form_1",
        answer: { q0: "x" },
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("not an ancestor") })

    revokeTask(test)
    expect(
      await answerQuestion(test.ctx, test.deps, {
        actor: "ses_parent",
        formID: "form_1",
        answer: { q0: "x" },
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("task grant required") })
  })

  it("rejects invalid answers and unknown forms", async () => {
    const test = harness()
    expect(
      await answerQuestion(test.ctx, test.deps, {
        actor: "ses_parent",
        formID: "form_1",
        answer: { q0: { nested: true } },
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("invalid value") })
    expect(
      await answerQuestion(test.ctx, test.deps, {
        actor: "ses_parent",
        formID: "form_missing",
        answer: { q0: "x" },
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("unknown question") })
  })

  it("clears the settling marker when the form API fails", async () => {
    const test = harness()
    test.ctx.session = {
      form: {
        reply: async () => {
          throw new Error("host exploded")
        },
      },
    }
    const result = await answerQuestion(test.ctx, test.deps, {
      actor: "ses_parent",
      formID: "form_1",
      answer: { q0: "x" },
    })
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("host exploded") })
    const record = await readQuestion(test.ctx, "form_1")
    expect(record?.status).toBe("pending")
    expect(record?.settlingBy).toBeUndefined()
  })

  it("refuses to race another answerer", async () => {
    const test = harness()
    const stored = test.storage.get(questionKey("form_1")) as Record<string, unknown>
    test.storage.set(questionKey("form_1"), { ...stored, settlingBy: "ses_grand" })
    expect(
      await answerQuestion(test.ctx, test.deps, {
        actor: "ses_parent",
        formID: "form_1",
        answer: { q0: "x" },
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("being answered by ses_grand") })
  })
})
