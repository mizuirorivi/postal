import { afterEach, describe, expect, it } from "bun:test"
import { cancelForm, type FormsContext, type FormsDeps } from "../forms.js"

function makeContext(): FormsContext {
  return {
    storage: {
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
    },
    options: {},
    session: { form: {} },
  }
}

function baseDeps(overrides: Partial<FormsDeps> = {}): FormsDeps {
  return {
    lock: async (_key, task) => task(),
    readParent: async () => undefined,
    authorizingAncestor: async () => undefined,
    isPaired: async () => true,
    postLetter: async (input) => ({ msgID: input.msgID ?? "msg_generated" }),
    timeoutMs: 1000,
    env: {},
    home: "/nonexistent-postal-test-home",
    readFile: () => {
      throw new Error("missing")
    },
    ...overrides,
  }
}

let service: ReturnType<typeof Bun.serve> | undefined

afterEach(() => {
  service?.stop(true)
  service = undefined
})

describe("cancelForm HTTP contract", () => {
  it("DELETEs the form with the message query and returns ok", async () => {
    let captured: { method: string; path: string; query: string; auth: string } | undefined
    service = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        captured = {
          method: request.method,
          path: url.pathname,
          query: url.searchParams.get("message") ?? "",
          auth: request.headers.get("authorization") ?? "",
        }
        return new Response(null, { status: 204 })
      },
    })
    const result = await cancelForm(
      makeContext(),
      baseDeps({
        env: {
          OPENCODE_SERVER_URL: `http://127.0.0.1:${service.port}`,
          OPENCODE_SERVER_PASSWORD: "pw",
        },
      }),
      { sessionID: "ses_child", formID: "frm_1", message: "delivery failed" },
    )
    expect(result).toEqual({ ok: true, via: "http" })
    expect(captured?.method).toBe("DELETE")
    expect(captured?.path).toBe("/api/session/ses_child/form/frm_1")
    expect(captured?.query).toBe("delivery failed")
    expect(captured?.auth).toBe(`Basic ${Buffer.from("opencode:pw").toString("base64")}`)
  })

  it("returns ok:false when the host cancel returns 404", async () => {
    service = Bun.serve({
      port: 0,
      fetch: async () =>
        new Response(
          JSON.stringify({ _tag: "FormNotFoundError", id: "frm_1", message: "Form not found: frm_1" }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
    })
    const result = await cancelForm(
      makeContext(),
      baseDeps({
        env: {
          OPENCODE_SERVER_URL: `http://127.0.0.1:${service.port}`,
          OPENCODE_SERVER_PASSWORD: "pw",
        },
      }),
      { sessionID: "ses_child", formID: "frm_1", message: "x" },
    )
    expect(result.ok).toBe(false)
    expect(result.via).toBe("http")
  })

  it("prefers the runtime cancel", async () => {
    const calls: Array<{ sessionID: string; formID: string; message?: string }> = []
    const ctx = makeContext()
    ctx.session = {
      form: {
        cancel: async (input) => {
          calls.push(input)
        },
      },
    }
    const result = await cancelForm(ctx, baseDeps(), {
      sessionID: "ses_child",
      formID: "frm_1",
      message: "m",
    })
    expect(result).toEqual({ ok: true, via: "runtime" })
    expect(calls).toEqual([{ sessionID: "ses_child", formID: "frm_1", message: "m" }])
  })

  it("falls back to HTTP when the runtime cancel throws", async () => {
    const runtimeCalls: unknown[] = []
    service = Bun.serve({ port: 0, fetch: async () => new Response(null, { status: 204 }) })
    const ctx = makeContext()
    ctx.session = {
      form: {
        cancel: async (input) => {
          runtimeCalls.push(input)
          throw new Error("runtime boom")
        },
      },
    }
    const result = await cancelForm(
      ctx,
      baseDeps({
        env: {
          OPENCODE_SERVER_URL: `http://127.0.0.1:${service.port}`,
          OPENCODE_SERVER_PASSWORD: "pw",
        },
      }),
      { sessionID: "ses_child", formID: "frm_1", message: "m" },
    )
    expect(result).toEqual({ ok: true, via: "http" })
    expect(runtimeCalls).toHaveLength(1)
  })

  it("retries 5xx up to three attempts and then succeeds", async () => {
    let hits = 0
    service = Bun.serve({
      port: 0,
      fetch: async () => {
        hits += 1
        return new Response(null, { status: hits < 3 ? 500 : 204 })
      },
    })
    const result = await cancelForm(
      makeContext(),
      baseDeps({
        env: {
          OPENCODE_SERVER_URL: `http://127.0.0.1:${service.port}`,
          OPENCODE_SERVER_PASSWORD: "pw",
        },
      }),
      { sessionID: "ses_child", formID: "frm_1" },
    )
    expect(result).toEqual({ ok: true, via: "http" })
    expect(hits).toBe(3)
  })

  it("does not retry a 4xx", async () => {
    let hits = 0
    service = Bun.serve({
      port: 0,
      fetch: async () => {
        hits += 1
        return new Response(
          JSON.stringify({ _tag: "FormNotFoundError", id: "frm_1", message: "Form not found: frm_1" }),
          { status: 404, headers: { "content-type": "application/json" } },
        )
      },
    })
    const result = await cancelForm(
      makeContext(),
      baseDeps({
        env: {
          OPENCODE_SERVER_URL: `http://127.0.0.1:${service.port}`,
          OPENCODE_SERVER_PASSWORD: "pw",
        },
      }),
      { sessionID: "ses_child", formID: "frm_1" },
    )
    expect(result.ok).toBe(false)
    expect(hits).toBe(1)
  })
})
