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

const flush = () => new Promise((resolve) => setTimeout(resolve, 5))

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
    const { addSession, hooks, prompts } = await boot()
    addSession("ses_a", "A")
    addSession("ses_b", "B")

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
    const { addSession, rpc, tools, prompts } = await boot()
    addSession("ses_a", "A")
    addSession("ses_b", "B")
    await rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })

    const dir = "/tmp/postal-test/postal-envelope-test"
    const path = join(dir, "artifact.txt")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, "evidence\n")
    const sha256 = createHash("sha256").update("evidence\n").digest("hex")

    try {
      const result = await tools.send.execute(
        {
          to: "ses_b",
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
    const { addSession, rpc, tools, interrupts, removes, sessions } = await boot()
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
    const { addSession, tools, sessions } = await boot()
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
    test.context.options = { allowAncestorCommands: true }

    const byAncestor = await test.tools.close.execute({ sessionID: c.id }, { sessionID: "ses_a" })
    expect(byAncestor.content).toContain("closed")
  })

  it("reparents children to the grandparent when a parent is closed", async () => {
    const test = await boot()
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
    test.context.options = { orphanPolicy: "detach" }

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
    test.context.options = { orphanPolicy: "terminate" }

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
    await test.tools.send.execute(
      { to: b.id, text: "task from non-parent", kind: "task" },
      { sessionID: "ses_c" },
    )
    const fromPeer = test.prompts.at(-1)!
    const peerEvent = {
      sessionID: b.id,
      prompt: { text: fromPeer.text },
      metadata: structuredClone(fromPeer.metadata),
    }
    await test.hooks.prompt(peerEvent)
    expect(peerEvent.prompt.text).toBe("")
    expect((peerEvent.metadata as any).postal.reason).toBe("unauthorized_task")
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
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    await test.rpc.presence({ sessions: [{ id: "ses_b", title: "B", state: "idle", pending: [] }] })
    await test.tools.send.execute(
      { to: "ses_b", text: "do the task", kind: "task", task_id: "T1", msg_id: "msg_task" },
      { sessionID: "ses_a" },
    )

    const result = await test.tools.watchdog.execute({ afterSeconds: 0 }, { sessionID: "ses_a" })

    expect(result.content).toContain("msg_task")
    expect(result.content).toContain("NUDGED\tmsg_task")
    const nudge = test.prompts.at(-1)!
    expect(nudge.sessionID).toBe("ses_b")
    expect(nudge.metadata?.postal?.kind).toBe("system")
    expect(nudge.metadata?.postal?.replyTo).toBe("msg_task")
    expect(nudge.text).toContain("Watchdog")
    const record = test.storage.get("outbox/msg_task") as any
    expect(record.nudges).toBe(1)
  })

  it("does not nudge a running worker", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    await test.rpc.presence({ sessions: [{ id: "ses_b", title: "B", state: "running", pending: [] }] })
    await test.tools.send.execute(
      { to: "ses_b", text: "do the task", kind: "task", task_id: "T1", msg_id: "msg_task_running" },
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
    const record = test.storage.get("outbox/msg_old_outbox") as any
    record.createdAt = Date.now() - 8 * 24 * 60 * 60 * 1000
    test.storage.set("outbox/msg_old_outbox", record)

    const dry = await test.tools.cleanup.execute({ dryRun: true }, { sessionID: "ses_a" })
    expect(dry.content).toContain("CLEANUP_DRY_RUN")
    expect(dry.content).toContain("COUNT\t1")
    expect(test.storage.has("outbox/msg_old_outbox")).toBe(true)

    const removed = await test.tools.cleanup.execute({ dryRun: false }, { sessionID: "ses_a" })
    expect(removed.content).toContain("CLEANUP_REMOVED")
    expect(removed.content).toContain("COUNT\t1")
    expect(test.storage.has("outbox/msg_old_outbox")).toBe(false)
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
    expect((test.storage.get("outbox/msg_admit_only") as any).status).toBe("delivered")
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
    expect((test.storage.get("outbox/msg_nudge_task") as any).status).toBe("delivered")

    // Simulate the nudge interval elapsing; the task must still be monitored.
    const record = test.storage.get("outbox/msg_nudge_task") as any
    record.lastNudgeAt = 0
    test.storage.set("outbox/msg_nudge_task", record)
    const second = await test.tools.watchdog.execute({ afterSeconds: 0 }, { sessionID: "ses_a" })
    expect(second.content).toContain("msg_nudge_task")
    expect(second.content).toContain("NUDGED\tmsg_nudge_task")
    expect((test.storage.get("outbox/msg_nudge_task") as any).nudges).toBe(2)
  })

  it("ignores an ack for a record addressed to another peer", async () => {
    const test = await boot()
    test.addSession("ses_a", "A")
    test.addSession("ses_b", "B")
    test.addSession("ses_c", "C")
    await test.rpc.connect({ sessionID: "ses_a", peerID: "ses_b" })
    await test.rpc.connect({ sessionID: "ses_b", peerID: "ses_c" })
    await test.tools.send.execute(
      { to: "ses_b", text: "task", kind: "task", task_id: "T1", msg_id: "msg_cross_task" },
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
    expect((test.storage.get("outbox/msg_cross_task") as any).status).toBe("delivered")
  })
})

describe("session lifecycle integrity", () => {
  it("keeps parent links intact when session removal fails", async () => {
    const test = await boot()
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
