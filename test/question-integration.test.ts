import { describe, expect, it } from "bun:test"
import plugin from "../index.js"

type Prompt = {
  sessionID: string
  text: string
  delivery?: string
  resume?: boolean
  metadata?: Record<string, any>
}

const flush = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

function eventStream() {
  const queue: any[] = []
  let wake: (() => void) | undefined
  let closed = false
  const stream = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          while (queue.length === 0 && !closed) {
            await new Promise<void>((resolve) => {
              wake = resolve
            })
          }
          if (queue.length > 0) return { value: queue.shift(), done: false }
          return { value: undefined, done: true }
        },
        async return() {
          closed = true
          wake?.()
          wake = undefined
          return { value: undefined, done: true }
        },
      }
    },
  }
  return {
    stream,
    push(event: any) {
      if (closed) return
      queue.push(event)
      wake?.()
      wake = undefined
    },
  }
}

function harness() {
  const storage = new Map<string, unknown>()
  const prompts: Prompt[] = []
  const sessions = new Map<string, { id: string; title: string }>()
  const hooks: Record<string, (event: any) => void | Promise<void>> = {}
  const tools: Record<string, { execute: (input: any, context: any) => Promise<{ content: string }> }> = {}
  const replies: Array<{ sessionID: string; formID: string; answer: unknown }> = []
  const events = eventStream()
  const rpc: Record<string, (input: any) => Promise<any>> = {}
  const context: any = {
    location: { directory: `/tmp/postal-question-${Math.random().toString(36).slice(2)}` },
    options: {},
    session: {
      hook: async (name: string, callback: (event: any) => void) => {
        hooks[name] = callback
      },
      list: async () => ({ data: [...sessions.values()] }),
      get: async ({ sessionID }: { sessionID: string }) => {
        const session = sessions.get(sessionID)
        if (!session) throw new Error(`session not found: ${sessionID}`)
        return session
      },
      prompt: async (input: Prompt) => {
        prompts.push(input)
        return {}
      },
      instructions: {
        entry: {
          put: async () => {},
          remove: async () => {},
        },
      },
      form: {
        reply: async (input: { sessionID: string; formID: string; answer: unknown }) => {
          replies.push(input)
        },
      },
    },
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value)
      },
      remove: async (key: string) => {
        storage.delete(key)
      },
      scan: async ({ prefix, after, limit }: { prefix: string; after?: string; limit?: number }) => {
        const keys = [...storage.keys()].filter((key) => key.startsWith(prefix)).sort()
        const start = after ? keys.indexOf(after) + 1 : 0
        const slice = keys.slice(start, start + (limit ?? 200))
        return {
          entries: slice.map((key) => ({ key, value: storage.get(key) })),
          ...(start + slice.length < keys.length ? { next: slice.at(-1) } : {}),
        }
      },
    },
    tool: {
      transform: async (callback: (editor: any) => void) => {
        callback({
          namespace: () => {},
          add: (tool: any) => {
            tools[tool.name] = tool
          },
        })
      },
    },
    rpc: {
      register: async (_contract: unknown, implementation: Record<string, (input: any) => Promise<any>>) => {
        Object.assign(rpc, implementation)
      },
    },
    event: {
      subscribe: () => events.stream,
    },
  }
  const addSession = (id: string, title: string) => sessions.set(id, { id, title })
  return { context, storage, prompts, hooks, tools, replies, events, rpc, addSession }
}

async function boot() {
  const test = harness()
  const cleanup = await plugin.setup(test.context)
  test.addSession("ses_parent", "Parent")
  test.addSession("ses_child", "Child")
  test.storage.set("parent/ses_child", { parentID: "ses_parent", createdAt: 1 })
  test.storage.set("peers/ses_child", [{ id: "ses_parent", title: "Parent" }])
  test.storage.set("peers/ses_parent", [{ id: "ses_child", title: "Child" }])
  return { ...test, cleanup }
}

function questionEvent(id: string, kind = "question") {
  return {
    type: "form.created",
    data: {
      form: {
        id,
        sessionID: "ses_child",
        title: "Pick a database",
        metadata: { kind, tool: { id: "tool_1", messageID: "msg_1" } },
        fields: [{ key: "q0", type: "string", required: true }],
      },
    },
  }
}

