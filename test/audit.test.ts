import { describe, expect, it } from "bun:test"
import { appendAudit, cleanupAudit, listAudit } from "../audit.js"

function auditContext() {
  const storage = new Map<string, unknown>()
  return {
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value)
      },
      remove: async (key: string) => {
        storage.delete(key)
      },
    },
  }
}

const lock = async <T>(_key: string, task: () => Promise<T> | T): Promise<T> => task()

describe("audit", () => {
  it("appends and lists newest first", async () => {
    const ctx = auditContext()
    await appendAudit(ctx, lock, { actor: "ses_a", action: "grant", target: "ses_b", at: 1000 })
    await appendAudit(ctx, lock, { actor: "ses_a", action: "revoke", target: "ses_b", at: 2000 })

    const rows = await listAudit(ctx)
    expect(rows).toHaveLength(2)
    expect(rows[0]?.action).toBe("revoke")
    expect(rows[1]?.action).toBe("grant")
  })

  it("removes records outside the retention window", async () => {
    const ctx = auditContext()
    const old = Date.now() - 10 * 24 * 60 * 60 * 1000
    await appendAudit(ctx, lock, { actor: "ses_a", action: "grant", target: "ses_b", at: old })
    await appendAudit(ctx, lock, { actor: "ses_a", action: "task", target: "T1" })

    expect(await cleanupAudit(ctx, lock, 7)).toBe(1)
    const rows = await listAudit(ctx)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.action).toBe("task")
  })
})
