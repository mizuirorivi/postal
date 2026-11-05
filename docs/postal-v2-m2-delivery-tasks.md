# Postal v2 M2 — delivery policy, task state, and request/assignment

- Status: design proposal, awaiting approval
- Scope: F-05..F-08
- Baseline: `a030a2b` (M1 complete, 142 tests / 447 assertions)

## 1. Goals

1. Make delivery policy explicit per relation: `interrupt` (default), `idle`,
   `inbox`.
2. Separate message state (delivered/read/acked) from task state
   (open/in_progress/done/cancelled).
3. Distinguish a collaborative `request` from a forced `assignment`.
4. Apply revocation to undelivered mail and queued deliveries.

## 2. Delivery policy (F-05)

### Modes

| Mode | Behavior | Core delivery |
| --- | --- | --- |
| `interrupt` | Wake the target immediately (current behavior, human default) | `steer` |
| `idle` | Steer only when the target's presence is `idle`; otherwise queue | `steer` / `queue` |
| `inbox` | Never wake; admit on the target's next turn | `queue` + `resume: false` |

- The policy is stored on the directed relation grant (`grant.delivery`).
- Default for new relations: `interrupt` (human decision).
- Existing grants migrate to `interrupt`; this preserves current steer behavior.
- A `postal_delivery({ to, mode })` tool updates the policy; the grantor must
  own the relation (spawn parent or self-send grant).
- `postal_relations` shows `DELIVERY`.

### Runtime mapping

`postOnly` gains `delivery?: "steer" | "queue"` and `resume?: boolean`.
Before prompting:

```ts
const mode = grant.delivery ?? "interrupt"
const route =
  mode === "inbox" ? { delivery: "queue", resume: false } :
  mode === "idle"
    ? (await readPresence(ctx, to))?.state === "idle"
      ? { delivery: "steer" }
      : { delivery: "queue", resume: false }
    : { delivery: "steer" }
```

- Spike result (OpenCode 2.2.5): `delivery: "queue"` with `resume: false`
  creates an inbox item, does not start a turn, and drains when a later steer
  prompt runs. This is the non-waking inbox contract.
- `interrupt` uses `steer`; `idle` uses `steer` only when presence is `idle`;
  `inbox` always uses `queue` + `resume: false`.
- System notices (watchdog, reparent) always use `interrupt` so control mail is
  not delayed.
- Idle uses TUI presence (30s TTL). Headless targets are `unknown`; `idle` mode
  queues them until they become visible.
- A separate receiver-inbox UI is out of scope; the host inbox holds queued
  messages and `postal_inbox` remains the sender outbox plus presence.

## 3. Message state vs task state (F-06)

### Message state (existing)

`outbox.status`: `pending`, `delivered`, `rejected`, `revoked`, `acked`,
`failed`; receipts add `admittedAt`/`authorizedBy`. ACK means the peer replied,
never that work is complete.

### Task state (new)

```ts
type TaskStatus = "open" | "in_progress" | "blocked" | "done" | "cancelled"

type TaskRecord = {
  taskID: string
  from: string
  to: string
  msgID: string
  status: TaskStatus
  createdAt: number
  updatedAt: number
  note?: string
}
```

- Key: `task/<taskID>` (taskID defaults to msgID if omitted).
- Index: `task/index` under the cross-process lock.
- Created when a `task`/`assignment` letter is sent; the receiver confirms the
  task record on admission (same taskID).
- `postal_task({ task_id, status, note? })` updates it. Allowed: the assigner
  (`from`), the assignee (`to`), or an `approve` holder.
- ACK, delivery, and rejection do not change task status.
- `postal_inbox`/`postal_status` show `TASK_STATUS` separately from message
  status; `postal_watchdog` scans open/in_progress tasks with unacked messages.
- `done`/`cancelled` stop watchdog nudges.

## 4. Request vs assignment (F-07)

Add envelope kinds:

- `request`: collaborative; requires the `send` grant; no forced execution.
- `assignment`: forced; requires the `task` grant.
- `task` remains accepted as a legacy alias for `assignment`.

Sender:

- `postal_send({ kind: "request" })` uses `send`.
- `postal_send({ kind: "assignment" | "task" })` uses `task`.
- Task records are created only for `assignment`/`task`, not `request`.

Receiver:

- `assignment` requires an active `task` grant from the sender.
- `request` requires an active `send` grant (already checked by the sender; the
  receiver re-checks the signature and grant for defense).
- The receipt records the kind; `request` does not create task state.

Defaults (from M1): parent→child includes both `send` and `task`; child→parent
includes `send` only. A child can therefore request parent work, but cannot
force an assignment on the parent.

## 5. Revocation propagation (F-08)

- `postal_revoke` (and grant changes that disable an operation) runs a sweep:
  - Pending/delayed outbox records for `from → to` whose operation is `send` or
    `task` become `revoked` with `lastError = "grant_revoked"`.
  - Queued/inbox deliveries that have not been admitted are dropped at the next
    drain if the current grant no longer allows the operation.
  - Open tasks created by a revoked assignment become `cancelled` (the assignee
    can still finish, but the watchdog stops nudging).
- `attemptOutbox` already re-checks grants; the sweep makes the state visible
  immediately instead of waiting for the next retry.
- Re-granting the operation allows `postal_resend` to retry a revoked record.

## 6. Migration and compatibility

- Existing grants gain `delivery: "interrupt"` on first read; no behavior change.
- Existing `kind: "task"` letters are treated as assignments.
- Existing task-less outbox records have no task state; `postal_task` can create
  one on demand.
- `allowAncestorCommands` migration remains M1-only; runtime uses grants.
- The host's `delivery: "queue"` contract must be verified in a spike; if the
  host rejects it, `inbox` falls back to a plugin hold queue.

## 7. Tests

- Delivery: interrupt → steer; inbox → queue; idle with idle presence → steer;
  idle with running/unknown → queue; relation policy persists and is shown.
- Task state: send assignment → open; ACK does not close; `postal_task
  in_progress/done` transitions; watchdog stops after done; cancelled assignment
  stops nudges.
- Request/assignment: request allowed with send only; assignment denied without
  task grant; parent assignment accepted; child assignment to parent denied.
- Revocation: pending outbox → revoked; queued delivery dropped; task cancelled;
  re-grant + resend works.
- Regression: 142 existing tests remain green.

## 8. Implementation split and estimate

1. `feat(delivery): add per-relation interrupt/idle/inbox policy` — grant field,
   resolver, tool, tests (~250 lines).
2. `feat(task): add task records separate from message ACK` — schema, tools,
   inbox/status/watchdog, tests (~300 lines).
3. `feat(mail): add request and assignment kinds` — envelope kinds, sender/
   receiver grant checks, tests (~200 lines).
4. `feat(grants): propagate revocation to pending deliveries and tasks` — sweep,
   queue filtering, tests (~150 lines).

M2 total: best 3–5 days / worst 8–12 days. The delivery resolver and task store
are new; the host `queue` contract is the main unknown.

## 9. Open questions

- Confirm that `delivery: "queue"` does not wake a session and is visible on the
  next turn in OpenCode 2.2.5.
- Task status vocabulary and who may set `done` (assignee, assigner, both).
- Whether `postal_inbox` should show receiver-side inbox entries or only the
  sender outbox plus peer presence.
- Whether a revoked assignment should cancel the task or leave it open for the
  assignee to finish.