describe("question envelope and bridge", () => {
  it("signs and admits question and answer kinds", async () => {
    const test = await boot()
    const sent = await test.tools.send.execute(
      { to: "ses_parent", text: "Pick one", kind: "question", reply_to: "msg_prev" },
      { sessionID: "ses_child" },
    )
    expect(sent.content).toContain("delivered")
    const letter = test.prompts.at(-1)!
    expect(letter.metadata?.postal?.kind).toBe("question")

    const received = { sessionID: "ses_parent", prompt: { text: letter.text }, metadata: letter.metadata }
    await test.hooks.prompt(received)
    expect(received.prompt.text).toBe(letter.text)

    const answer = await test.tools.send.execute(
      { to: "ses_child", text: "postgres", kind: "answer", reply_to: "msg_prev" },
      { sessionID: "ses_parent" },
    )
    expect(answer.content).toContain("delivered")
    const answerLetter = test.prompts.at(-1)!
    const answerEvent = {
      sessionID: "ses_child",
      prompt: { text: answerLetter.text },
      metadata: answerLetter.metadata,
    }
    await test.hooks.prompt(answerEvent)
    expect(answerEvent.prompt.text).toBe(answerLetter.text)
    test.cleanup?.()
  })

  it("forwards form.created, answers with postal_answer, and stops on cleanup", async () => {
    const test = await boot()
    test.events.push(questionEvent("form_1"))
    await flush()
    expect(test.prompts).toHaveLength(1)
    expect(test.prompts[0]).toMatchObject({ sessionID: "ses_parent", delivery: "steer" })
    expect(test.prompts[0].metadata?.postal?.kind).toBe("question")
    expect(test.prompts[0].text).toContain("postal_answer")
    expect(test.prompts[0].text).not.toContain("Reply with postal_send")

    const answered = await test.tools.answer.execute(
      { form_id: "form_1", answer: { q0: "postgres" } },
      { sessionID: "ses_parent" },
    )
    expect(answered.content).toContain("answered form_1 for ses_child")
    expect(test.replies).toEqual([
      { sessionID: "ses_child", formID: "form_1", answer: { q0: "postgres" } },
    ])

    test.events.push({
      type: "form.replied",
      data: { id: "form_1", sessionID: "ses_child", answer: { q0: "postgres" } },
    })
    await flush()
    expect(test.prompts).toHaveLength(1)

    test.events.push(questionEvent("form_2"))
    await flush()
    test.events.push({ type: "form.cancelled", data: { id: "form_2", sessionID: "ses_child" } })
    await flush()
    expect(test.prompts).toHaveLength(3)
    expect(test.prompts.at(-1)?.metadata?.postal?.kind).toBe("status")

    const before = test.prompts.length
    test.cleanup?.()
    test.events.push(questionEvent("form_3"))
    await flush()
    expect(test.prompts).toHaveLength(before)
  })

  it("ignores non-question forms and denies a child answering its own question", async () => {
    const test = await boot()
    test.events.push(questionEvent("form_1", "mcp"))
    await flush()
    expect(test.prompts).toHaveLength(0)

    test.storage.set("question/form_9", {
      formID: "form_9",
      asker: "ses_child",
      target: "ses_parent",
      msgID: "msg_9",
      title: "Q",
      status: "pending",
      createdAt: 1,
      updatedAt: 1,
    })
    const denied = await test.tools.answer.execute(
      { form_id: "form_9", answer: { q0: "x" } },
      { sessionID: "ses_child" },
    )
    expect(denied.content).toContain("not an ancestor")
    test.cleanup?.()
  })
  it("skips cross-location events and over-limit question letters", async () => {
    const test = await boot()
    test.events.push({ ...questionEvent("form_loc"), location: { directory: "/elsewhere" } })
    await flush()
    expect(test.prompts).toHaveLength(0)

    test.storage.set("rally/ses_child:ses_parent", { count: 30, at: Date.now() })
    test.events.push(questionEvent("form_rally"))
    await flush()
    expect(test.prompts).toHaveLength(0)
    test.cleanup?.()
  })

})
