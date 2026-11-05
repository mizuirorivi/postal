import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../index.js"

type Session = { id: string; title: string }
type Prompt = {
  sessionID: string
  text: string
  delivery?: string
  resume?: boolean
  metadata?: Record<string, any>
}

process.env.POSTAL_STATE_PATH = join(mkdtempSync(join(tmpdir(), "postal-state-")), "state.db")

const flush = () => new Promise((resolve) => setTimeout(resolve, 5))

const outboxKey = (from: string, id: string) =>
  `outbox/${encodeURIComponent(from)}/${encodeURIComponent(id)}`
const receiptKey = (from: string, to: string, id: string) =>
  `receipt/${encodeURIComponent(from)}/${encodeURIComponent(to)}/${encodeURIComponent(id)}`

function harness() {
  const storage = new Map<string, unknown>()
  const prompts: Prompt[] = []
  const sessions = new Map<string, Session>()
  const notes = new Map<string, string>()
  const hooks: Record<string, (event: any) => void | Promise<void>> = {}
  const rpc: Record<string, (input: any) => Promise<any>> = {}
  const tools: Record<string, { execute: (input: any, context: any) => Promise<{ content: string }> }> = {}
  const creates: any[] = []
  const interrupts: string[] = []
  const removes: string[] = []
  let spawnCount = 0

  const addSession = (id: string, title: string) => sessions.set(id, { id, title })

  const context: any = {
    location: { directory: "/tmp/postal-test" },
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
      create: async (input: any) => {
        creates.push(input)
        const id = `ses_spawn_${++spawnCount}`
        const session = { id, title: input.title ?? "(untitled)" }
        sessions.set(id, session)
        return session
      },
      interrupt: async ({ sessionID }: { sessionID: string }) => {
        interrupts.push(sessionID)
      },
      remove: async ({ sessionID }: { sessionID: string }) => {
        removes.push(sessionID)
        sessions.delete(sessionID)
      },
      prompt: async (input: Prompt) => {
        prompts.push(input)
        return {}
      },
      instructions: {
        entry: {
          put: async (input: { sessionID: string; value: string }) => {
            notes.set(input.sessionID, input.value)
          },
          remove: async (input: { sessionID: string }) => {
            notes.delete(input.sessionID)
          },
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
  }

  return { context, storage, prompts, sessions, notes, hooks, rpc, tools, creates, interrupts, removes, addSession }
}

async function boot() {
  const test = harness()
  await plugin.setup(test.context)
  return test
}

describe("multiple postal peers", () => {
  it("keeps every connected peer on both sides", async () => {
    const { addSession, rpc } = await boot()
    addSession("ses_a", "A")
    addSession("ses_b", "B")
    addSession("ses_c", "C")

    expect(await rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })).toMatchObject({ ok: true })
    expect(await rpc.connect({ sessionID: "ses_a", peerID: "ses_c" })).toMatchObject({ ok: true })

    const statusA = await rpc.status({ sessionID: "ses_a" })
    expect(statusA.ok).toBe(true)
    expect(statusA.peers.map((peer: Session) => peer.id)).toEqual(["ses_b", "ses_c"])

    expect((await rpc.status({ sessionID: "ses_b" })).peers.map((peer: Session) => peer.id)).toEqual(["ses_a"])
    expect((await rpc.status({ sessionID: "ses_c" })).peers.map((peer: Session) => peer.id)).toEqual(["ses_a"])
  })

  it("disconnects one peer without touching the others", async () => {
    const { addSession, rpc } = await boot()
    addSession("ses_a", "A")
    addSession("ses_b", "B")
    addSession("ses_c", "C")
    await rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    await rpc.connect({ sessionID: "ses_a", peerID: "ses_c" })

    const result = await rpc.disconnect({ sessionID: "ses_a", peerID: "ses_b" })
    expect(result.ok).toBe(true)

    expect((await rpc.status({ sessionID: "ses_a" })).peers.map((peer: Session) => peer.id)).toEqual(["ses_c"])
    expect((await rpc.status({ sessionID: "ses_b" })).peers).toEqual([])
  })

  it("disconnects every peer when peerID is omitted", async () => {
    const { addSession, rpc } = await boot()
    addSession("ses_a", "A")
    addSession("ses_b", "B")
    addSession("ses_c", "C")
    await rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    await rpc.connect({ sessionID: "ses_a", peerID: "ses_c" })

    expect((await rpc.disconnect({ sessionID: "ses_a" })).ok).toBe(true)

    expect((await rpc.status({ sessionID: "ses_a" })).peers).toEqual([])
    expect((await rpc.status({ sessionID: "ses_b" })).peers).toEqual([])
    expect((await rpc.status({ sessionID: "ses_c" })).peers).toEqual([])
  })

  it("migrates the old single-peer record", async () => {
    const { addSession, storage, rpc } = await boot()
    addSession("ses_a", "A")
    addSession("ses_b", "B")
    storage.set("peer/ses_a", { id: "ses_b", title: "B" })
    storage.set("peer/ses_b", { id: "ses_a", title: "A" })

    const status = await rpc.status({ sessionID: "ses_a" })
    expect(status.peers.map((peer: Session) => peer.id)).toEqual(["ses_b"])
    expect(storage.has("peers/ses_a")).toBe(true)
    expect(storage.has("peer/ses_a")).toBe(false)
  })

  it("lists connected peers for agents", async () => {
    const { addSession, rpc, tools } = await boot()
    addSession("ses_a", "A")
    addSession("ses_b", "B")
    await rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })

    const result = await tools.peers.execute({}, { sessionID: "ses_a" })
    expect(result.content).toContain("ses_b")
    expect(result.content).toContain("B")
  })
})

describe("asynchronous delivery", () => {
  it("forwards mentions immediately without queuing a reply", async () => {
    const { addSession, rpc, hooks, prompts } = await boot()
    addSession("ses_a", "A")
    addSession("ses_b", "B")
    await rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })

    hooks.prompt({ sessionID: "ses_a", prompt: { text: "@ses_b hello there" }, metadata: {} })
    await flush()

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({ sessionID: "ses_b", delivery: "steer" })
    expect(prompts[0]?.metadata?.postal?.relay).toBe(true)
    expect(prompts[0]?.text).toContain("hello there")
    expect(prompts[0]?.text).toContain("to: ses_a")
    expect(prompts.some((prompt) => prompt.sessionID === "ses_a")).toBe(false)
    expect(prompts.some((prompt) => prompt.delivery === "queue" || prompt.resume === false)).toBe(false)
  })

  it("does not queue a note when instruction entries are unavailable", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    test.context.session.instructions.entry.put = async () => {
      throw new Error("instructions unavailable")
    }

    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })

    expect(test.prompts).toEqual([])
  })

  it("does not queue a delivery-failure notice", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    test.context.session.prompt = async (input: Prompt) => {
      test.prompts.push(input)
      throw new Error("target offline")
    }

    const result = await test.tools.send.execute({ to: "ses_b", text: "hello" }, { sessionID: "ses_a" })

    expect(result.content).toContain("delivery failed")
    expect(test.prompts).toHaveLength(1)
    expect(test.prompts[0]?.sessionID).toBe("ses_b")
    expect(test.prompts.some((prompt) => prompt.sessionID === "ses_a")).toBe(false)
  })
})

describe("postal_send with multiple peers", () => {
  it("requires 'to' when more than one peer is connected", async () => {
    const { addSession, rpc, tools, prompts } = await boot()
    addSession("ses_a", "A")
    addSession("ses_b", "B")
    addSession("ses_c", "C")
    await rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    await rpc.connect({ sessionID: "ses_a", peerID: "ses_c" })

    const result = await tools.send.execute({ text: "hello" }, { sessionID: "ses_a" })

    expect(result.content).toContain("2 peers")
    expect(result.content).toContain("ses_b")
    expect(result.content).toContain("ses_c")
    expect(prompts).toEqual([])
  })

  it("uses the only connected peer when 'to' is omitted", async () => {
    const { addSession, rpc, tools, prompts } = await boot()
    addSession("ses_a", "A")
    addSession("ses_b", "B")
    await rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })

    const result = await tools.send.execute({ text: "hello" }, { sessionID: "ses_a" })

    expect(result.content).toContain("delivered to ses_b")
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({ sessionID: "ses_b", delivery: "steer" })
  })
})

describe("postal_spawn", () => {
  it("creates a worker with model, agent, directory, and pairs it by default", async () => {
    const { addSession, tools, rpc, creates, sessions } = await boot()
    addSession("ses_a", "A")

    const result = await tools.spawn.execute(
      {
        title: "Worker",
        model: "opencode-go/deepseek-v4.1-flash#max",
        agent: "build",
        directory: "/tmp/worker",
      },
      { sessionID: "ses_a" },
    )

    expect(result.content).toContain("spawned")
    expect(result.content).toContain("and paired")
    expect(creates).toHaveLength(1)
    expect(creates[0]).toMatchObject({
      title: "Worker",
      agent: "build",
      model: {
        providerID: "opencode-go",
        id: "deepseek-v4.1-flash",
        variant: "max",
      },
      location: { directory: "/tmp/worker" },
    })
    const spawned = [...sessions.values()].find((session) => session.title === "Worker")
    expect(spawned).toBeDefined()
    expect((await rpc.status({ sessionID: "ses_a" })).peers.map((peer: Session) => peer.id)).toContain(spawned?.id)
    expect((await rpc.status({ sessionID: spawned!.id })).peers.map((peer: Session) => peer.id)).toContain("ses_a")
  })

  it("can spawn without pairing", async () => {
    const { addSession, tools, rpc } = await boot()
    addSession("ses_a", "A")

    const result = await tools.spawn.execute({ title: "Lone", autoPair: false }, { sessionID: "ses_a" })

    expect(result.content).toContain("spawned")
    expect(result.content).not.toContain("paired")
    expect((await rpc.status({ sessionID: "ses_a" })).peers).toEqual([])
  })

  it("uses the caller's directory when none is provided", async () => {
    const { addSession, tools, creates } = await boot()
    addSession("ses_a", "A")

    await tools.spawn.execute({ title: "Here", autoPair: false }, { sessionID: "ses_a" })

    expect(creates[0]?.location).toEqual({ directory: "/tmp/postal-test" })
  })

  it("rejects malformed model references without creating a session", async () => {
    const { addSession, tools, creates } = await boot()
    addSession("ses_a", "A")

    const result = await tools.spawn.execute({ model: "no-slash" }, { sessionID: "ses_a" })

    expect(result.content).toContain("provider/model")
    expect(creates).toEqual([])
  })

  it("reports session-creation failures", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.context.session.create = async () => {
      throw new Error("create unavailable")
    }

    const result = await test.tools.spawn.execute({ title: "Broken" }, { sessionID: "ses_a" })

    expect(result.content).toContain("spawn failed")
    expect(result.content).toContain("create unavailable")
  })
})

