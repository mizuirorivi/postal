import { describe, expect, it } from "bun:test"
import { createTask, findTasks, listTasks, readTask, updateTask } from "../tasks.js"

function fake() {
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
  }
  const lock = async <T>(_key: string, task: () => Promise<T> | T): Promise<T> => task()
  return { ctx, storage, lock }
}

describe("task state", () => {
  it("creates, reads, and updates a task independently of message ACK", async () => {
    const { ctx, lock } = fake()
    const task = await createTask(ctx, lock, {
      from: "ses_a",
      to: "ses_b",
      msgID: "msg_task",
      taskID: "T1",
    })
    expect(task.status).toBe("open")
    expect((await readTask(ctx, "ses_a", "T1"))?.status).toBe("open")

    const done = await updateTask(ctx, lock, "ses_a", "T1", "done", "finished")
    expect(done.status).toBe("done")
    expect(done.note).toBe("finished")
    expect((await listTasks(ctx, "ses_b"))[0]?.status).toBe("done")
    expect(await findTasks(ctx, "ses_b", "T1")).toHaveLength(1)
  })

  it("is idempotent for the same pair and rejects a conflicting task ID", async () => {
    const { ctx, lock } = fake()
    await createTask(ctx, lock, { from: "ses_a", to: "ses_b", msgID: "msg_1", taskID: "T1" })
    await createTask(ctx, lock, { from: "ses_a", to: "ses_b", msgID: "msg_1", taskID: "T1" })
    await expect(
      createTask(ctx, lock, { from: "ses_a", to: "ses_c", msgID: "msg_2", taskID: "T1" }),
    ).rejects.toThrow("already belongs")
  })
})
