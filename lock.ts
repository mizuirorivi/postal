/**
 * Process-local per-key serialization for async tasks.
 *
 * Used by the rally counter so concurrent sends in the same conversation
 * cannot lose an increment through a read-modify-write race.
 */

export function serialized<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  const next = previous.then(task, task)
  locks.set(key, next)
  void next
    .finally(() => {
      if (locks.get(key) === next) locks.delete(key)
    })
    .catch(() => {})
  return next
}