describe("structured postal envelope", () => {
  it("renders kind, task, artifacts, commands, and verification", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    await test.tools.spawn.execute({ title: "B" }, { sessionID: "ses_a" })
    const b = [...test.sessions.values()].find((session) => session.title === "B")!
    const { tools, prompts } = test

    const dir = "/tmp/postal-test/postal-envelope-test"
    const path = join(dir, "artifact.txt")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, "evidence\n")
    const sha256 = createHash("sha256").update("evidence\n").digest("hex")

    try {
      const result = await tools.send.execute(
        {
          to: b.id,
          text: "Phase 1 complete",
          kind: "task",
          task_id: "T1",
          reply_to: "T0",
          msg_id: "msg_envelope_test",
          artifacts: [{ path, sha256 }],
          commands: [{ cmd: "npm test", exit: 0 }],
        },
        { sessionID: "ses_a" },
      )

      expect(result.content).toContain("msg_envelope_test")
      const letter = prompts[0]?.text ?? ""
      expect(letter).toContain("[msg: msg_envelope_test]")
      expect(letter).toContain("[kind: task]")
      expect(letter).toContain("task_id: T1")
      expect(letter).toContain("reply_to: T0")
      expect(letter).toContain("artifacts:")
      expect(letter).toContain("commands:")
      expect(letter).toContain("npm test")
      expect(letter).toContain("verification:")
      expect(letter).toContain("ok")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not deliver the same msg_id twice", async () => {
    const { addSession, rpc, tools, prompts } = await boot()
    addSession("ses_a", "A")
    addSession("ses_b", "B")
    await rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })

    const first = await tools.send.execute({ to: "ses_b", text: "one", msg_id: "msg_dup" }, { sessionID: "ses_a" })
    const second = await tools.send.execute({ to: "ses_b", text: "two", msg_id: "msg_dup" }, { sessionID: "ses_a" })

    expect(first.content).toContain("delivered")
    expect(second.content).toContain("duplicate")
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.text).toContain("one")
  })

  it("reports a missing artifact in the verification section", async () => {
    const { addSession, rpc, tools, prompts } = await boot()
    addSession("ses_a", "A")
    addSession("ses_b", "B")
    await rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })

    await tools.send.execute(
      {
        to: "ses_b",
        text: "verify this",
        kind: "verify",
        artifacts: [{ path: "/tmp/opencode/postal-envelope-test/does-not-exist.txt" }],
      },
      { sessionID: "ses_a" },
    )

    expect(prompts[0]?.text).toContain("verification:")
    expect(prompts[0]?.text).toContain("missing")
  })
})

describe("postal_status and postal_log", () => {
  it("reports remaining rally budget and last letter time", async () => {
    const { addSession, rpc, tools } = await boot()
    addSession("ses_a", "A")
    addSession("ses_b", "B")
    await rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })

    const before = await tools.status.execute({}, { sessionID: "ses_a" })
    expect(before.content).toContain("ses_b")
    expect(before.content).toContain("30/30")

    await tools.send.execute({ to: "ses_b", text: "hello" }, { sessionID: "ses_a" })

    const after = await tools.status.execute({}, { sessionID: "ses_a" })
    expect(after.content).toContain("29/30")
    expect(after.content).toMatch(/ses_b\tB\t29\/30\t\d{4}-/)
  })

  it("returns only postal messages from the session log", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.context.session.context = async () => [
      { id: "m1", info: { id: "m1", role: "user" }, text: "[postal] from ses_b hello" },
      { id: "m2", info: { id: "m2", role: "assistant" }, text: "ordinary reply" },
    ]

    const result = await test.tools.log.execute({}, { sessionID: "ses_a" })

    expect(result.content).toContain("m1")
    expect(result.content).toContain("[postal] from ses_b hello")
    expect(result.content).not.toContain("ordinary reply")
  })
})

describe("persistent outbox", () => {
  it("schedules a retry and exposes it in postal_inbox", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    test.context.session.prompt = async (input: Prompt) => {
      test.prompts.push(input)
      throw new Error("target offline")
    }

    const result = await test.tools.send.execute(
      { to: "ses_b", text: "retry me", msg_id: "msg_retry" },
      { sessionID: "ses_a" },
    )
    expect(result.content).toContain("retry")
    expect(result.content).toContain("msg_retry")

    const inbox = await test.tools.inbox.execute({}, { sessionID: "ses_a" })
    expect(inbox.content).toContain("msg_retry")
    expect(inbox.content).toContain("pending")
    expect(inbox.content).toContain("target offline")

    test.context.session.prompt = async (input: Prompt) => {
      test.prompts.push(input)
      return {}
    }
    const resent = await test.tools.resend.execute({ msg_id: "msg_retry" }, { sessionID: "ses_a" })
    expect(resent.content).toContain("resent")

    const after = await test.tools.inbox.execute({}, { sessionID: "ses_a" })
    expect(after.content).toContain("delivered")
  })

  it("marks an outbox letter acked when a reply references it", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })

    await test.tools.send.execute(
      { to: "ses_b", text: "please ack", msg_id: "msg_ack" },
      { sessionID: "ses_a" },
    )
    await test.tools.send.execute(
      { to: "ses_a", text: "ack", reply_to: "msg_ack" },
      { sessionID: "ses_b" },
    )
    const reply = test.prompts.at(-1)!
    const event = {
      sessionID: "ses_a",
      prompt: { text: reply.text },
      metadata: structuredClone(reply.metadata),
    }
    await test.hooks.prompt(event)
    await flush()
    expect(event.prompt.text).toBe(reply.text)

    const inbox = await test.tools.inbox.execute({}, { sessionID: "ses_a" })
    expect(inbox.content).toContain("msg_ack")
    expect(inbox.content).toContain("acked")
  })

  it("queues after the rally window when queueOnLimit is enabled", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    test.context.options = { maxRally: 1 }
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })

    const first = await test.tools.send.execute(
      { to: "ses_b", text: "first", msg_id: "msg_first" },
      { sessionID: "ses_a" },
    )
    expect(first.content).toContain("delivered")

    const second = await test.tools.send.execute(
      { to: "ses_b", text: "second", msg_id: "msg_second", queueOnLimit: true },
      { sessionID: "ses_a" },
    )
    expect(second.content).toContain("queued")
    expect(test.prompts).toHaveLength(1)

    const inbox = await test.tools.inbox.execute({}, { sessionID: "ses_a" })
    expect(inbox.content).toContain("msg_second")
    expect(inbox.content).toContain("pending")
  })
})

describe("claims and lifecycle", () => {
  it("enforces advisory claims and releases only for the owner", async () => {
    const { addSession, tools } = await boot()
    addSession("ses_a", "A")
    addSession("ses_b", "B")

    const first = await tools.claim.execute({ scope: "src/foo.ts", ttl: 60 }, { sessionID: "ses_a" })
    expect(first.content).toContain("claimed")

    const busy = await tools.claim.execute({ scope: "src/foo.ts", ttl: 60 }, { sessionID: "ses_b" })
    expect(busy.content).toContain("busy")

    const wrong = await tools.release.execute({ scope: "src/foo.ts" }, { sessionID: "ses_b" })
    expect(wrong.content).toContain("owned by")

    const released = await tools.release.execute({ scope: "src/foo.ts" }, { sessionID: "ses_a" })
    expect(released.content).toContain("released")

    const second = await tools.claim.execute({ scope: "src/foo.ts", ttl: 60 }, { sessionID: "ses_b" })
    expect(second.content).toContain("claimed")
  })

  it("interrupts and closes a spawned child after disconnecting its peers", async () => {
    const test = await boot()
    // This test covers grant authorization, not the M3 approval policy.
    test.context.options.enforceApprovals = false
    const { addSession, rpc, tools, interrupts, removes, sessions } = test
    addSession("ses_a", "A")
    const spawned = await tools.spawn.execute({ title: "B" }, { sessionID: "ses_a" })
    expect(spawned.content).toContain("spawned")
    const child = [...sessions.values()].find((session) => session.title === "B")
    expect(child).toBeDefined()

    const interrupted = await tools.interrupt.execute({ sessionID: child!.id }, { sessionID: "ses_a" })
    expect(interrupted.content).toContain("interrupted")
    expect(interrupts).toContain(child!.id)

    const closed = await tools.close.execute({ sessionID: child!.id }, { sessionID: "ses_a" })
    expect(closed.content).toContain("closed")
    expect(removes).toContain(child!.id)
    expect((await rpc.status({ sessionID: "ses_a" })).peers).toEqual([])
  })

  it("marks a manual root session as orphaned in status", async () => {
    const { addSession, tools } = await boot()
    addSession("ses_a", "A")

    const status = await tools.status.execute({}, { sessionID: "ses_a" })

    expect(status.content).toContain("SESSION_PARENT\t-")
    expect(status.content).toContain("SESSION_ORPHAN\tyes")
  })

  it("refuses to close the calling session", async () => {
    const { addSession, tools } = await boot()
    addSession("ses_a", "A")

    const result = await tools.close.execute({ sessionID: "ses_a" }, { sessionID: "ses_a" })

    expect(result.content).toContain("cannot close")
  })
})

describe("postal_broadcast", () => {
  it("delivers to every peer with per-peer outbox entries", async () => {
    const { addSession, rpc, tools, prompts } = await boot()
    addSession("ses_a", "A")
    addSession("ses_b", "B")
    addSession("ses_c", "C")
    await rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    await rpc.connect({ sessionID: "ses_a", peerID: "ses_c" })

    const result = await tools.broadcast.execute({ text: "all hands", msg_id: "msg_cast" }, { sessionID: "ses_a" })

    expect(result.content).toContain("ses_b")
    expect(result.content).toContain("ses_c")
    expect(prompts).toHaveLength(2)
    expect(prompts.every((prompt) => prompt.delivery === "steer")).toBe(true)

    const inbox = await tools.inbox.execute({}, { sessionID: "ses_a" })
    expect(inbox.content).toContain("msg_cast_ses_b")
    expect(inbox.content).toContain("msg_cast_ses_c")
  })
})

describe("TUI presence bridge", () => {
  it("merges busy/idle and pending metadata into status and inbox", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })

    await test.rpc.presence({
      sessions: [
        {
          id: "ses_b",
          title: "B",
          state: "running",
          pending: [{ id: "inbox_1", type: "user", source: "ses_a" }],
        },
      ],
    })

    const status = await test.tools.status.execute({}, { sessionID: "ses_a" })
    expect(status.content).toContain("STATE")
    expect(status.content).toContain("running")
    expect(status.content).toContain("INBOX_COUNT")
    expect(status.content).toContain("\t1\t")

    const inbox = await test.tools.inbox.execute({}, { sessionID: "ses_a" })
    expect(inbox.content).toContain("--- peer inbox ---")
    expect(inbox.content).toContain("inbox_1")
    expect(inbox.content).toContain("user")
    expect(inbox.content).toContain("ses_a")
  })

  it("expires stale presence reports", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    await test.rpc.presence({
      sessions: [{ id: "ses_b", title: "B", state: "running", pending: [] }],
    })
    const record = test.storage.get("presence/ses_b") as any
    record.reportedAt = Date.now() - 60_000
    test.storage.set("presence/ses_b", record)

    const status = await test.tools.status.execute({}, { sessionID: "ses_a" })
    expect(status.content).toContain("unknown")
    expect(status.content).not.toContain("\trunning\t")
  })
})

