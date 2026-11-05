import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LockTimeoutError, openLockStore } from "../state.js"

function tempDb(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "postal-lock-"))
  return { dir, path: join(dir, "state.db") }
}

describe("cross-process lock store", () => {
  it("serializes a lock and times out a waiter", async () => {
    const { path } = tempDb()
    const store = await openLockStore(path)
    expect(store).toBeDefined()

    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const held = store!.withLock("hold", async () => {
      await gate
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await expect(store!.withLock("hold", async () => {}, { waitMs: 80 })).rejects.toBeInstanceOf(LockTimeoutError)
    release()
    await held

    let entered = false
    await store!.withLock("hold", async () => {
      entered = true
    })
    expect(entered).toBe(true)
  })

  it("recovers an expired lease", async () => {
    const { path } = tempDb()
    const store = await openLockStore(path)
    const { Database } = await import("bun:sqlite")
    const db = new Database(path, { create: true })
    db.prepare("INSERT INTO locks(key, owner, expires_at) VALUES(?, ?, ?)").run("stale", "dead", Date.now() - 1_000)
    db.close()

    let entered = false
    await store!.withLock("stale", async () => {
      entered = true
    }, { waitMs: 500 })
    expect(entered).toBe(true)
  })

  it("keeps two Bun processes out of the same critical section", async () => {
    const { dir, path } = tempDb()
    const marker = join(dir, "marker")
    writeFileSync(marker, "")
    const worker = join(dir, "worker.ts")
    const statePath = join(import.meta.dir, "..", "state.ts")
    const newline = "String.fromCharCode(10)"
    writeFileSync(
      worker,
      [
        `import { openLockStore } from ${JSON.stringify(statePath)}`,
        "const [db, key, marker, hold] = process.argv.slice(2)",
        "const store = await openLockStore(db)",
        'if (!store) throw new Error("lock store unavailable")',
        "await store.withLock(key, async () => {",
        '  const fs = await import("node:fs")',
        `  fs.appendFileSync(marker, "start" + ${newline})`,
        "  await new Promise((resolve) => setTimeout(resolve, Number(hold)))",
        `  fs.appendFileSync(marker, "end" + ${newline})`,
        "})",
      ].join("\n"),
    )

    const spawn = (hold: number) => Bun.spawn([process.execPath, worker, path, "shared", marker, String(hold)])
    const first = spawn(150)
    const second = spawn(150)
    await Promise.all([first.exited, second.exited])

    const lines = readFileSync(marker, "utf8").trim().split("\n")
    expect(lines).toEqual(["start", "end", "start", "end"])
  })
})
