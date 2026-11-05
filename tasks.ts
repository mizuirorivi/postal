/**
 * Postal v2 task state.
 *
 * Message state (delivered/acked) is separate from work state. A task is
 * created for an assignment/task letter and is closed only by postal_task or a
 * revocation sweep.
 */

export const TASK_STATUSES = ["open", "in_progress", "blocked", "done", "cancelled"] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export type TaskRecord = {
  taskID: string
  from: string
  to: string
  msgID: string
  status: TaskStatus
  createdAt: number
  updatedAt: number
  note?: string
}

export type TaskContext = {
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    remove(key: string): Promise<void>
  }
}

export type Lock = <T>(key: string, task: () => Promise<T> | T) => Promise<T>

export class TaskError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TaskError"
  }
}

const TASK_INDEX = "task/index"

export function taskKey(from: string, taskID: string): string {
  return `task/${from}/${taskID}`
}

export function isTerminalTask(status: TaskStatus): boolean {
  return status === "done" || status === "cancelled"
}

export async function createTask(
  ctx: TaskContext,
  lock: Lock,
  input: { from: string; to: string; msgID: string; taskID: string },
): Promise<TaskRecord> {
  if (!input.taskID) throw new TaskError("task_id is required")
  const key = taskKey(input.from, input.taskID)
  return lock(key, async () => {
    const existing = await readTask(ctx, input.from, input.taskID)
    if (existing) {
      if (existing.to !== input.to) {
        throw new TaskError(`task ${input.taskID} already belongs to ${existing.to}`)
      }
      return existing
    }
    const now = Date.now()
    const record: TaskRecord = {
      taskID: input.taskID,
      from: input.from,
      to: input.to,
      msgID: input.msgID,
      status: "open",
      createdAt: now,
      updatedAt: now,
    }
    await ctx.storage.set(key, record)
    await addTaskIndex(ctx, lock, input.from, input.taskID)
    return record
  })
}

export async function readTask(
  ctx: TaskContext,
  from: string,
  taskID: string,
): Promise<TaskRecord | undefined> {
  const value = await ctx.storage.get(taskKey(from, taskID))
  if (!value || typeof value !== "object") return undefined
  return normalizeTask(value as Partial<TaskRecord>, from, taskID)
}

export async function listTasks(ctx: TaskContext, sessionID?: string): Promise<TaskRecord[]> {
  const index = await readTaskIndex(ctx)
  const tasks = (await Promise.all(index.map((entry) => readTaskEntry(ctx, entry)))).filter(
    (task): task is TaskRecord => Boolean(task),
  )
  if (!sessionID) return tasks
  return tasks.filter((task) => task.from === sessionID || task.to === sessionID)
}

export async function findTasks(
  ctx: TaskContext,
  sessionID: string,
  taskID: string,
): Promise<TaskRecord[]> {
  return (await listTasks(ctx, sessionID)).filter((task) => task.taskID === taskID)
}

export async function updateTask(
  ctx: TaskContext,
  lock: Lock,
  from: string,
  taskID: string,
  status: TaskStatus,
  note?: string,
): Promise<TaskRecord> {
  if (!TASK_STATUSES.includes(status)) throw new TaskError(`unknown task status: ${status}`)
  return lock(taskKey(from, taskID), async () => {
    const existing = await readTask(ctx, from, taskID)
    if (!existing) throw new TaskError(`task not found: ${taskID}`)
    existing.status = status
    existing.updatedAt = Date.now()
    if (typeof note === "string") existing.note = note.slice(0, 2000)
    await ctx.storage.set(taskKey(from, taskID), existing)
    return existing
  })
}

async function addTaskIndex(ctx: TaskContext, lock: Lock, from: string, taskID: string): Promise<void> {
  await lock("task/index", async () => {
    const index = await readTaskIndex(ctx)
    const entry = `${from}/${taskID}`
    if (!index.includes(entry)) {
      index.push(entry)
      await ctx.storage.set(TASK_INDEX, index)
    }
  })
}

async function readTaskIndex(ctx: TaskContext): Promise<string[]> {
  const value = await ctx.storage.get(TASK_INDEX)
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

async function readTaskEntry(ctx: TaskContext, entry: string): Promise<TaskRecord | undefined> {
  const slash = entry.indexOf("/")
  if (slash <= 0 || slash === entry.length - 1) return undefined
  return readTask(ctx, entry.slice(0, slash), entry.slice(slash + 1))
}

function normalizeTask(record: Partial<TaskRecord>, from: string, taskID: string): TaskRecord {
  return {
    taskID,
    from,
    to: typeof record.to === "string" ? record.to : "",
    msgID: typeof record.msgID === "string" ? record.msgID : "",
    status: TASK_STATUSES.includes(record.status as TaskStatus)
      ? (record.status as TaskStatus)
      : "open",
    createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
    ...(typeof record.note === "string" ? { note: record.note } : {}),
  }
}