describe("commander allowlist", () => {
  it("denies lifecycle operations from a non-parent", async () => {
    const { addSession, tools, interrupts } = await boot()
    addSession("ses_a", "A")
    addSession("ses_b", "B")

    const closed = await tools.close.execute({ sessionID: "ses_b" }, { sessionID: "ses_a" })
    expect(closed.content).toContain("not authorized")

    const interrupted = await tools.interrupt.execute({ sessionID: "ses_b" }, { sessionID: "ses_a" })
    expect(interrupted.content).toContain("not authorized")
    expect(interrupts).toEqual([])
  })

  it("allows only the direct parent by default", async () => {
    const test = await boot()
    test.context.options.enforceApprovals = false
    const { addSession, tools, sessions } = test
    addSession("ses_a", "A")
    await tools.spawn.execute({ title: "B" }, { sessionID: "ses_a" })
    const b = [...sessions.values()].find((session) => session.title === "B")!
    await tools.spawn.execute({ title: "C" }, { sessionID: b.id })
    const c = [...sessions.values()].find((session) => session.title === "C")!

    const byAncestor = await tools.close.execute({ sessionID: c.id }, { sessionID: "ses_a" })
    expect(byAncestor.content).toContain("not authorized")

    const byParent = await tools.close.execute({ sessionID: c.id }, { sessionID: b.id })
    expect(byParent.content).toContain("closed")
  })

  it("can allow ancestor commands explicitly", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    await test.tools.spawn.execute({ title: "B" }, { sessionID: "ses_a" })
    const b = [...test.sessions.values()].find((session) => session.title === "B")!
    await test.tools.spawn.execute({ title: "C" }, { sessionID: b.id })
    const c = [...test.sessions.values()].find((session) => session.title === "C")!
    test.context.options = { allowAncestorCommands: true, enforceApprovals: false }

    const byAncestor = await test.tools.close.execute({ sessionID: c.id }, { sessionID: "ses_a" })
    expect(byAncestor.content).toContain("closed")
  })

  it("reparents children to the grandparent when a parent is closed", async () => {
    const test = await boot()
    test.context.options.enforceApprovals = false
    test.addSession("ses_a", "A")
    await test.tools.spawn.execute({ title: "B" }, { sessionID: "ses_a" })
    const b = [...test.sessions.values()].find((session) => session.title === "B")!
    await test.tools.spawn.execute({ title: "C" }, { sessionID: b.id })
    const c = [...test.sessions.values()].find((session) => session.title === "C")!

    const closed = await test.tools.close.execute({ sessionID: b.id }, { sessionID: "ses_a" })
    expect(closed.content).toContain("closed")

    const status = await test.tools.status.execute({}, { sessionID: c.id })
    expect(status.content).toContain(`SESSION_PARENT\tses_a`)

    const notification = test.prompts.find((prompt) => prompt.metadata?.postal?.kind === "system")
    expect(notification).toBeDefined()
    expect(notification?.sessionID).toBe("ses_a")
    expect(notification?.text).toContain(c.id)

    const interrupted = await test.tools.interrupt.execute({ sessionID: c.id }, { sessionID: "ses_a" })
    expect(interrupted.content).toContain("interrupted")
  })
})

describe("orphanPolicy", () => {
  it("detaches children: no parent and no lifecycle authority", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    await test.tools.spawn.execute({ title: "B" }, { sessionID: "ses_a" })
    const b = [...test.sessions.values()].find((session) => session.title === "B")!
    await test.tools.spawn.execute({ title: "C" }, { sessionID: b.id })
    const c = [...test.sessions.values()].find((session) => session.title === "C")!
    test.context.options = { orphanPolicy: "detach", enforceApprovals: false }

    await test.tools.close.execute({ sessionID: b.id }, { sessionID: "ses_a" })

    const status = await test.tools.status.execute({}, { sessionID: c.id })
    expect(status.content).toContain("SESSION_PARENT\t-")
    expect(status.content).toContain("SESSION_ORPHAN\tyes")
    const denied = await test.tools.interrupt.execute({ sessionID: c.id }, { sessionID: "ses_a" })
    expect(denied.content).toContain("not authorized")
    expect(test.prompts.some((prompt) => prompt.metadata?.postal?.kind === "system")).toBe(false)
  })

  it("terminates descendants: stop and delete the subtree", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    await test.tools.spawn.execute({ title: "B" }, { sessionID: "ses_a" })
    const b = [...test.sessions.values()].find((session) => session.title === "B")!
    await test.tools.spawn.execute({ title: "C" }, { sessionID: b.id })
    const c = [...test.sessions.values()].find((session) => session.title === "C")!
    test.context.options = { orphanPolicy: "terminate", enforceApprovals: false }

    await test.tools.close.execute({ sessionID: b.id }, { sessionID: "ses_a" })

    expect(test.removes).toContain(b.id)
    expect(test.removes).toContain(c.id)
    expect(test.sessions.has(c.id)).toBe(false)
    expect(test.prompts.some((prompt) => prompt.metadata?.postal?.kind === "system")).toBe(false)
  })
})

describe("HMAC Phase 1", () => {
  it("accepts a valid signature and rejects tampering", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    await test.tools.send.execute({ to: "ses_b", text: "signed body", msg_id: "msg_signed" }, { sessionID: "ses_a" })
    const sent = test.prompts.at(-1)!

    const valid = {
      sessionID: "ses_b",
      prompt: { text: sent.text },
      metadata: structuredClone(sent.metadata),
    }
    await test.hooks.prompt(valid)
    expect(valid.prompt.text).toBe(sent.text)
    expect((valid.metadata as any).postal.reason).toBeUndefined()

    const tampered = {
      sessionID: "ses_b",
      prompt: { text: `${sent.text}\ntampered` },
      metadata: structuredClone(sent.metadata),
    }
    await test.hooks.prompt(tampered)
    expect(tampered.prompt.text).toBe("")
    expect((tampered.metadata as any).postal.reason).toBe("invalid_signature")
  })

  it("rejects relay messages without a signature", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })

    const event = {
      sessionID: "ses_b",
      prompt: { text: "[postal] unsigned" },
      metadata: { postal: { relay: true, from: "ses_a" } },
    }
    await test.hooks.prompt(event)

    expect(event.prompt.text).toBe("")
    expect((event.metadata as any).postal.reason).toBe("missing_signature")
  })

  it("allows task letters only from the parent or an ancestor", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_c", "C")
    await test.tools.spawn.execute({ title: "B" }, { sessionID: "ses_a" })
    const b = [...test.sessions.values()].find((session) => session.title === "B")!

    await test.tools.send.execute(
      { to: b.id, text: "task from parent", kind: "task" },
      { sessionID: "ses_a" },
    )
    const fromParent = test.prompts.at(-1)!
    const parentEvent = {
      sessionID: b.id,
      prompt: { text: fromParent.text },
      metadata: structuredClone(fromParent.metadata),
    }
    await test.hooks.prompt(parentEvent)
    expect(parentEvent.prompt.text).toBe(fromParent.text)
    expect((parentEvent.metadata as any).postal.reason).toBeUndefined()

    await test.rpc.connect({ sessionID: "ses_c", peerID: b.id })
    const denied = await test.tools.send.execute(
      { to: b.id, text: "task from non-parent", kind: "task" },
      { sessionID: "ses_c" },
    )
    expect(denied.content).toContain("task is not granted")
    expect(test.prompts).toHaveLength(1)
  })

  it("rotates keys and keeps the old key valid for the grace period", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    await test.tools.send.execute({ to: "ses_b", text: "old key", msg_id: "msg_old" }, { sessionID: "ses_a" })
    const oldLetter = test.prompts.at(-1)!

    const rekeyed = await test.tools.rekey.execute({ peerID: "ses_b" }, { sessionID: "ses_a" })
    expect(rekeyed.content).toContain("new keyID")
    const hmacKey = [...test.storage.keys()].find((key) => key.startsWith("hmac/"))
    expect(hmacKey).toBeDefined()
    const record = test.storage.get(hmacKey!) as any
    expect(record.previous).toHaveLength(1)
    expect(record.previous[0].validUntil).toBeGreaterThan(Date.now())

    const oldEvent = {
      sessionID: "ses_b",
      prompt: { text: oldLetter.text },
      metadata: structuredClone(oldLetter.metadata),
    }
    await test.hooks.prompt(oldEvent)
    expect(oldEvent.prompt.text).toBe(oldLetter.text)

    await test.tools.send.execute({ to: "ses_b", text: "new key", msg_id: "msg_new" }, { sessionID: "ses_a" })
    const newLetter = test.prompts.at(-1)!
    const newEvent = {
      sessionID: "ses_b",
      prompt: { text: newLetter.text },
      metadata: structuredClone(newLetter.metadata),
    }
    await test.hooks.prompt(newEvent)
    expect(newEvent.prompt.text).toBe(newLetter.text)
    expect((newEvent.metadata as any).postal.reason).toBeUndefined()
  })
})

