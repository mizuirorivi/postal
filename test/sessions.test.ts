import { describe, expect, it } from "bun:test"
import { closeSession, closeSessionCommand, createSession, newSessionCommand } from "../sessions.js"

type Toast = { title?: string; message: string; variant?: string }
type Destination = { type: string; sessionID?: string }

type Calls = {
  create: Array<Record<string, unknown>>
  remove: Array<{ sessionID: string }>
  focus: string[]
  close: Array<string | undefined>
  navigate: Destination[]
  toast: Toast[]
  disconnect: string[]
  prompt: Array<Record<string, unknown>>
  select: Array<{ options: Array<{ value: string }> }>
  confirm: Array<{ message: string }>
}

type Patch = (context: any, calls: Calls) => void

function harness(patch?: Patch) {
  const calls: Calls = {
    create: [],
    remove: [],
    focus: [],
    close: [],
    navigate: [],
    toast: [],
    disconnect: [],
    prompt: [],
    select: [],
    confirm: [],
  }

  const context: any = {
    location: { directory: "/tmp/project" },
    client: {
      session: {
        create: async (input: Record<string, unknown>) => {
          calls.create.push(input)
          return { id: "ses_new", title: input.title ?? "Postal session" }
        },
        remove: async (input: { sessionID: string }) => {
          calls.remove.push(input)
        },
      },
      rpc: (_contract: unknown) => ({
        disconnect: async (input: { sessionID: string }) => {
          calls.disconnect.push(input.sessionID)
          return { ok: true }
        },
      }),
    },
    data: {
      session: {
        get: (id: string) => ({ id, title: "Existing" }),
        list: () => [],
      },
    },
    ui: {
      toast: { show: (toast: Toast) => calls.toast.push(toast) },
      router: { navigate: (destination: Destination) => calls.navigate.push(destination) },
      tabs: {
        enabled: () => true,
        focus: (id: string) => {
          calls.focus.push(id)
          return true
        },
        close: (id?: string) => {
          calls.close.push(id)
          return true
        },
      },
      dialog: {
        prompt: async (input: Record<string, unknown>) => {
          calls.prompt.push(input)
          return "Reviewer"
        },
        select: async (input: { options: Array<{ value: string }> }) => {
          calls.select.push(input)
          return "tab"
        },
        confirm: async (input: { message: string }) => {
          calls.confirm.push(input)
          return true
        },
      },
    },
  }

  patch?.(context, calls)
  return { context, calls }
}

function lastToast(calls: Calls): Toast {
  const toast = calls.toast.at(-1)
  if (!toast) throw new Error("expected a toast")
  return toast
}

describe("createSession", () => {
  it("creates with a trimmed title and the current location, then focuses the new tab", async () => {
    const { context, calls } = harness()

    const result = await createSession(context, { title: "  Reviewer  " })

    expect(result).toEqual({ ok: true, sessionID: "ses_new", title: "Reviewer" })
    expect(calls.create).toEqual([{ title: "Reviewer", location: { directory: "/tmp/project" } }])
    expect(calls.focus).toEqual(["ses_new"])
    expect(calls.navigate).toEqual([])
    expect(lastToast(calls)).toMatchObject({ variant: "success" })
  })

  it("uses a readable default title when none is provided", async () => {
    const { context, calls } = harness()

    const result = await createSession(context, {})

    expect(result).toEqual({ ok: true, sessionID: "ses_new", title: "Postal session" })
    expect(calls.create[0]?.title).toBe("Postal session")
  })

  it("keeps the title returned by the server", async () => {
    const { context } = harness((ctx) => {
      ctx.client.session.create = async () => ({ id: "ses_server", title: "Server title" })
    })

    const result = await createSession(context, { title: "Requested" })

    expect(result).toEqual({ ok: true, sessionID: "ses_server", title: "Server title" })
  })

  it("accepts a { data } response shape", async () => {
    const { context } = harness((ctx) => {
      ctx.client.session.create = async () => ({ data: { id: "ses_wrapped", title: "Wrapped" } })
    })

    const result = await createSession(context, {})

    expect(result).toEqual({ ok: true, sessionID: "ses_wrapped", title: "Wrapped" })
  })

  it("navigates instead of focusing when tabs are disabled", async () => {
    const { context, calls } = harness((ctx) => {
      ctx.ui.tabs.enabled = () => false
    })

    await createSession(context, {})

    expect(calls.focus).toEqual([])
    expect(calls.navigate).toEqual([{ type: "session", sessionID: "ses_new" }])
  })

  it("navigates when focusing the tab reports failure", async () => {
    const { context, calls } = harness((ctx) => {
      ctx.ui.tabs.focus = () => false
    })

    await createSession(context, {})

    expect(calls.navigate).toEqual([{ type: "session", sessionID: "ses_new" }])
  })

  it("uses an explicit location over the context location", async () => {
    const { context, calls } = harness()

    await createSession(context, { location: { directory: "/tmp/other-project" } })

    expect(calls.create).toEqual([{ title: "Postal session", location: { directory: "/tmp/other-project" } }])
  })

  it("omits location when no location is available", async () => {
    const { context, calls } = harness((ctx) => {
      ctx.location = undefined
      ctx.data.location = undefined
    })

    await createSession(context, {})

    expect(calls.create).toEqual([{ title: "Postal session" }])
  })

  it("reports create failures without navigating", async () => {
    const { context, calls } = harness((ctx) => {
      ctx.client.session.create = async () => {
        throw new Error("boom")
      }
    })

    const result = await createSession(context, {})

    expect(result).toEqual({ ok: false, error: "boom" })
    expect(calls.focus).toEqual([])
    expect(calls.navigate).toEqual([])
    expect(lastToast(calls)).toMatchObject({ variant: "error", message: "New session failed: boom" })
  })

  it("reports a missing session ID", async () => {
    const { context } = harness((ctx) => {
      ctx.client.session.create = async () => ({})
    })

    const result = await createSession(context, {})

    expect(result).toEqual({ ok: false, error: "session create returned no id" })
  })

  it("reports runtimes without session creation", async () => {
    const { context } = harness((ctx) => {
      ctx.client.session.create = undefined
    })

    const result = await createSession(context, {})

    expect(result.ok).toBe(false)
    expect(result.error).toContain("not supported")
  })
})

