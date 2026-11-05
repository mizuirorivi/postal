import { describe, expect, it } from "bun:test"
import {
  allowedOperations,
  ensureGrant,
  grantOperations,
  readSpawnFact,
  revokeOperations,
  writeSpawnFact,
} from "../grants.js"

function fake(options: Record<string, unknown> = {}) {
  const storage = new Map<string, unknown>()
  const ctx = {
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value)
      },
      remove: async (key: string) => {
        storage.delete(key)
      },
    },
    options,
  }
  const lock = async <T>(_key: string, task: () => Promise<T> | T): Promise<T> => task()
  return { ctx, storage, lock }
}

describe("relation grants", () => {
  it("materializes parent and child defaults from a spawn fact", async () => {
    const { ctx, lock } = fake()
    await writeSpawnFact(ctx, lock, "ses_b", "ses_a")
    expect((await readSpawnFact(ctx, "ses_b"))?.spawnedBy).toBe("ses_a")

    const parent = await ensureGrant(ctx, lock, "ses_a", "ses_b")
    expect(allowedOperations(parent!)).toEqual(["send", "task", "interrupt", "close", "history"])
    const child = await ensureGrant(ctx, lock, "ses_b", "ses_a")
    expect(allowedOperations(child!)).toEqual(["send"])
  })

  it("uses send-only defaults for pairs and persists revocations", async () => {
    const { ctx, storage, lock } = fake()
    storage.set("peers/ses_a", [{ id: "ses_b" }])
    storage.set("peers/ses_b", [{ id: "ses_a" }])
    const pair = await ensureGrant(ctx, lock, "ses_a", "ses_b")
    expect(allowedOperations(pair!)).toEqual(["send"])

    const granted = await grantOperations(ctx, lock, "ses_a", "ses_b", ["approve"], {
      approvalRequired: true,
    })
    expect(granted.operations.approve.allowed).toBe(true)
    expect(granted.operations.approve.approvalRequired).toBe(true)

    const revoked = await revokeOperations(ctx, lock, "ses_a", "ses_b", ["send"])
    expect(revoked?.operations.send.allowed).toBe(false)
    const again = await ensureGrant(ctx, lock, "ses_a", "ses_b")
    expect(again?.operations.send.allowed).toBe(false)
    expect(allowedOperations(again!)).not.toContain("send")
  })

  it("migrates legacy parent records and ancestor commands", async () => {
    const { ctx, storage, lock } = fake({ allowAncestorCommands: true })
    storage.set("parent/ses_b", { parentID: "ses_a", createdAt: 1 })
    storage.set("parent/ses_c", { parentID: "ses_b", createdAt: 2 })
    expect((await readSpawnFact(ctx, "ses_b"))?.spawnedBy).toBe("ses_a")
    const ancestor = await ensureGrant(ctx, lock, "ses_a", "ses_c")
    expect(allowedOperations(ancestor!)).toEqual(["interrupt", "close"])
  })

  it("rejects conflicting spawn facts and unknown relations", async () => {
    const { ctx, lock } = fake()
    await writeSpawnFact(ctx, lock, "ses_b", "ses_a")
    await expect(writeSpawnFact(ctx, lock, "ses_b", "ses_c")).rejects.toThrow("already recorded")
    await expect(grantOperations(ctx, lock, "ses_a", "ses_c", ["send"])).rejects.toThrow("no relation")
  })

  it("honors expiry", async () => {
    const { ctx, lock } = fake()
    await writeSpawnFact(ctx, lock, "ses_b", "ses_a")
    const granted = await grantOperations(ctx, lock, "ses_a", "ses_b", ["send"], {
      expiresAt: Date.now() - 1,
    })
    expect(allowedOperations(granted)).not.toContain("send")
  })
})