describe("watchdog and outbox cleanup", () => {
  it("nudges an idle worker with an unacked task", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    await test.tools.spawn.execute({ title: "B" }, { sessionID: "ses_a" })
    const b = [...test.sessions.values()].find((session) => session.title === "B")!
    await test.rpc.presence({ sessions: [{ id: b.id, title: "B", state: "idle", pending: [] }] })
    await test.tools.send.execute(
      { to: b.id, text: "do the task", kind: "task", task_id: "T1", msg_id: "msg_task" },
      { sessionID: "ses_a" },
    )

    const result = await test.tools.watchdog.execute({ afterSeconds: 0 }, { sessionID: "ses_a" })

    expect(result.content).toContain("msg_task")
    expect(result.content).toContain("NUDGED\tmsg_task")
    const nudge = test.prompts.at(-1)!
    expect(nudge.sessionID).toBe(b.id)
    expect(nudge.metadata?.postal?.kind).toBe("system")
    expect(nudge.metadata?.postal?.replyTo).toBe("msg_task")
    expect(nudge.text).toContain("Watchdog")
    const record = test.storage.get(outboxKey("ses_a", "msg_task")) as any
    expect(record.nudges).toBe(1)
  })

  it("does not nudge a running worker", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    await test.tools.spawn.execute({ title: "B" }, { sessionID: "ses_a" })
    const b = [...test.sessions.values()].find((session) => session.title === "B")!
    await test.rpc.presence({ sessions: [{ id: b.id, title: "B", state: "running", pending: [] }] })
    await test.tools.send.execute(
      { to: b.id, text: "do the task", kind: "task", task_id: "T1", msg_id: "msg_task_running" },
      { sessionID: "ses_a" },
    )

    const result = await test.tools.watchdog.execute({ afterSeconds: 0 }, { sessionID: "ses_a" })

    expect(result.content).toContain("NUDGED\t-")
    expect(test.prompts).toHaveLength(1)
  })

  it("cleans expired outbox records only when dryRun is false", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    await test.tools.send.execute({ to: "ses_b", text: "old letter", msg_id: "msg_old_outbox" }, { sessionID: "ses_a" })
    const record = test.storage.get(outboxKey("ses_a", "msg_old_outbox")) as any
    record.createdAt = Date.now() - 8 * 24 * 60 * 60 * 1000
    test.storage.set(outboxKey("ses_a", "msg_old_outbox"), record)

    const dry = await test.tools.cleanup.execute({ dryRun: true }, { sessionID: "ses_a" })
    expect(dry.content).toContain("CLEANUP_DRY_RUN")
    expect(dry.content).toContain("COUNT\t1")
    expect(test.storage.has(outboxKey("ses_a", "msg_old_outbox"))).toBe(true)

    const removed = await test.tools.cleanup.execute({ dryRun: false }, { sessionID: "ses_a" })
    expect(removed.content).toContain("CLEANUP_REMOVED")
    expect(removed.content).toContain("COUNT\t1")
    expect(test.storage.has(outboxKey("ses_a", "msg_old_outbox"))).toBe(false)
    expect((await test.tools.inbox.execute({}, { sessionID: "ses_a" })).content).not.toContain("msg_old_outbox")
  })
})

describe("artifact containment", () => {
  it("confines verification to regular files inside the project root", async () => {
    const test = await boot()
    const root = mkdtempSync(join(tmpdir(), "postal-artifacts-"))
    test.context.location.directory = root
    const outsideName = `postal-outside-${Date.now()}.txt`
    const outside = join(root, "..", outsideName)
    const inside = join(root, "inside.txt")
    writeFileSync(inside, "inside")
    writeFileSync(outside, "outside")
    symlinkSync("/etc/hostname", join(root, "escape.txt"))
    writeFileSync(join(root, "big.bin"), Buffer.alloc(1024 * 1024 + 1))
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })

    const sha = createHash("sha256").update("inside").digest("hex")
    const hostHash = createHash("sha256").update(readFileSync("/etc/hostname")).digest("hex")
    await test.tools.send.execute(
      {
        to: "ses_b",
        text: "artifact probe",
        msg_id: "msg_artifacts",
        artifacts: [
          { path: "inside.txt", sha256: sha },
          { path: `../${outsideName}` },
          { path: "/etc/hostname" },
          { path: "escape.txt" },
          { path: "big.bin" },
          { path: "inside.txt", sha256: "deadbeef" },
        ],
      },
      { sessionID: "ses_a" },
    )

    const text = test.prompts.at(-1)!.text
    expect(text).toContain("inside.txt: ok")
    expect(text).toContain(`../${outsideName}: outside project or missing`)
    expect(text).toContain("/etc/hostname: outside project or missing")
    expect(text).toContain("escape.txt: outside project or missing")
    expect(text).toContain("big.bin: too large")
    expect(text).toContain("inside.txt: invalid sha256")
    expect(text).not.toContain("got ")
    expect(text).not.toContain(hostHash)

    rmSync(outside, { force: true })
    rmSync(root, { recursive: true, force: true })
  })
})

describe("HMAC metadata binding", () => {
  it("rejects metadata that differs from the signed envelope", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    await test.tools.spawn.execute({ title: "B" }, { sessionID: "ses_a" })
    const b = [...test.sessions.values()].find((session) => session.title === "B")!
    await test.tools.send.execute(
      { to: b.id, text: "signed", kind: "letter", task_id: "T1", reply_to: "T0", msg_id: "msg_bound" },
      { sessionID: "ses_a" },
    )
    const sent = test.prompts.at(-1)!

    for (const patch of [{ kind: "task" }, { msgID: "msg_other" }, { replyTo: "msg_other" }, { taskID: "T2" }]) {
      const event = {
        sessionID: b.id,
        prompt: { text: sent.text },
        metadata: structuredClone(sent.metadata),
      }
      Object.assign((event.metadata as any).postal, patch)
      await test.hooks.prompt(event)
      expect(event.prompt.text).toBe("")
      expect((event.metadata as any).postal.reason).toBe("invalid_signature")
    }

    const spoofed = {
      sessionID: b.id,
      prompt: { text: sent.text },
      metadata: structuredClone(sent.metadata),
    }
    ;(spoofed.metadata as any).postal.from = "ses_c"
    await test.hooks.prompt(spoofed)
    expect(spoofed.prompt.text).toBe("")
    expect((spoofed.metadata as any).postal.reason).toBe("unknown_key")
  })

  it("rejects letters signed with the legacy version", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    await test.tools.send.execute({ to: "ses_b", text: "signed", msg_id: "msg_v1" }, { sessionID: "ses_a" })
    const sent = test.prompts.at(-1)!
    const event = {
      sessionID: "ses_b",
      prompt: { text: sent.text },
      metadata: structuredClone(sent.metadata),
    }
    delete (event.metadata as any).postal.sigVersion
    await test.hooks.prompt(event)
    expect(event.prompt.text).toBe("")
    expect((event.metadata as any).postal.reason).toBe("unsupported_signature_version")
  })
})

describe("ACK semantics", () => {
  it("does not ack a letter just because the receiver admitted it", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    await test.tools.send.execute({ to: "ses_b", text: "hello", msg_id: "msg_admit_only" }, { sessionID: "ses_a" })
    const sent = test.prompts.at(-1)!
    await test.hooks.prompt({
      sessionID: "ses_b",
      prompt: { text: sent.text },
      metadata: structuredClone(sent.metadata),
    })
    await flush()
    expect((test.storage.get(outboxKey("ses_a", "msg_admit_only")) as any).status).toBe("delivered")
  })

  it("keeps an admitted task visible to the watchdog", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    await test.tools.spawn.execute({ title: "B" }, { sessionID: "ses_a" })
    const b = [...test.sessions.values()].find((session) => session.title === "B")!
    await test.tools.send.execute(
      { to: b.id, text: "do it", kind: "task", task_id: "T1", msg_id: "msg_admit_task" },
      { sessionID: "ses_a" },
    )
    const sent = test.prompts.at(-1)!
    await test.hooks.prompt({
      sessionID: b.id,
      prompt: { text: sent.text },
      metadata: structuredClone(sent.metadata),
    })
    await flush()

    const watchdog = await test.tools.watchdog.execute({ afterSeconds: 0 }, { sessionID: "ses_a" })
    expect(watchdog.content).toContain("msg_admit_task")
    expect(watchdog.content).toContain("NUDGED\t-")
  })

  it("does not let a watchdog nudge ack the task it monitors", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    await test.tools.spawn.execute({ title: "B" }, { sessionID: "ses_a" })
    const b = [...test.sessions.values()].find((session) => session.title === "B")!
    await test.rpc.presence({ sessions: [{ id: b.id, title: "B", state: "idle", pending: [] }] })
    await test.tools.send.execute(
      { to: b.id, text: "do it", kind: "task", task_id: "T1", msg_id: "msg_nudge_task" },
      { sessionID: "ses_a" },
    )
    const first = await test.tools.watchdog.execute({ afterSeconds: 0 }, { sessionID: "ses_a" })
    expect(first.content).toContain("NUDGED\tmsg_nudge_task")
    const nudge = test.prompts.at(-1)!
    expect((nudge.metadata as any).postal.kind).toBe("system")

    await test.hooks.prompt({
      sessionID: b.id,
      prompt: { text: nudge.text },
      metadata: structuredClone(nudge.metadata),
    })
    await flush()
    expect((test.storage.get(outboxKey("ses_a", "msg_nudge_task")) as any).status).toBe("delivered")

    // Simulate the nudge interval elapsing; the task must still be monitored.
    const record = test.storage.get(outboxKey("ses_a", "msg_nudge_task")) as any
    record.lastNudgeAt = 0
    test.storage.set(outboxKey("ses_a", "msg_nudge_task"), record)
    const second = await test.tools.watchdog.execute({ afterSeconds: 0 }, { sessionID: "ses_a" })
    expect(second.content).toContain("msg_nudge_task")
    expect(second.content).toContain("NUDGED\tmsg_nudge_task")
    expect((test.storage.get(outboxKey("ses_a", "msg_nudge_task")) as any).nudges).toBe(2)
  })

  it("ignores an ack for a record addressed to another peer", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    test.addSession("ses_c", "C")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    await test.rpc.connect({ sessionID: "ses_b", peerID: "ses_c" })
    await test.tools.send.execute(
      { to: "ses_b", text: "task", msg_id: "msg_cross_task" },
      { sessionID: "ses_a" },
    )
    await test.tools.send.execute(
      { to: "ses_b", text: "fake ack", reply_to: "msg_cross_task", msg_id: "msg_cross_ack" },
      { sessionID: "ses_c" },
    )
    const forged = test.prompts.at(-1)!
    await test.hooks.prompt({
      sessionID: "ses_b",
      prompt: { text: forged.text },
      metadata: structuredClone(forged.metadata),
    })
    await flush()
    expect((test.storage.get(outboxKey("ses_a", "msg_cross_task")) as any).status).toBe("delivered")
  })
})

describe("session lifecycle integrity", () => {
  it("keeps parent links intact when session removal fails", async () => {
    const test = await boot()
    test.context.options.enforceApprovals = false
    test.addSession("ses_a", "A")
    await test.tools.spawn.execute({ title: "B" }, { sessionID: "ses_a" })
    const b = [...test.sessions.values()].find((session) => session.title === "B")!
    await test.tools.spawn.execute({ title: "C" }, { sessionID: b.id })
    const c = [...test.sessions.values()].find((session) => session.title === "C")!

    const original = test.context.session.remove
    test.context.session.remove = async () => {
      throw new Error("remove failed")
    }
    const first = await test.tools.close.execute({ sessionID: b.id }, { sessionID: "ses_a" })
    expect(first.content).toContain("close failed")
    expect(test.sessions.has(b.id)).toBe(true)
    expect(test.storage.get(`parent/${b.id}`)).toBeDefined()
    expect((test.storage.get(`parent/${c.id}`) as any).parentID).toBe(b.id)

    test.context.session.remove = original
    const retry = await test.tools.close.execute({ sessionID: b.id }, { sessionID: "ses_a" })
    expect(retry.content).toContain("closed")
    expect((test.storage.get(`parent/${c.id}`) as any).parentID).toBe("ses_a")
  })

  it("does not drop a peer when a status lookup fails transiently", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })

    const original = test.context.session.get
    let failed = false
    test.context.session.get = async (input: any) => {
      if (input.sessionID === "ses_b" && !failed) {
        failed = true
        throw new Error("transient")
      }
      return original(input)
    }

    const first = await test.tools.status.execute({}, { sessionID: "ses_a" })
    expect(first.content).not.toContain("ses_b")
    expect(test.storage.get("peers/ses_a")).toBeDefined()

    const second = await test.tools.status.execute({}, { sessionID: "ses_a" })
    expect(second.content).toContain("ses_b")
    test.context.session.get = original
  })
})

