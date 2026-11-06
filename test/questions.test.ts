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
  const cancels: Array<{ sessionID: string; formID: string; message?: string }> = []
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
        cancel: async (input) => {
          cancels.push(input)
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
  return { ctx, deps, storage, parents, letters, replies, cancels }
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

  it("cancels the host form and keeps the record when delivery fails", async () => {
    const test = harness()
    setParent(test, "ses_child", "ses_parent")
    const deps: FormsDeps = {
      ...test.deps,
      postLetter: async () => {
        throw new Error("delivery failed")
      },
    }
    const result = await forwardQuestion(test.ctx, deps, form)
    expect(result).toMatchObject({ status: "failed", cancelled: true })
    expect(test.cancels).toHaveLength(1)
    expect(test.cancels[0]).toMatchObject({ sessionID: "ses_child", formID: "form_1" })
    expect(await readQuestion(test.ctx, "form_1")).toMatchObject({
      status: "cancelled",
      note: expect.stringContaining("delivery_failed"),
    })
  })

  it("cancels the host form over HTTP when only the HTTP cancel path is available", async () => {
    const test = harness()
    setParent(test, "ses_child", "ses_parent")
    const ctx: FormsContext = { ...test.ctx, session: { form: {} } }
    const deletes: Array<{ method: string; path: string; query: string }> = []
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        if (request.method === "DELETE") {
          deletes.push({
            method: request.method,
            path: url.pathname,
            query: url.searchParams.get("message") ?? "",
          })
        }
        return new Response(null, { status: 204 })
      },
    })
    const deps: FormsDeps = {
      ...test.deps,
      env: {
        OPENCODE_SERVER_URL: `http://127.0.0.1:${server.port}`,
        OPENCODE_SERVER_PASSWORD: "pw",
      },
      postLetter: async () => {
        throw new Error("delivery failed")
      },
    }
    try {
      const result = await forwardQuestion(ctx, deps, form)
      expect(result).toMatchObject({ status: "failed", cancelled: true })
      expect(deletes).toHaveLength(1)
      expect(deletes[0].method).toBe("DELETE")
      expect(deletes[0].path).toBe("/api/session/ses_child/form/form_1")
      expect(deletes[0].query.length).toBeGreaterThan(0)
      expect(await readQuestion(ctx, "form_1")).toMatchObject({
        status: "cancelled",
        note: expect.stringContaining("delivery_failed"),
      })
    } finally {
      server.stop(true)
    }
  })

  it("reports failed, warns, and keeps the record pending when no cancel means exists", async () => {
    const test = harness()
    setParent(test, "ses_child", "ses_parent")
    const ctx: FormsContext = { ...test.ctx, session: { form: {} } }
    const deps: FormsDeps = {
      ...test.deps,
      postLetter: async () => {
        throw new Error("no transport")
      },
    }
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "))
    }
    try {
      const result = await forwardQuestion(ctx, deps, form)
      expect(result).toMatchObject({ status: "failed", cancelled: false })
      const joined = warnings.join("\n")
      expect(joined).toContain("question delivery failed")
      expect(joined).toContain("host form not cancelled")
    } finally {
      console.warn = originalWarn
    }
    const record = await readQuestion(ctx, "form_1")
    expect(record?.status).toBe("pending")
    expect(record?.note).toContain("cancel_failed")
  })

  it("keeps the record pending when the host cancel returns 404", async () => {
    const test = harness()
    setParent(test, "ses_child", "ses_parent")
    const ctx: FormsContext = { ...test.ctx, session: { form: {} } }
    const server = Bun.serve({
      port: 0,
      fetch: async () =>
        new Response(
          JSON.stringify({ _tag: "FormNotFoundError", id: "form_1", message: "Form not found: form_1" }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
    })
    const deps: FormsDeps = {
      ...test.deps,
      env: {
        OPENCODE_SERVER_URL: `http://127.0.0.1:${server.port}`,
        OPENCODE_SERVER_PASSWORD: "pw",
      },
      postLetter: async () => {
        throw new Error("boom")
      },
    }
    try {
      const result = await forwardQuestion(ctx, deps, form)
      expect(result).toMatchObject({ status: "failed", cancelled: false })
      const record = await readQuestion(ctx, "form_1")
      expect(record?.status).toBe("pending")
      expect(record?.note).toContain("cancel_failed")
    } finally {
      server.stop(true)
    }
  })

  it("keeps the delivery when only the post-delivery bookkeeping fails", async () => {
    const test = harness()
    setParent(test, "ses_child", "ses_parent")
    let failNext = false
    const ctx: FormsContext = {
      ...test.ctx,
      storage: {
        get: test.ctx.storage.get,
        remove: test.ctx.storage.remove,
        set: async (key, value) => {
          if (failNext) throw new Error("storage exploded")
          await test.ctx.storage.set(key, value)
        },
      },
    }
    const deps: FormsDeps = {
      ...test.deps,
      postLetter: async () => {
        failNext = true
        return { msgID: "msg_new" }
      },
    }
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "))
    }
    try {
      const result = await forwardQuestion(ctx, deps, form)
      expect(result).toMatchObject({ status: "forwarded" })
      expect(test.cancels).toHaveLength(0)
      expect(warnings.join("\n")).toContain("msgID update failed")
    } finally {
      console.warn = originalWarn
    }
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
