import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { cancelForm, replyToForm, type FormsContext, type FormsDeps } from "../forms.js"

const fixtures = join(import.meta.dir, "fixtures")
const key = readFileSync(join(fixtures, "server-key.pem"), "utf8")
const cert = readFileSync(join(fixtures, "server-cert.pem"), "utf8")

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
    timeoutMs: 2000,
    env: {},
    home: "/nonexistent-postal-test-home",
    readFile: () => {
      throw new Error("missing")
    },
    ...overrides,
  }
}

let service: ReturnType<typeof Bun.serve> | undefined

beforeAll(() => {
  service = Bun.serve({
    port: 0,
    tls: { key, cert },
    fetch: async () => new Response(null, { status: 204 }),
  })
})

afterAll(() => {
  service?.stop(true)
})

describe("HTTPS form transport", () => {
  it("replies over HTTPS when a CA is provided", async () => {
    const result = await replyToForm(
      makeContext(),
      baseDeps({
        ca: cert,
        env: {
          OPENCODE_SERVER_URL: `https://127.0.0.1:${service!.port}`,
          OPENCODE_SERVER_PASSWORD: "pw",
        },
      }),
      { sessionID: "ses_child", formID: "frm_1", answer: { q0: "x" } },
    )
    expect(result).toEqual({ ok: true, via: "http" })
  })

  it("cancels over HTTPS when a CA is provided", async () => {
    const result = await cancelForm(
      makeContext(),
      baseDeps({
        ca: cert,
        env: {
          OPENCODE_SERVER_URL: `https://127.0.0.1:${service!.port}`,
          OPENCODE_SERVER_PASSWORD: "pw",
        },
      }),
      { sessionID: "ses_child", formID: "frm_1" },
    )
    expect(result).toEqual({ ok: true, via: "http" })
  })

  it("rejects a self-signed HTTPS host without the CA", async () => {
    const result = await replyToForm(
      makeContext(),
      baseDeps({
        env: {
          OPENCODE_SERVER_URL: `https://127.0.0.1:${service!.port}`,
          OPENCODE_SERVER_PASSWORD: "pw",
        },
      }),
      { sessionID: "ses_child", formID: "frm_1", answer: { q0: "x" } },
    )
    expect(result.ok).toBe(false)
  })
})