describe("concurrency and sender scoping", () => {
  it("serializes concurrent claims for one scope", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    const [a, b] = await Promise.all([
      test.tools.claim.execute({ scope: "shared", ttl: 60 }, { sessionID: "ses_a" }),
      test.tools.claim.execute({ scope: "shared", ttl: 60 }, { sessionID: "ses_b" }),
    ])
    const results = [a.content, b.content]
    expect(results.filter((result) => result.includes("claimed")).length).toBe(1)
    expect(results.filter((result) => result.includes("claim busy")).length).toBe(1)
  })

  it("scopes watchdog nudges to the caller's outbox", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    test.addSession("ses_c", "C")
    await test.rpc.presence({ sessions: [{ id: "ses_b", title: "B", state: "idle", pending: [] }] })
    await test.tools.send.execute(
      { to: "ses_b", text: "task", kind: "task", task_id: "T1", msg_id: "msg_c_owned" },
      { sessionID: "ses_c" },
    )
    const watchdog = await test.tools.watchdog.execute({ afterSeconds: 0 }, { sessionID: "ses_a" })
    expect(watchdog.content).not.toContain("msg_c_owned")
  })

  it("scopes cleanup to the caller's outbox", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    test.addSession("ses_c", "C")
    await test.rpc.connect({ sessionID: "ses_c", peerID: "ses_b" })
    await test.tools.send.execute(
      { to: "ses_b", text: "old", msg_id: "msg_c_old" },
      { sessionID: "ses_c" },
    )
    const key = outboxKey("ses_c", "msg_c_old")
    const record = test.storage.get(key) as any
    record.createdAt = Date.now() - 8 * 24 * 60 * 60 * 1000
    test.storage.set(key, record)
    const result = await test.tools.cleanup.execute({ dryRun: false }, { sessionID: "ses_a" })
    expect(result.content).toContain("COUNT\t0")
    expect(test.storage.has(key)).toBe(true)
  })

  it("rejects cross-session inspection without lifecycle authority", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_c", "C")
    const inbox = await test.tools.inbox.execute({ sessionID: "ses_c" }, { sessionID: "ses_a" })
    const status = await test.tools.status.execute({ sessionID: "ses_c" }, { sessionID: "ses_a" })
    const log = await test.tools.log.execute({ sessionID: "ses_c" }, { sessionID: "ses_a" })
    expect(inbox.content).toContain("not authorized")
    expect(status.content).toContain("not authorized")
    expect(log.content).toContain("not authorized")
  })

  it("allows a parent to inspect its child", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    await test.tools.spawn.execute({ title: "B" }, { sessionID: "ses_a" })
    const b = [...test.sessions.values()].find((session) => session.title === "B")!
    const inbox = await test.tools.inbox.execute({ sessionID: b.id }, { sessionID: "ses_a" })
    expect(inbox.content).not.toContain("not authorized")
  })

  it("keeps idempotency keys per sender", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    test.addSession("ses_c", "C")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    await test.rpc.connect({ sessionID: "ses_c", peerID: "ses_b" })
    const first = await test.tools.send.execute(
      { to: "ses_b", text: "from a", msg_id: "msg_shared" },
      { sessionID: "ses_a" },
    )
    const second = await test.tools.send.execute(
      { to: "ses_b", text: "from c", msg_id: "msg_shared" },
      { sessionID: "ses_c" },
    )
    expect(first.content).toContain("delivered")
    expect(second.content).toContain("delivered")
    expect(test.storage.has(outboxKey("ses_a", "msg_shared"))).toBe(true)
    expect(test.storage.has(outboxKey("ses_c", "msg_shared"))).toBe(true)
  })
})

describe("outbox integrity", () => {
  it("rolls back a record when the outbox index write fails", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    const original = test.context.storage.set
    let failed = false
    test.context.storage.set = async (key: string, value: unknown) => {
      if (key === "outbox/index" && !failed) {
        failed = true
        throw new Error("index write failed")
      }
      return original(key, value)
    }
    await expect(
      test.tools.send.execute({ to: "ses_b", text: "hello", msg_id: "msg_index_fail" }, { sessionID: "ses_a" }),
    ).rejects.toThrow("index write failed")
    expect(test.storage.has(outboxKey("ses_a", "msg_index_fail"))).toBe(false)
    test.context.storage.set = original
  })

  it("does not resend delivered records during retry", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    await test.tools.send.execute({ to: "ses_b", text: "hello", msg_id: "msg_delivered" }, { sessionID: "ses_a" })
    const before = test.prompts.length
    const retry = await test.tools.retry.execute({}, { sessionID: "ses_a" })
    expect(retry.content).toContain("RETRY_DONE")
    expect(test.prompts.length).toBe(before)
    expect((test.storage.get(outboxKey("ses_a", "msg_delivered")) as any).status).toBe("delivered")
  })

  it("does not resurrect a record deleted between listing and attempt", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    await test.tools.send.execute({ to: "ses_b", text: "hello", msg_id: "msg_gone" }, { sessionID: "ses_a" })
    const key = outboxKey("ses_a", "msg_gone")
    const record = test.storage.get(key) as any
    record.status = "pending"
    record.nextAt = 0
    record.attempts = 0
    test.storage.set(key, record)
    const before = test.prompts.length

    const originalGet = test.context.storage.get
    let reads = 0
    test.context.storage.get = async (storageKey: string) => {
      if (storageKey === key) {
        reads += 1
        if (reads > 1) return undefined
      }
      return originalGet(storageKey)
    }
    const retry = await test.tools.retry.execute({}, { sessionID: "ses_a" })
    test.context.storage.get = originalGet
    expect(retry.content).toContain("RETRY_DONE")
    expect(test.prompts.length).toBe(before)
  })
})

describe("retry availability", () => {
  it("keeps retrying other destinations while one prompt hangs", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    test.addSession("ses_c", "C")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_c" })
    await test.tools.send.execute({ to: "ses_b", text: "slow", msg_id: "msg_slow" }, { sessionID: "ses_a" })
    await test.tools.send.execute({ to: "ses_c", text: "fast", msg_id: "msg_fast" }, { sessionID: "ses_a" })
    for (const id of ["msg_slow", "msg_fast"]) {
      const key = outboxKey("ses_a", id)
      const record = test.storage.get(key) as any
      record.status = "pending"
      record.nextAt = 0
      record.attempts = 0
      test.storage.set(key, record)
    }

    const originalPrompt = test.context.session.prompt
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    test.context.session.prompt = async (input: any) => {
      if (input.sessionID === "ses_b") await gate
      return originalPrompt(input)
    }

    try {
      const before = test.prompts.filter((prompt) => prompt.sessionID === "ses_c").length
      const retry = test.tools.retry.execute({}, { sessionID: "ses_a" })
      await new Promise((resolve) => setTimeout(resolve, 20))
      const after = test.prompts.filter((prompt) => prompt.sessionID === "ses_c").length
      release()
      await retry
      expect(after).toBeGreaterThan(before)
    } finally {
      release()
      test.context.session.prompt = originalPrompt
    }
  })

  it("keeps one retry timer per location", async () => {
    const originalInterval = globalThis.setInterval
    let calls = 0
    ;(globalThis as any).setInterval = (fn: any, ms?: number) => {
      calls += 1
      return originalInterval(fn, ms as any)
    }
    try {
      const a = harness()
      a.context.location.directory = "/tmp/postal-loc-a"
      await plugin.setup(a.context)
      const b = harness()
      b.context.location.directory = "/tmp/postal-loc-b"
      await plugin.setup(b.context)
      expect(calls).toBe(2)
      await plugin.setup(a.context)
      expect(calls).toBe(3)
    } finally {
      ;(globalThis as any).setInterval = originalInterval
    }
  })
})

describe("mention addressing", () => {
  it("forwards only when the prompt starts with an address", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })

    await test.hooks.prompt({
      sessionID: "ses_a",
      prompt: { text: "Example @ses_b should not forward" },
      metadata: {},
    })
    await flush()
    expect(test.prompts).toHaveLength(0)

    await test.hooks.prompt({
      sessionID: "ses_a",
      prompt: { text: "```\n@ses_b should not forward\n```" },
      metadata: {},
    })
    await flush()
    expect(test.prompts).toHaveLength(0)

    await test.hooks.prompt({
      sessionID: "ses_a",
      prompt: { text: "  @ses_b hello" },
      metadata: {},
    })
    await flush()
    expect(test.prompts).toHaveLength(1)
    expect(test.prompts[0].sessionID).toBe("ses_b")
  })
})