describe("newSessionCommand", () => {
  it("asks for a name before creating", async () => {
    const { context, calls } = harness()

    const result = await newSessionCommand(context)

    expect(calls.prompt).toHaveLength(1)
    expect(calls.create[0]?.title).toBe("Reviewer")
    expect(result).toEqual({ ok: true, sessionID: "ses_new", title: "Reviewer" })
  })

  it("cancels when the name dialog is dismissed", async () => {
    const { context, calls } = harness((ctx) => {
      ctx.ui.dialog.prompt = async () => undefined
    })

    const result = await newSessionCommand(context)

    expect(result).toEqual({ ok: false, cancelled: true })
    expect(calls.create).toEqual([])
  })

  it("falls back to the default name when the field is left empty", async () => {
    const { context, calls } = harness((ctx) => {
      ctx.ui.dialog.prompt = async () => "   "
    })

    await newSessionCommand(context)

    expect(calls.create[0]?.title).toBe("Postal session")
  })

  it("skips the dialog when promptForTitle is false", async () => {
    const { context, calls } = harness()

    await newSessionCommand(context, { promptForTitle: false })

    expect(calls.prompt).toEqual([])
    expect(calls.create).toHaveLength(1)
  })

  it("forwards the location of the source session", async () => {
    const { context, calls } = harness()

    await newSessionCommand(context, { promptForTitle: false, location: { directory: "/tmp/other" } })

    expect(calls.create[0]?.location).toEqual({ directory: "/tmp/other" })
  })
})

