/**
 * Cross-process lock store for Postal.
 *
 * The in-process `serialized()` helper cannot coordinate two OpenCode server
 * processes. This store uses SQLite (Bun's built-in `bun:sqlite`) with WAL and
 * short `BEGIN IMMEDIATE` transactions to lease a named lock across processes.
 *
 * The store is optional: if `bun:sqlite` is unavailable, `openLockStore`
 * returns `undefined` and callers fall back to the in-process mutex.
 */
import { randomBytes } from "node:crypto"
import { chmodSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const DEFAULT_TTL_MS = 60_000
const DEFAULT_MAX_WAIT_MS = 5_000
const RETRY_MIN_MS = 25
const RETRY_MAX_MS = 75

export class LockTimeoutError extends Error {
  constructor(public readonly key: string) {
    super(`postal: lock timeout: ${key}`)
    this.name = "LockTimeoutError"
  }
}

type DatabaseLike = {
  exec(sql: string): void
  prepare(sql: string): { run(...values: unknown[]): { changes: number } }
  transaction<T>(callback: () => T): () => T
  close(): void
}

export type LockStoreOptions = {
  ttlMs?: number
  maxWaitMs?: number
}

export type LockOptions = {
  ttlMs?: number
  waitMs?: number
}

/** Use POSTAL_STATE_PATH in tests or for an explicit state location. */
export function defaultLockStorePath(): string {
  const explicit = process.env.POSTAL_STATE_PATH
  if (explicit) return explicit
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(base, "opencode", "postal", "state.db")
}

export class LockStore {
  private readonly db: DatabaseLike
  private readonly ttlMs: number
  private readonly maxWaitMs: number

  constructor(db: DatabaseLike, options: LockStoreOptions = {}) {
    this.db = db
    this.ttlMs = clamp(options.ttlMs ?? DEFAULT_TTL_MS, 1_000, 10 * 60_000)
    this.maxWaitMs = clamp(options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS, 0, 60_000)
    // busy_timeout must be set before any write PRAGMA so a concurrent opener
    // waits instead of failing with SQLITE_BUSY.
    this.db.exec("PRAGMA busy_timeout=5000")
    try {
      this.db.exec("PRAGMA journal_mode=WAL")
    } catch {
      // Rollback journal is still safe; WAL is an optimization.
    }
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS locks (" +
        "key TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL)",
    )
  }

  private tryAcquire(key: string, owner: string, ttlMs: number): boolean {
    const now = Date.now()
    const acquire = this.db.transaction(() => {
      const result = this.db
        .prepare(
          "INSERT INTO locks(key, owner, expires_at) VALUES(?, ?, ?) " +
            "ON CONFLICT(key) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at " +
            "WHERE locks.expires_at <= ?",
        )
        .run(key, owner, now + ttlMs, now)
      return result.changes > 0
    })
    return acquire()
  }

  private heartbeat(key: string, owner: string, ttlMs: number): void {
    this.db.prepare("UPDATE locks SET expires_at=? WHERE key=? AND owner=?").run(Date.now() + ttlMs, key, owner)
  }

  private release(key: string, owner: string): void {
    this.db.prepare("DELETE FROM locks WHERE key=? AND owner=?").run(key, owner)
  }

  async withLock<T>(key: string, task: () => Promise<T> | T, options: LockOptions = {}): Promise<T> {
    const ttlMs = clamp(options.ttlMs ?? this.ttlMs, 1_000, 10 * 60_000)
    const waitMs = clamp(options.waitMs ?? this.maxWaitMs, 0, 60_000)
    const owner = randomBytes(12).toString("hex")
    const deadline = Date.now() + waitMs
    while (!this.tryAcquire(key, owner, ttlMs)) {
      if (Date.now() >= deadline) throw new LockTimeoutError(key)
      const delay = RETRY_MIN_MS + Math.floor(Math.random() * (RETRY_MAX_MS - RETRY_MIN_MS))
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
    const heartbeat = setInterval(() => {
      try {
        this.heartbeat(key, owner, ttlMs)
      } catch {
        // A failed heartbeat lets the lease expire; the task still finishes.
      }
    }, Math.max(1_000, Math.floor(ttlMs / 3)))
    heartbeat.unref?.()
    try {
      return await task()
    } finally {
      clearInterval(heartbeat)
      try {
        this.release(key, owner)
      } catch {
        // The lease expires on its own if the process dies.
      }
    }
  }

  close(): void {
    this.db.close()
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.floor(value)))
}

const stores = new Map<string, LockStore>()

/** Open (or reuse) the lock store; returns undefined when bun:sqlite is absent. */
export async function openLockStore(path = defaultLockStorePath(), options: LockStoreOptions = {}): Promise<LockStore | undefined> {
  const existing = stores.get(path)
  if (existing) return existing
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const { Database } = await import("bun:sqlite")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const db = new Database(path, { create: true })
      try {
        chmodSync(path, 0o600)
      } catch {
        // Best effort; Windows and some filesystems ignore chmod.
      }
      const store = new LockStore(db, options)
      stores.set(path, store)
      return store
    } catch {
      if (attempt === 2) return undefined
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  return undefined
}

export function closeLockStore(path = defaultLockStorePath()): void {
  const store = stores.get(path)
  if (!store) return
  stores.delete(path)
  store.close()
}
