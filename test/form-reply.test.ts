import { afterEach, describe, expect, it } from "bun:test"
import { discoverService, replyToForm, type FormsContext, type FormsDeps } from "../forms.js"

function makeContext(): FormsContext {
  return {
    storage: {
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
    },
    options: {},
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
let proxy: ReturnType<typeof Bun.serve> | undefined

afterEach(() => {
  service?.stop(true)
  proxy?.stop(true)
  service = undefined
  proxy = undefined
})

describe("HTTP form reply transport", () => {
  it("posts directly to the loopback endpoint with Basic auth and no redirect", async () => {
    let captured: { method: string; url: string; auth: string; body: string } | undefined
    service = Bun.serve({
      port: 0,
      fetch: async (request) => {
        captured = {
          method: request.method,
          url: new URL(request.url).pathname,
          auth: request.headers.get("authorization") ?? "",
          body: await request.text(),
        }
        return new Response(null, { status: 204 })
      },
    })
    const result = await replyToForm(
      makeContext(),
      baseDeps({
        env: {
          OPENCODE_SERVER_URL: `http://127.0.0.1:${service.port}`,
          OPENCODE_SERVER_PASSWORD: "pw",
        },
      }),
      { sessionID: "ses_child", formID: "form_1", answer: { q0: "postgres", q1: true } },
    )
    expect(result).toEqual({ ok: true, via: "http" })
    expect(captured?.method).toBe("POST")
    expect(captured?.url).toBe("/api/session/ses_child/form/form_1/reply")
    expect(captured?.auth).toBe(`Basic ${Buffer.from("opencode:pw").toString("base64")}`)
    expect(JSON.parse(captured?.body ?? "{}")).toEqual({ answer: { q0: "postgres", q1: true } })
  })

  it("returns the host status and a sanitized message", async () => {
    service = Bun.serve({
      port: 0,
      fetch: async () =>
        new Response(JSON.stringify({ message: "Form already settled: form_1" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
    })
    const result = await replyToForm(
      makeContext(),
      baseDeps({
        env: {
          OPENCODE_SERVER_URL: `http://127.0.0.1:${service.port}`,
          OPENCODE_SERVER_PASSWORD: "pw",
        },
      }),
      { sessionID: "ses_child", formID: "form_1", answer: { q0: "x" } },
    )
    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: "form reply failed (HTTP 409): Form already settled: form_1",
    })
  })

  it("times out and caps oversized error bodies", async () => {
    service = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (new URL(request.url).pathname.includes("/form/slow/")) {
          await new Promise((resolve) => setTimeout(resolve, 150))
          return new Response(null, { status: 204 })
        }
        return new Response("x".repeat(10_000), { status: 500 })
      },
    })
    const endpoint = {
      env: {
        OPENCODE_SERVER_URL: `http://127.0.0.1:${service.port}`,
        OPENCODE_SERVER_PASSWORD: "pw",
      },
    }
    const timeout = await replyToForm(makeContext(), baseDeps({ ...endpoint, timeoutMs: 20 }), {
      sessionID: "ses_child",
      formID: "slow",
      answer: { q0: "x" },
    })
    expect(timeout.ok).toBe(false)
    if (!timeout.ok) expect(timeout.error).toContain("timed out")

    const capped = await replyToForm(makeContext(), baseDeps(endpoint), {
      sessionID: "ses_child",
      formID: "big",
      answer: { q0: "x" },
    })
    expect(capped.ok).toBe(false)
    if (!capped.ok) expect(capped.error.length).toBeLessThan(340)
  })

  it("does not send the credential through HTTP_PROXY", async () => {
    let proxyHits = 0
    proxy = Bun.serve({
      port: 0,
      fetch: async () => {
        proxyHits += 1
        return new Response("proxied", { status: 200 })
      },
    })
    service = Bun.serve({
      port: 0,
      fetch: async () => new Response(null, { status: 204 }),
    })
    const previous = {
      HTTP_PROXY: process.env.HTTP_PROXY,
      http_proxy: process.env.http_proxy,
      NO_PROXY: process.env.NO_PROXY,
      no_proxy: process.env.no_proxy,
    }
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`
    process.env.http_proxy = process.env.HTTP_PROXY
    process.env.NO_PROXY = ""
    process.env.no_proxy = ""
    try {
      const result = await replyToForm(
        makeContext(),
        baseDeps({
          env: {
            OPENCODE_SERVER_URL: `http://127.0.0.1:${service.port}`,
            OPENCODE_SERVER_PASSWORD: "pw",
          },
        }),
        { sessionID: "ses_child", formID: "form_1", answer: { q0: "x" } },
      )
      expect(result).toEqual({ ok: true, via: "http" })
      expect(proxyHits).toBe(0)
    } finally {
      Object.assign(process.env, previous)
    }
  })

  it("returns an explicit error with no registration and refuses remote http/https", async () => {
    const missing = await replyToForm(makeContext(), baseDeps(), {
      sessionID: "ses_child",
      formID: "form_1",
      answer: { q0: "x" },
    })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error).toContain("form reply API not available")

    expect(
      discoverService({
        env: { OPENCODE_SERVER_URL: "https://example.com:49374", OPENCODE_SERVER_PASSWORD: "pw" },
        home: "/home/test",
        readFile: () => {
          throw new Error("missing")
        },
      }),
    ).toBeUndefined()
  })

  it("parses the structured host error tag and id", async () => {
    service = Bun.serve({
      port: 0,
      fetch: async () =>
        new Response(
          JSON.stringify({ _tag: "FormNotFoundError", id: "form_1", message: "Form not found: form_1" }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
    })
    const result = await replyToForm(
      makeContext(),
      baseDeps({
        env: { OPENCODE_SERVER_URL: `http://127.0.0.1:${service.port}`, OPENCODE_SERVER_PASSWORD: "pw" },
      }),
      { sessionID: "ses_child", formID: "form_1", answer: { q0: "x" } },
    )
    expect(result).toMatchObject({
      ok: false,
      status: 404,
      hostTag: "FormNotFoundError",
      hostID: "form_1",
    })
  })

  it("uses a dedicated agent instead of the shared global agent", async () => {
    const { createRequire } = await import("node:module")
    const http = createRequire(import.meta.url)("node:http")
    service = Bun.serve({ port: 0, fetch: async () => new Response(null, { status: 204 }) })
    const original = http.globalAgent
    let globalCalls = 0
    const fake = Object.create(original)
    fake.createConnection = (...args: unknown[]) => {
      globalCalls += 1
      return (original as { createConnection: (...a: unknown[]) => unknown }).createConnection(...args)
    }
    http.globalAgent = fake
    try {
      const result = await replyToForm(
        makeContext(),
        baseDeps({
          env: { OPENCODE_SERVER_URL: `http://127.0.0.1:${service.port}`, OPENCODE_SERVER_PASSWORD: "pw" },
        }),
        { sessionID: "ses_child", formID: "form_1", answer: { q0: "x" } },
      )
      expect(result).toEqual({ ok: true, via: "http" })
      expect(globalCalls).toBe(0)
    } finally {
      http.globalAgent = original
    }
  })

  it("fails after timeoutMs when the server never responds", async () => {
    service = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })
    const result = await replyToForm(
      makeContext(),
      baseDeps({
        timeoutMs: 30,
        env: { OPENCODE_SERVER_URL: `http://127.0.0.1:${service.port}`, OPENCODE_SERVER_PASSWORD: "pw" },
      }),
      { sessionID: "ses_child", formID: "form_1", answer: { q0: "x" } },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("timed out")
  })

  it("stops reading at the cap instead of waiting for the body to end", async () => {
    service = Bun.serve({
      port: 0,
      fetch: () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(6000))
            // Intentionally never close; a correct client stops at the cap.
          },
        })
        return new Response(stream, { status: 200 })
      },
    })
    const result = await replyToForm(
      makeContext(),
      baseDeps({
        timeoutMs: 3000,
        env: { OPENCODE_SERVER_URL: `http://127.0.0.1:${service.port}`, OPENCODE_SERVER_PASSWORD: "pw" },
      }),
      { sessionID: "ses_child", formID: "form_1", answer: { q0: "x" } },
    )
    // A status is only present when the response was received and read/capped.
    expect(result).toMatchObject({ ok: false, status: 200 })
  })

  it("aborts a drip-feed server with the total time limit", async () => {
    service = Bun.serve({
      port: 0,
      fetch: () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const timer = setInterval(() => {
              try {
                controller.enqueue(new Uint8Array([120]))
              } catch {
                clearInterval(timer)
              }
            }, 10)
          },
        })
        return new Response(stream, { status: 200 })
      },
    })
    const guard = new Promise<"guard">((resolve) => setTimeout(() => resolve("guard"), 400))
    try {
      const result = await Promise.race([
        replyToForm(
          makeContext(),
          baseDeps({
            timeoutMs: 60,
            env: {
              OPENCODE_SERVER_URL: `http://127.0.0.1:${service.port}`,
              OPENCODE_SERVER_PASSWORD: "pw",
            },
          }),
          { sessionID: "ses_child", formID: "form_1", answer: { q0: "x" } },
        ),
        guard,
      ])
      expect(result).not.toBe("guard")
      if (result !== "guard") {
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.error).toContain("timed out")
      }
    } finally {
      service.stop(true)
    }
  })
})