describe("inbound receipts", () => {
  it("records an accepted receipt and exposes the admitted time", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    await test.tools.send.execute({ to: "ses_b", text: "hello", msg_id: "msg_receipt_ok" }, { sessionID: "ses_a" })
    const sent = test.prompts.at(-1)!
    await test.hooks.prompt({
      sessionID: "ses_b",
      prompt: { text: sent.text },
      metadata: structuredClone(sent.metadata),
    })
    await flush()

    const receipt = test.storage.get(receiptKey("ses_a", "ses_b", "msg_receipt_ok")) as any
    expect(receipt.status).toBe("accepted")
    const inbox = await test.tools.inbox.execute({}, { sessionID: "ses_a" })
    expect(inbox.content).toContain("msg_receipt_ok")
    const record = test.storage.get(outboxKey("ses_a", "msg_receipt_ok")) as any
    expect(record.status).toBe("delivered")
    expect(record.admittedAt).toBe(receipt.verifiedAt)
  })

  it("reconciles a rejected receipt into the sender inbox", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    await test.tools.send.execute({ to: "ses_b", text: "hello", msg_id: "msg_receipt_bad" }, { sessionID: "ses_a" })
    const sent = test.prompts.at(-1)!
    await test.hooks.prompt({
      sessionID: "ses_b",
      prompt: { text: `${sent.text}\ntampered` },
      metadata: structuredClone(sent.metadata),
    })
    await flush()

    const receipt = test.storage.get(receiptKey("ses_a", "ses_b", "msg_receipt_bad")) as any
    expect(receipt.status).toBe("rejected")
    expect(receipt.reason).toBe("invalid_signature")
    const inbox = await test.tools.inbox.execute({}, { sessionID: "ses_a" })
    expect(inbox.content).toContain("rejected")
    expect(inbox.content).toContain("invalid_signature")
    const status = await test.tools.status.execute({}, { sessionID: "ses_a" })
    expect(status.content).toContain("OUTBOX_REJECTED\t1")
  })

  it("records an unauthorized task rejection", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    await test.tools.spawn.execute({ title: "B" }, { sessionID: "ses_a" })
    const b = [...test.sessions.values()].find((session) => session.title === "B")!
    test.addSession("ses_c", "C")
    await test.rpc.connect({ sessionID: "ses_c", peerID: b.id })
    // Simulate a stale/misconfigured grant so the sender delivers; the receiver
    // must still reject because the grant is gone at admission time.
    const grantKey = `grants/ses_c/${b.id}`
    test.storage.set(grantKey, {
      from: "ses_c",
      to: b.id,
      operations: {
        send: { allowed: true, approvalRequired: false },
        task: { allowed: true, approvalRequired: false },
      },
      initialized: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await test.tools.send.execute(
      { to: b.id, text: "task", kind: "task", task_id: "T1", msg_id: "msg_task_unauth" },
      { sessionID: "ses_c" },
    )
    const sent = test.prompts.at(-1)!
    test.storage.delete(grantKey)
    await test.hooks.prompt({
      sessionID: b.id,
      prompt: { text: sent.text },
      metadata: structuredClone(sent.metadata),
    })
    await flush()

    const receipt = test.storage.get(receiptKey("ses_c", b.id, "msg_task_unauth")) as any
    expect(receipt.status).toBe("rejected")
    expect(receipt.reason).toBe("unauthorized_task")
    const inbox = await test.tools.inbox.execute({}, { sessionID: "ses_c" })
    expect(inbox.content).toContain("unauthorized_task")
  })

  it("records the authorizing ancestor for an accepted task", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    await test.tools.spawn.execute({ title: "B" }, { sessionID: "ses_a" })
    const b = [...test.sessions.values()].find((session) => session.title === "B")!
    await test.tools.send.execute(
      { to: b.id, text: "task", kind: "task", task_id: "T1", msg_id: "msg_task_ok" },
      { sessionID: "ses_a" },
    )
    const sent = test.prompts.at(-1)!
    const event = {
      sessionID: b.id,
      prompt: { text: sent.text },
      metadata: structuredClone(sent.metadata),
    }
    await test.hooks.prompt(event)
    await flush()

    const receipt = test.storage.get(receiptKey("ses_a", b.id, "msg_task_ok")) as any
    expect(receipt.status).toBe("accepted")
    expect(receipt.authorizedBy).toBe("ses_a")
    expect((event.metadata as any).postal.authorizedBy).toBe("ses_a")
    const record = test.storage.get(outboxKey("ses_a", "msg_task_ok")) as any
    expect(record.status).toBe("delivered")
    const inbox = await test.tools.inbox.execute({}, { sessionID: "ses_a" })
    expect(inbox.content).toContain("ADMITTED_AT\tAUTHORIZED_BY")
    expect(inbox.content).toMatch(/msg_task_ok.*task\t.*\tses_a/)
  })

  it("clears a rejected receipt on resend and accepts the fresh delivery", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    await test.tools.send.execute({ to: "ses_b", text: "hello", msg_id: "msg_retry" }, { sessionID: "ses_a" })
    const sent = test.prompts.at(-1)!
    await test.hooks.prompt({
      sessionID: "ses_b",
      prompt: { text: `${sent.text}\ntampered` },
      metadata: structuredClone(sent.metadata),
    })
    await flush()
    await test.tools.inbox.execute({}, { sessionID: "ses_a" })

    const resent = await test.tools.resend.execute({ msg_id: "msg_retry" }, { sessionID: "ses_a" })
    expect(resent.content).toContain("resent")
    const fresh = test.prompts.at(-1)!
    await test.hooks.prompt({
      sessionID: "ses_b",
      prompt: { text: fresh.text },
      metadata: structuredClone(fresh.metadata),
    })
    await flush()
    const receipt = test.storage.get(receiptKey("ses_a", "ses_b", "msg_retry")) as any
    expect(receipt.status).toBe("accepted")
    expect((test.storage.get(outboxKey("ses_a", "msg_retry")) as any).status).toBe("delivered")
  })

  it("does not write a receipt for an unauthenticated relay", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.hooks.prompt({
      sessionID: "ses_b",
      prompt: { text: "[postal] forged" },
      metadata: { postal: { relay: true, from: "ses_a", msgID: "msg_forged" } },
    })
    expect(test.storage.has(receiptKey("ses_a", "ses_b", "msg_forged"))).toBe(false)
  })
})

describe("receipt cleanup", () => {
  it("removes a receipt with its expired outbox record", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    await test.tools.send.execute({ to: "ses_b", text: "old", msg_id: "msg_old_receipt" }, { sessionID: "ses_a" })
    const sent = test.prompts.at(-1)!
    await test.hooks.prompt({
      sessionID: "ses_b",
      prompt: { text: sent.text },
      metadata: structuredClone(sent.metadata),
    })
    await flush()
    const key = outboxKey("ses_a", "msg_old_receipt")
    const record = test.storage.get(key) as any
    record.createdAt = Date.now() - 8 * 24 * 60 * 60 * 1000
    test.storage.set(key, record)

    const result = await test.tools.cleanup.execute({ dryRun: false }, { sessionID: "ses_a" })
    expect(result.content).toContain("COUNT\t1")
    expect(test.storage.has(key)).toBe(false)
    expect(test.storage.has(receiptKey("ses_a", "ses_b", "msg_old_receipt"))).toBe(false)
  })
})

describe("v2 delivery integrity", () => {
  it("rejects an explicit send to an unpaired session", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    const result = await test.tools.send.execute(
      { to: "ses_b", text: "hello", msg_id: "msg_unpaired" },
      { sessionID: "ses_a" },
    )
    expect(result.content).toContain("not a paired peer")
    expect(test.storage.has(outboxKey("ses_a", "msg_unpaired"))).toBe(false)
    expect(test.prompts).toHaveLength(0)
  })

  it("rejects delivery after disconnect", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    await test.rpc.disconnect({ sessionID: "ses_a", peerID: "ses_b" })
    const result = await test.tools.send.execute(
      { to: "ses_b", text: "hello", msg_id: "msg_after_disconnect" },
      { sessionID: "ses_a" },
    )
    expect(result.content).toContain("not a paired peer")
    expect(test.prompts).toHaveLength(0)
  })

  it("resolves an omitted recipient from paired peers only", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    test.addSession("ses_c", "C")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    const result = await test.tools.send.execute(
      { text: "paired only", msg_id: "msg_paired_only" },
      { sessionID: "ses_a" },
    )
    expect(result.content).toContain("delivered")
    expect(test.prompts.at(-1)?.sessionID).toBe("ses_b")
  })

  it("requires an explicit recipient when multiple peers are paired", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    test.addSession("ses_c", "C")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_c" })
    const result = await test.tools.send.execute({ text: "ambiguous", msg_id: "msg_ambiguous" }, { sessionID: "ses_a" })
    expect(result.content).toContain("2 peers are paired")
    expect(test.prompts).toHaveLength(0)
  })
})

describe("v2 same-id concurrency", () => {
  it("serializes concurrent sends with the same msg_id", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    const [first, second] = await Promise.all([
      test.tools.send.execute({ to: "ses_b", text: "one", msg_id: "msg_concurrent" }, { sessionID: "ses_a" }),
      test.tools.send.execute({ to: "ses_b", text: "two", msg_id: "msg_concurrent" }, { sessionID: "ses_a" }),
    ])
    const contents = [first.content, second.content]
    expect(contents.filter((content) => content.startsWith("postal: letter delivered")).length).toBe(1)
    expect(contents.filter((content) => content.includes("duplicate")).length).toBe(1)
    expect(test.prompts).toHaveLength(1)
  })
})

describe("v2 replay and resend limits", () => {
  it("rejects a replayed letter at the receiver", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    await test.tools.send.execute({ to: "ses_b", text: "once", msg_id: "msg_replay" }, { sessionID: "ses_a" })
    const sent = test.prompts.at(-1)!
    const first = {
      sessionID: "ses_b",
      prompt: { text: sent.text },
      metadata: structuredClone(sent.metadata),
    }
    await test.hooks.prompt(first)
    expect(first.prompt.text).toBe(sent.text)

    const second = {
      sessionID: "ses_b",
      prompt: { text: sent.text },
      metadata: structuredClone(sent.metadata),
    }
    await test.hooks.prompt(second)
    expect(second.prompt.text).toBe("")
    expect((second.metadata as any).postal.reason).toBe("duplicate")
  })

  it("refuses resends past the limit", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    await test.tools.send.execute({ to: "ses_b", text: "hello", msg_id: "msg_cap" }, { sessionID: "ses_a" })
    const key = outboxKey("ses_a", "msg_cap")
    const record = test.storage.get(key) as any
    record.resendCount = 5
    test.storage.set(key, record)
    const before = test.prompts.length

    const result = await test.tools.resend.execute({ msg_id: "msg_cap" }, { sessionID: "ses_a" })
    expect(result.content).toContain("resend limit reached")
    expect(test.prompts.length).toBe(before)
  })
})

describe("v2 shared record serialization", () => {
  it("keeps both peers when pairs are created concurrently", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    test.addSession("ses_c", "C")
    await Promise.all([
      test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" }),
      test.rpc.connect({ sessionID: "ses_a", peerID: "ses_c" }),
    ])
    const status = await test.rpc.status({ sessionID: "ses_a" })
    expect((status.peers ?? []).map((peer: any) => peer.id).sort()).toEqual(["ses_b", "ses_c"])
  })
})