describe("closeSession", () => {
  it("closes the current tab and returns home", async () => {
    const { context, calls } = harness()

    const result = await closeSession(context, { sessionID: "ses_a", currentSessionID: "ses_a" })

    expect(result).toEqual({ ok: true, deleted: false })
    expect(calls.close).toEqual(["ses_a"])
    expect(calls.navigate).toEqual([{ type: "home" }])
    expect(lastToast(calls)).toMatchObject({ variant: "success" })
  })

  it("closes a background tab without changing the route", async () => {
    const { context, calls } = harness()

    const result = await closeSession(context, { sessionID: "ses_a", currentSessionID: "ses_other" })

    expect(result).toEqual({ ok: true, deleted: false })
    expect(calls.close).toEqual(["ses_a"])
    expect(calls.navigate).toEqual([])
  })

  it("reports when the requested tab is not open", async () => {
    const { context, calls } = harness((ctx) => {
      ctx.ui.tabs.close = () => false
    })

    const result = await closeSession(context, { sessionID: "ses_a", currentSessionID: "ses_other" })

    expect(result.ok).toBe(false)
    expect(result.error).toContain("not open")
    expect(calls.navigate).toEqual([])
  })

  it("leaves the session view when tabs are unavailable", async () => {
    const { context, calls } = harness((ctx) => {
      ctx.ui.tabs = undefined
    })

    const result = await closeSession(context, { sessionID: "ses_a", currentSessionID: "ses_a" })

    expect(result).toEqual({ ok: true, deleted: false })
    expect(calls.navigate).toEqual([{ type: "home" }])
  })

  it("disconnects the pair, deletes the session, closes its tab, and returns home", async () => {
    const { context, calls } = harness()

    const result = await closeSession(context, {
      sessionID: "ses_a",
      currentSessionID: "ses_a",
      deleteSession: true,
    })

    expect(result).toEqual({ ok: true, deleted: true })
    expect(calls.disconnect).toEqual(["ses_a"])
    expect(calls.remove).toEqual([{ sessionID: "ses_a" }])
    expect(calls.close).toEqual(["ses_a"])
    expect(calls.navigate).toEqual([{ type: "home" }])
    expect(lastToast(calls)).toMatchObject({ variant: "success" })
  })

  it("keeps the tab and route when deletion fails", async () => {
    const { context, calls } = harness((ctx) => {
      ctx.client.session.remove = async () => {
        throw new Error("delete failed")
      }
    })

    const result = await closeSession(context, {
      sessionID: "ses_a",
      currentSessionID: "ses_a",
      deleteSession: true,
    })

    expect(result).toEqual({ ok: false, error: "delete failed" })
    expect(calls.close).toEqual([])
    expect(calls.navigate).toEqual([])
    expect(lastToast(calls)).toMatchObject({ variant: "error" })
  })

  it("deletes even when disconnecting the pair fails", async () => {
    const { context, calls } = harness((ctx) => {
      ctx.client.rpc = () => ({
        disconnect: async () => {
          throw new Error("rpc unavailable")
        },
      })
    })

    const result = await closeSession(context, {
      sessionID: "ses_a",
      currentSessionID: "ses_a",
      deleteSession: true,
    })

    expect(result).toEqual({ ok: true, deleted: true })
    expect(calls.remove).toEqual([{ sessionID: "ses_a" }])
  })

  it("deletes when no RPC client is available", async () => {
    const { context, calls } = harness((ctx) => {
      ctx.client.rpc = undefined
    })

    const result = await closeSession(context, {
      sessionID: "ses_a",
      currentSessionID: "ses_other",
      deleteSession: true,
    })

    expect(result).toEqual({ ok: true, deleted: true })
    expect(calls.remove).toEqual([{ sessionID: "ses_a" }])
    expect(calls.navigate).toEqual([])
  })

  it("reports when deletion is not supported", async () => {
    const { context } = harness((ctx) => {
      ctx.client.session.remove = undefined
    })

    const result = await closeSession(context, {
      sessionID: "ses_a",
      currentSessionID: "ses_a",
      deleteSession: true,
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain("not supported")
  })
})

describe("closeSessionCommand", () => {
  const options = { sessionID: "ses_a", currentSessionID: "ses_a" }

  it("offers tab close and permanent deletion", async () => {
    const { context, calls } = harness()

    const result = await closeSessionCommand(context, options)

    expect(calls.select).toHaveLength(1)
    expect(calls.select[0]?.options.map((option) => option.value)).toEqual(["tab", "delete"])
    expect(calls.confirm).toEqual([])
    expect(result).toEqual({ ok: true, deleted: false })
  })

  it("cancels without closing anything", async () => {
    const { context, calls } = harness((ctx) => {
      ctx.ui.dialog.select = async () => undefined
    })

    const result = await closeSessionCommand(context, options)

    expect(result).toEqual({ ok: false, cancelled: true })
    expect(calls.close).toEqual([])
    expect(calls.remove).toEqual([])
  })

  it("confirms before deleting permanently", async () => {
    const { context, calls } = harness((ctx) => {
      ctx.ui.dialog.select = async () => "delete"
      ctx.data.session.get = () => ({ id: "ses_a", title: "Target" })
    })

    const result = await closeSessionCommand(context, options)

    expect(calls.confirm).toHaveLength(1)
    expect(calls.confirm[0]?.message).toContain("Target")
    expect(result).toEqual({ ok: true, deleted: true })
    expect(calls.remove).toEqual([{ sessionID: "ses_a" }])
  })

  it("does not delete when the confirmation is declined", async () => {
    const { context, calls } = harness((ctx) => {
      ctx.ui.dialog.select = async () => "delete"
      ctx.ui.dialog.confirm = async () => false
    })

    const result = await closeSessionCommand(context, options)

    expect(result).toEqual({ ok: false, cancelled: true })
    expect(calls.remove).toEqual([])
  })

  it("reports when no session was selected", async () => {
    const { context, calls } = harness()

    const result = await closeSessionCommand(context, {})

    expect(result.ok).toBe(false)
    expect(calls.select).toEqual([])
    expect(lastToast(calls)).toMatchObject({ variant: "warning" })
  })
})
