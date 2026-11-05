import { describe, expect, it } from "bun:test"
import {
  discoverService,
  questionKey,
  readQuestion,
  renderQuestionBody,
  validateAnswer,
  type FormInfo,
  type FormsContext,
} from "../forms.js"

function makeContext(initial?: Record<string, unknown>): { ctx: FormsContext; storage: Map<string, unknown> } {
  const storage = new Map<string, unknown>(Object.entries(initial ?? {}))
  return {
    storage,
    ctx: {
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
    },
  }
}

const form: FormInfo = {
  id: "form_1",
  sessionID: "ses_child",
  title: "Pick a database",
  metadata: { kind: "question" },
  fields: [
    {
      key: "q0",
      type: "string",
      title: "Database",
      description: "Which database should I use?",
      required: true,
      options: [
        { value: "postgres", label: "PostgreSQL" },
        { value: "sqlite", label: "SQLite" },
      ],
    },
    { key: "q1", type: "boolean", title: "Migrate now?" },
  ],
}

describe("question records", () => {
  it("normalizes a stored record and rejects malformed ones", async () => {
    const { ctx } = makeContext({
      [questionKey("form_1")]: {
        asker: "ses_child",
        target: "ses_parent",
        msgID: "msg_1",
        title: "  Pick\n a database ",
        status: "pending",
        createdAt: 10,
        updatedAt: 20,
        settlingBy: "ses_parent",
      },
      [questionKey("bad")]: { asker: "ses_child" },
    })
    expect(await readQuestion(ctx, "form_1")).toMatchObject({
      formID: "form_1",
      asker: "ses_child",
      target: "ses_parent",
      msgID: "msg_1",
      title: "Pick a database",
      status: "pending",
      settlingBy: "ses_parent",
    })
    expect(await readQuestion(ctx, "bad")).toBeUndefined()
  })

  it("renders a compact letter with field keys, types, and options", () => {
    const body = renderQuestionBody(form, "Child title")
    expect(body).toContain("Question from ses_child (Child title): Pick a database")
    expect(body).toContain("form_id: form_1")
    expect(body).toContain("- q0 (string, required) Database: Which database should I use?")
    expect(body).toContain("options: postgres (PostgreSQL), sqlite (SQLite)")
    expect(body).toContain('postal_answer({ form_id: "form_1"')
    expect(body.length).toBeLessThanOrEqual(8 * 1024)
  })
})

describe("answer shape", () => {
  it("accepts primitives and string arrays", () => {
    expect(validateAnswer({ q0: "postgres", q1: true, q2: 3, q3: ["a", "b"] })).toEqual({
      ok: true,
      answer: { q0: "postgres", q1: true, q2: 3, q3: ["a", "b"] },
    })
  })

  it("rejects non-objects, prototype keys, non-finite numbers, and oversized values", () => {
    expect(validateAnswer(null)).toMatchObject({ ok: false })
    expect(validateAnswer(["q0"])).toMatchObject({ ok: false })
    expect(validateAnswer(JSON.parse('{"__proto__": {"x": 1}}'))).toMatchObject({ ok: false })
    expect(validateAnswer({ q0: Number.NaN })).toMatchObject({ ok: false })
    expect(validateAnswer({ q0: "x".repeat(40_000) })).toMatchObject({ ok: false })
    expect(validateAnswer({ q0: [1, 2] })).toMatchObject({ ok: false })
  })
})

describe("service discovery", () => {
  it("uses the state registration and refuses non-loopback HTTP", () => {
    expect(
      discoverService({
        env: { XDG_STATE_HOME: "/state" },
        home: "/home/test",
        readFile: (path) => {
          expect(path).toBe("/state/opencode/service.json")
          return JSON.stringify({ url: "http://127.0.0.1:49374", password: "secret" })
        },
      }),
    ).toEqual({ url: "http://127.0.0.1:49374", username: "opencode", password: "secret" })

    expect(
      discoverService({
        env: { OPENCODE_SERVER_URL: "http://example.com:49374", OPENCODE_SERVER_PASSWORD: "secret" },
        home: "/home/test",
        readFile: () => {
          throw new Error("missing")
        },
      }),
    ).toBeUndefined()
  })
})