describe("v2 relation grants", () => {
  it("shows spawn defaults and supports grant/revoke", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    await test.tools.spawn.execute({ title: "B" }, { sessionID: "ses_a" })
    const b = [...test.sessions.values()].find((session) => session.title === "B")!

    const relationsA = await test.tools.relations.execute({}, { sessionID: "ses_a" })
    expect(relationsA.content).toContain("SPAWNED_BY\t-")
    expect(relationsA.content).toContain(`out\t${b.id}\tsend,task,interrupt,close,history`)

    const relationsB = await test.tools.relations.execute({}, { sessionID: b.id })
    expect(relationsB.content).toContain("SPAWNED_BY\tses_a")
    expect(relationsB.content).toContain(`out\tses_a\tsend`)

    const granted = await test.tools.grant.execute(
      { to: b.id, operations: ["approve"], approvalRequired: true },
      { sessionID: "ses_a" },
    )
    expect(granted.content).toContain("GRANTED")
    expect((await test.tools.relations.execute({}, { sessionID: "ses_a" })).content).toContain("approve")

    const revoked = await test.tools.revoke.execute(
      { to: b.id, operations: ["task"] },
      { sessionID: "ses_a" },
    )
    expect(revoked.content).toContain("revoked")
    const after = await test.tools.relations.execute({}, { sessionID: "ses_a" })
    const outLine = after.content.split("\n").find((line) => line.startsWith("out\t"))
    expect(outLine).not.toContain("task")
  })

  it("rejects grants to unrelated sessions and uses send-only pair defaults", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    test.addSession("ses_c", "C")

    const rejected = await test.tools.grant.execute(
      { to: "ses_b", operations: ["send"] },
      { sessionID: "ses_a" },
    )
    expect(rejected.content).toContain("grant failed")

    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_c" })
    const relations = await test.tools.relations.execute({}, { sessionID: "ses_a" })
    const outLine = relations.content
      .split("\n")
      .find((line) => line.startsWith("out\t") && line.includes("ses_c"))
    expect(outLine).toContain("send")
    expect(outLine).not.toContain("task")
  })
})

describe("v2 grant rpc", () => {
  it("grants send to a paired peer and reports the result", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })

    const result = await test.rpc.grant({
      sessionID: "ses_a",
      peerID: "ses_b",
      operations: ["send"],
    })
    expect(result.ok).toBe(true)
    expect(result.peerID).toBe("ses_b")
    expect(result.grant).toContain("OPERATIONS\tsend")
    const grant = test.storage.get("grants/ses_a/ses_b") as any
    expect(grant.operations.send.allowed).toBe(true)
  })

  it("lets the spawn parent grant authority but not the child", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    await test.tools.spawn.execute({ title: "B" }, { sessionID: "ses_a" })
    const b = [...test.sessions.values()].find((session) => session.title === "B")!

    const parent = await test.rpc.grant({
      sessionID: "ses_a",
      peerID: b.id,
      operations: ["send", "history"],
    })
    expect(parent.ok).toBe(true)

    const child = await test.rpc.grant({
      sessionID: b.id,
      peerID: "ses_a",
      operations: ["interrupt"],
    })
    expect(child.ok).toBe(false)
    expect(child.error).toContain("only the spawn parent")
  })

  it("rejects an empty or unknown operation list", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })

    const empty = await test.rpc.grant({ sessionID: "ses_a", peerID: "ses_b", operations: [] })
    expect(empty.ok).toBe(false)
    expect(empty.error).toContain("at least one valid operation")

    const unknown = await test.rpc.grant({
      sessionID: "ses_a",
      peerID: "ses_b",
      operations: ["bogus"],
    })
    expect(unknown.ok).toBe(false)
  })
})

describe("v2 grant enforcement", () => {
  it("blocks delivery at retry when a grant is revoked", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    await test.tools.send.execute({ to: "ses_b", text: "revocable", msg_id: "msg_revoke" }, { sessionID: "ses_a" })
    const before = test.prompts.length

    await test.tools.revoke.execute({ to: "ses_b", operations: ["send"] }, { sessionID: "ses_a" })
    const refused = await test.tools.resend.execute({ msg_id: "msg_revoke" }, { sessionID: "ses_a" })
    expect(refused.content).toContain("grant revoked")
    expect(test.prompts.length).toBe(before)
    expect((test.storage.get(outboxKey("ses_a", "msg_revoke")) as any).status).toBe("revoked")

    await test.tools.grant.execute({ to: "ses_b", operations: ["send"] }, { sessionID: "ses_a" })
    const resent = await test.tools.resend.execute({ msg_id: "msg_revoke" }, { sessionID: "ses_a" })
    expect(resent.content).toContain("resent")
    expect(test.prompts.length).toBe(before + 1)
  })
})

describe("v2 supervision and consultation", () => {
  it("lets A supervise B while B consults A", async () => {
    const test = await boot()
    test.context.options.enforceApprovals = false
    test.addSession("ses_a", "A")
    await test.tools.spawn.execute({ title: "B" }, { sessionID: "ses_a" })
    const b = [...test.sessions.values()].find((session) => session.title === "B")!

    const task = await test.tools.send.execute(
      { to: b.id, text: "supervised task", kind: "task", task_id: "T1", msg_id: "msg_supervise" },
      { sessionID: "ses_a" },
    )
    expect(task.content).toContain("letter delivered")

    const consult = await test.tools.send.execute(
      { to: "ses_a", text: "consultation", msg_id: "msg_consult" },
      { sessionID: b.id },
    )
    expect(consult.content).toContain("letter delivered")

    const denied = await test.tools.send.execute(
      { to: "ses_a", text: "reverse task", kind: "task", msg_id: "msg_reverse_task" },
      { sessionID: b.id },
    )
    expect(denied.content).toContain("task is not granted")

    const interrupt = await test.tools.interrupt.execute({ sessionID: b.id }, { sessionID: "ses_a" })
    expect(interrupt.content).toContain("interrupted")
    const reverseInterrupt = await test.tools.interrupt.execute({ sessionID: "ses_a" }, { sessionID: b.id })
    expect(reverseInterrupt.content).toContain("not authorized")

    const escalation = await test.tools.grant.execute(
      { to: "ses_a", operations: ["task"] },
      { sessionID: b.id },
    )
    expect(escalation.content).toContain("only the spawn parent")
  })
})

describe("v2 approvals", () => {
  const approvalID = (content: string) => content.match(/APPROVAL_ID\t(\S+)/)?.[1] ?? ""

  async function setupChain() {
    const test = await boot()
    test.addSession("ses_root", "Root")
    await test.tools.spawn.execute({ title: "A" }, { sessionID: "ses_root" })
    const a = [...test.sessions.values()].find((session) => session.title === "A")!
    await test.tools.spawn.execute({ title: "B" }, { sessionID: a.id })
    const b = [...test.sessions.values()].find((session) => session.title === "B")!
    return { test, a, b }
  }

  it("requires an approval for close and binds it to the target", async () => {
    const { test, a, b } = await setupChain()
    const consult = await test.tools.send.execute(
      { to: a.id, text: "consult while supervised", kind: "request", msg_id: "msg_consult" },
      { sessionID: b.id },
    )
    expect(consult.content).toContain("letter delivered")
    await test.tools.spawn.execute({ title: "C" }, { sessionID: a.id })
    const c = [...test.sessions.values()].find((session) => session.title === "C")!

    const denied = await test.tools.close.execute({ sessionID: b.id }, { sessionID: a.id })
    expect(denied.content).toContain("approval required")

    const requested = await test.tools.request_approval.execute(
      { operation: "close", resource: b.id, parameters: {} },
      { sessionID: a.id },
    )
    const id = approvalID(requested.content)
    expect(id).toStartWith("apr_")
    expect(requested.content).toContain("STATUS\tpending")

    const self = await test.tools.approve.execute({ approval_id: id }, { sessionID: a.id })
    expect(self.content).toContain("not authorized")

    const approved = await test.tools.approve.execute({ approval_id: id }, { sessionID: "ses_root" })
    expect(approved.content).toContain("APPROVED")

    // The same approval cannot close a different session.
    const mismatch = await test.tools.close.execute(
      { sessionID: c.id, approval_id: id },
      { sessionID: a.id },
    )
    expect(mismatch.content).toContain("hash does not match")
    expect(test.sessions.has(c.id)).toBe(true)

    const closed = await test.tools.close.execute(
      { sessionID: b.id, approval_id: id },
      { sessionID: a.id },
    )
    expect(closed.content).toContain(`closed ${b.id}`)
    expect(test.sessions.has(b.id)).toBe(false)

    const reuse = await test.tools.consume_approval.execute({ approval_id: id }, { sessionID: a.id })
    expect(reuse.content).toContain("approval is consumed")

    const audit = await test.tools.audit.execute({}, { sessionID: a.id })
    expect(audit.content).toContain("approval_request")
    expect(audit.content).toContain("approval_consume")
    const approverAudit = await test.tools.audit.execute({}, { sessionID: "ses_root" })
    expect(approverAudit.content).toContain("approval_approve")
  })

  it("rejects expired approvals without executing the operation", async () => {
    const { test, a, b } = await setupChain()
    const requested = await test.tools.request_approval.execute(
      { operation: "close", resource: b.id, parameters: {} },
      { sessionID: a.id },
    )
    const id = approvalID(requested.content)
    await test.tools.approve.execute({ approval_id: id }, { sessionID: "ses_root" })
    const record = test.storage.get(`approval/${id}`) as any
    record.expiresAt = Date.now() - 1000
    test.storage.set(`approval/${id}`, record)

    const closed = await test.tools.close.execute(
      { sessionID: b.id, approval_id: id },
      { sessionID: a.id },
    )
    expect(closed.content).toContain("approval has expired")
    expect(test.sessions.has(b.id)).toBe(true)
  })

  it("audits grant, delivery, task, and revoke decisions", async () => {
    const { test, a, b } = await setupChain()

    await test.tools.grant.execute(
      { to: b.id, operations: ["history"], approvalRequired: false },
      { sessionID: a.id },
    )
    await test.tools.delivery.execute({ to: b.id, mode: "inbox" }, { sessionID: a.id })
    await test.tools.send.execute(
      { to: b.id, text: "assignment", kind: "assignment", task_id: "T-audit", msg_id: "msg_audit_task" },
      { sessionID: a.id },
    )
    const task = await test.tools.task_state.execute(
      { task_id: "T-audit", status: "done" },
      { sessionID: b.id },
    )
    expect(task.content).toContain("STATUS\tdone")
    await test.tools.revoke.execute({ to: b.id, operations: ["history"] }, { sessionID: a.id })

    const audit = await test.tools.audit.execute({}, { sessionID: a.id })
    expect(audit.content).toContain("\tgrant\t")
    expect(audit.content).toContain("\tdelivery\t")
    expect(audit.content).toContain("\trevoke\t")
    const taskAudit = await test.tools.audit.execute({}, { sessionID: b.id })
    expect(taskAudit.content).toContain("\ttask\t")
  })

  it("lists external operations with an enforceable flag and warning", async () => {
    const { test, a } = await setupChain()
    const host = await test.tools.request_approval.execute(
      { operation: "host.deploy", resource: "production" },
      { sessionID: a.id },
    )
    expect(host.content).toContain("ENFORCEABLE\tnone")
    expect(host.content).toContain("not enforceable by Postal")

    const relations = await test.tools.relations.execute({}, { sessionID: a.id })
    expect(relations.content).toContain("host.deploy\tnone\tyes\tapproval required but not enforceable by Postal")
    expect(relations.content).toContain("close\tpostal\tyes")
  })
})

