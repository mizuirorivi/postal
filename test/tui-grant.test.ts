import { describe, expect, it, mock } from "bun:test"

// tui.tsx imports host UI packages that are not installed in this repository
// (they are provided by the OpenCode TUI at runtime), so stub them.
const jsxRuntime = {
  jsx: () => ({}),
  jsxs: () => ({}),
  jsxDEV: () => ({}),
  Fragment: Symbol("Fragment"),
}
mock.module("@opentui/core", () => ({ RGBA: { fromInts: () => ({}) } }))
mock.module("react/jsx-dev-runtime", () => jsxRuntime)
mock.module("react/jsx-runtime", () => jsxRuntime)
mock.module("@opentui/solid", () => ({}))
mock.module("solid-js", () => ({
  createSignal: <T,>(value: T) => [() => value, () => {}, ] as [() => T, (next: T) => void],
  createEffect: () => {},
  on: () => () => {},
}))

const { default: plugin } = await import("../tui.js")

type TuiHarness = {
  context: any
  commands: any[]
  selects: any[]
  queue: Array<string | undefined>
  toasts: Array<{ message: string; variant?: string }>
  grants: any[]
  confirm: { value: boolean | undefined }
  cleanup: () => void
}

function harness(): TuiHarness {
  const commands: any[] = []
  const selects: any[] = []
  const queue: Array<string | undefined> = []
  const toasts: Array<{ message: string; variant?: string }> = []
  const grants: any[] = []
  const confirm = { value: true as boolean | undefined }
  let index = 0

  const context: any = {
    location: { directory: "/tmp/postal-tui-test" },
    keymap: {
      layer: (factory: () => { commands: any[] }) => {
        commands.push(...factory().commands)
      },
    },
    ui: {
      slot: () => {},
      dialog: {
        select: async (input: any) => {
          selects.push(input)
          return queue[index++]
        },
        prompt: async () => undefined,
        confirm: async () => confirm.value,
        alert: async () => {},
        set: () => {},
        show: () => {},
      },
      toast: { show: (input: { message: string; variant?: string }) => toasts.push(input) },
      router: { current: () => ({ type: "session", sessionID: "ses_a" }) },
      tabs: { enabled: () => false, list: () => [], focus: () => true, close: () => true },
    },
    data: {
      session: {
        list: () => [{ id: "ses_a", title: "A" }],
        get: (id: string) => ({ id, title: id }),
        status: () => "idle",
      },
      location: { default: () => ({ directory: "/tmp/postal-tui-test" }) },
    },
    client: {
      rpc: () => ({
        connect: async () => ({ ok: true }),
        disconnect: async () => ({ ok: true }),
        status: async () => ({ ok: true, peers: [{ id: "ses_b", title: "B" }] }),
        presence: async () => ({ ok: true }),
        grant: async (input: any) => {
          grants.push(input)
          return { ok: true, peerID: input.peerID }
        },
      }),
    },
  }

  const cleanup = plugin.setup(context) as (() => void) | undefined
  return { context, commands, selects, queue, toasts, grants, confirm, cleanup: cleanup ?? (() => {}) }
}

const grantCommand = (t: TuiHarness) => t.commands.find((command) => command.id === "postal.grant")

describe("Postal: Grant TUI command", () => {
  it("registers the command in the palette", () => {
    const t = harness()
    try {
      const command = grantCommand(t)
      expect(command).toBeDefined()
      expect(command.title).toBe("Postal: Grant")
      expect(command.palette).toBe(true)
    } finally {
      t.cleanup()
    }
  })

  it("selects a peer, toggles operations, and calls the grant RPC", async () => {
    const t = harness()
    try {
      t.queue.push("ses_b", "send", "history", "__done__")
      await grantCommand(t)!.run()

      expect(t.grants).toHaveLength(1)
      expect(t.grants[0]).toEqual({ sessionID: "ses_a", peerID: "ses_b", operations: ["send", "history"] })

      const toggleTitles = t.selects[1]!.options.map((option: any) => option.title)
      expect(toggleTitles).toContain("[ ] send")
      expect(toggleTitles).toContain("Done")
      expect(t.toasts.at(-1)?.message).toContain("Granted send, history to ses_b")
    } finally {
      t.cleanup()
    }
  })

  it("toggles a selected operation back off", async () => {
    const t = harness()
    try {
      t.queue.push("ses_b", "task", "task", "__done__")
      await grantCommand(t)!.run()

      expect(t.grants).toHaveLength(0)
      expect(t.toasts.at(-1)?.message).toContain("No operations selected")
      expect(t.toasts.at(-1)?.variant).toBe("warning")
    } finally {
      t.cleanup()
    }
  })

  it("does not grant when the confirmation is declined", async () => {
    const t = harness()
    try {
      t.confirm.value = false
      t.queue.push("ses_b", "send", "__done__")
      await grantCommand(t)!.run()

      expect(t.grants).toHaveLength(0)
      expect(t.toasts).toHaveLength(0)
    } finally {
      t.cleanup()
    }
  })

  it("warns and stops when no peer is connected", async () => {
    const t = harness()
    try {
      t.context.client.rpc = () => ({
        connect: async () => ({ ok: true }),
        disconnect: async () => ({ ok: true }),
        status: async () => ({ ok: true, peers: [] }),
        presence: async () => ({ ok: true }),
        grant: async () => {
          throw new Error("grant must not be called")
        },
      })
      t.queue.push(undefined)
      await grantCommand(t)!.run()

      expect(t.grants).toHaveLength(0)
      expect(t.toasts.at(-1)?.message).toContain("No connected peers")
      expect(t.toasts.at(-1)?.variant).toBe("warning")
    } finally {
      t.cleanup()
    }
  })
})