describe("postal_tree", () => {
  it("renders spawned hierarchy, spawn facts, and grants", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    await test.tools.spawn.execute({ title: "B" }, { sessionID: "ses_a" })
    const b = [...test.sessions.values()].find((session) => session.title === "B")!
    await test.tools.spawn.execute({ title: "C" }, { sessionID: b.id })
    const c = [...test.sessions.values()].find((session) => session.title === "C")!

    const tree = await test.tools.tree.execute({}, { sessionID: "ses_a" })
    expect(tree.content).toContain("SPAWNED_BY\t-")
    expect(tree.content).toContain("ses_a (A)")
    expect(tree.content).toContain(b.id)
    expect(tree.content).toContain(c.id)
    expect(tree.content).toContain("→")

    const all = await test.tools.tree.execute({ all: true }, { sessionID: "ses_a" })
    expect(all.content).toContain(b.id)
    expect(all.content).toContain(c.id)

    const rpc = await test.rpc.tree({ sessionID: "ses_a" })
    expect(rpc.ok).toBe(true)
    expect(rpc.tree).toContain(b.id)
  })
})

describe("v2 delivery policy", () => {
  it("routes interrupt, idle, and inbox correctly", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })

    await test.tools.send.execute({ to: "ses_b", text: "default", msg_id: "msg_delivery_default" }, { sessionID: "ses_a" })
    expect(test.prompts.at(-1)?.delivery).toBe("steer")
    expect(test.prompts.at(-1)?.resume).toBeUndefined()

    await test.tools.delivery.execute({ to: "ses_b", mode: "inbox" }, { sessionID: "ses_a" })
    await test.tools.send.execute({ to: "ses_b", text: "inbox", msg_id: "msg_delivery_inbox" }, { sessionID: "ses_a" })
    expect(test.prompts.at(-1)?.delivery).toBe("queue")
    expect(test.prompts.at(-1)?.resume).toBe(false)

    await test.tools.delivery.execute({ to: "ses_b", mode: "idle" }, { sessionID: "ses_a" })
    await test.rpc.presence({ sessions: [{ id: "ses_b", title: "B", state: "idle", pending: [] }] })
    await test.tools.send.execute({ to: "ses_b", text: "idle", msg_id: "msg_delivery_idle" }, { sessionID: "ses_a" })
    expect(test.prompts.at(-1)?.delivery).toBe("steer")

    await test.rpc.presence({ sessions: [{ id: "ses_b", title: "B", state: "running", pending: [] }] })
    await test.tools.send.execute({ to: "ses_b", text: "busy", msg_id: "msg_delivery_busy" }, { sessionID: "ses_a" })
    expect(test.prompts.at(-1)?.delivery).toBe("queue")
    expect(test.prompts.at(-1)?.resume).toBe(false)

    const relations = await test.tools.relations.execute({}, { sessionID: "ses_a" })
    expect(relations.content).toContain("DELIVERY")
    expect(relations.content).toContain("idle")
  })

  it("rejects a delivery mode for an unrelated session", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    const result = await test.tools.delivery.execute({ to: "ses_b", mode: "inbox" }, { sessionID: "ses_a" })
    expect(result.content).toContain("delivery failed")
  })
})

describe("v2 task state", () => {
  it("keeps task state separate from message ACK", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    await test.tools.spawn.execute({ title: "B" }, { sessionID: "ses_a" })
    const b = [...test.sessions.values()].find((session) => session.title === "B")!
    await test.tools.send.execute(
      { to: b.id, text: "task", kind: "task", task_id: "T1", msg_id: "msg_task_state" },
      { sessionID: "ses_a" },
    )
    const before = await test.tools.inbox.execute({}, { sessionID: "ses_a" })
    expect(before.content).toContain("TASK_STATUS")
    expect(before.content).toContain("open")

    await test.tools.send.execute(
      { to: "ses_a", text: "ack", reply_to: "msg_task_state", msg_id: "msg_task_ack" },
      { sessionID: b.id },
    )
    const reply = test.prompts.at(-1)!
    await test.hooks.prompt({
      sessionID: "ses_a",
      prompt: { text: reply.text },
      metadata: structuredClone(reply.metadata),
    })
    await flush()
    const acked = await test.tools.inbox.execute({}, { sessionID: "ses_a" })
    expect(acked.content).toContain("acked")
    expect(acked.content).toContain("open")

    const done = await test.tools.task_state.execute({ task_id: "T1", status: "done" }, { sessionID: "ses_a" })
    expect(done.content).toContain("STATUS\tdone")
    expect((await test.tools.inbox.execute({}, { sessionID: "ses_a" })).content).toContain("done")
  })

  it("stops watchdog nudges for a completed task", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    await test.tools.spawn.execute({ title: "B" }, { sessionID: "ses_a" })
    const b = [...test.sessions.values()].find((session) => session.title === "B")!
    await test.rpc.presence({ sessions: [{ id: b.id, title: "B", state: "idle", pending: [] }] })
    await test.tools.send.execute(
      { to: b.id, text: "task", kind: "task", task_id: "T1", msg_id: "msg_task_done" },
      { sessionID: "ses_a" },
    )
    await test.tools.task_state.execute({ task_id: "T1", status: "done" }, { sessionID: "ses_a" })
    const watchdog = await test.tools.watchdog.execute({ afterSeconds: 0 }, { sessionID: "ses_a" })
    expect(watchdog.content).not.toContain("msg_task_done")
    expect(watchdog.content).toContain("NUDGED\t-")
  })

  it("does not let an unrelated session update a task", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_c", "C")
    await test.tools.spawn.execute({ title: "B" }, { sessionID: "ses_a" })
    const b = [...test.sessions.values()].find((session) => session.title === "B")!
    await test.tools.send.execute(
      { to: b.id, text: "task", kind: "task", task_id: "T1", msg_id: "msg_task_owner" },
      { sessionID: "ses_a" },
    )
    const denied = await test.tools.task_state.execute({ task_id: "T1", status: "done" }, { sessionID: "ses_c" })
    expect(denied.content).toContain("task not found")
  })
})

describe("v2 request and assignment", () => {
  it("uses send for requests and task for assignments", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    await test.tools.spawn.execute({ title: "B" }, { sessionID: "ses_a" })
    const b = [...test.sessions.values()].find((session) => session.title === "B")!

    const request = await test.tools.send.execute(
      { to: b.id, text: "please advise", kind: "request", msg_id: "msg_request" },
      { sessionID: "ses_a" },
    )
    expect(request.content).toContain("delivered")

    const consult = await test.tools.send.execute(
      { to: "ses_a", text: "consult", kind: "request", msg_id: "msg_consult_request" },
      { sessionID: b.id },
    )
    expect(consult.content).toContain("delivered")

    const reverse = await test.tools.send.execute(
      { to: "ses_a", text: "forced", kind: "assignment", msg_id: "msg_reverse_assignment" },
      { sessionID: b.id },
    )
    expect(reverse.content).toContain("task is not granted")

    const assignment = await test.tools.send.execute(
      {
        to: b.id,
        text: "do this",
        kind: "assignment",
        task_id: "A1",
        msg_id: "msg_assignment",
      },
      { sessionID: "ses_a" },
    )
    expect(assignment.content).toContain("delivered")

    const inbox = await test.tools.inbox.execute({}, { sessionID: "ses_a" })
    const requestLine = inbox.content.split("\n").find((line) => line.startsWith("msg_request\t"))
    const assignmentLine = inbox.content.split("\n").find((line) => line.startsWith("msg_assignment\t"))
    expect(requestLine).toContain("\trequest\t-")
    expect(assignmentLine).toContain("\tassignment\topen")
  })
})

describe("v2 revocation propagation", () => {
  it("revokes pending mail and cancels open tasks immediately", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    await test.tools.spawn.execute({ title: "B" }, { sessionID: "ses_a" })
    const b = [...test.sessions.values()].find((session) => session.title === "B")!

    await test.tools.send.execute({ to: b.id, text: "pending", msg_id: "msg_pending" }, { sessionID: "ses_a" })
    const pendingKey = outboxKey("ses_a", "msg_pending")
    const pending = test.storage.get(pendingKey) as any
    pending.status = "pending"
    pending.nextAt = 0
    test.storage.set(pendingKey, pending)

    await test.tools.send.execute(
      { to: b.id, text: "assignment", kind: "assignment", task_id: "T2", msg_id: "msg_assign_revoke" },
      { sessionID: "ses_a" },
    )

    const result = await test.tools.revoke.execute(
      { to: b.id, operations: ["send", "task"] },
      { sessionID: "ses_a" },
    )
    expect(result.content).toContain("REVOKED_RECORDS\tmsg_pending")
    expect(result.content).toContain("CANCELLED_TASKS\tT2")
    expect((test.storage.get(pendingKey) as any).status).toBe("revoked")

    const inbox = await test.tools.inbox.execute({}, { sessionID: "ses_a" })
    const taskLine = inbox.content.split("\n").find((line) => line.startsWith("msg_assign_revoke\t"))
    expect(taskLine).toContain("cancelled")
  })
})

describe("v2 disconnect revocation", () => {
  it("stops pending delivery after disconnect and restores send on reconnect", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    await test.tools.send.execute({ to: "ses_b", text: "pending", msg_id: "msg_r01" }, { sessionID: "ses_a" })
    const key = outboxKey("ses_a", "msg_r01")
    const record = test.storage.get(key) as any
    record.status = "pending"
    record.nextAt = 0
    test.storage.set(key, record)
    await test.rpc.disconnect({ sessionID: "ses_a", peerID: "ses_b" })
    const before = test.prompts.length

    await test.tools.retry.execute({}, { sessionID: "ses_a" })
    expect((test.storage.get(key) as any).status).toBe("revoked")
    expect((test.storage.get(key) as any).lastError).toBe("not_paired")
    expect(test.prompts.length).toBe(before)

    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    const resent = await test.tools.send.execute(
      { to: "ses_b", text: "after reconnect", msg_id: "msg_after_reconnect" },
      { sessionID: "ses_a" },
    )
    expect(resent.content).toContain("delivered")
  })
})

describe("v2 mention enforcement", () => {
  it("blocks mentions after disconnect or send revocation", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    await test.rpc.disconnect({ sessionID: "ses_a", peerID: "ses_b" })
    await test.hooks.prompt({ sessionID: "ses_a", prompt: { text: "@ses_b hello" }, metadata: {} })
    await flush()
    expect(test.prompts).toHaveLength(0)

    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    await test.hooks.prompt({ sessionID: "ses_a", prompt: { text: "@ses_b hello" }, metadata: {} })
    await flush()
    expect(test.prompts).toHaveLength(1)

    await test.tools.revoke.execute({ to: "ses_b", operations: ["send"] }, { sessionID: "ses_a" })
    await test.hooks.prompt({ sessionID: "ses_a", prompt: { text: "@ses_b hello" }, metadata: {} })
    await flush()
    expect(test.prompts).toHaveLength(1)
  })
})
