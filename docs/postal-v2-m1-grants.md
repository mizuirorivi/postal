# Postal v2 M1 — relations, grants, and authority

- Status: design proposal, awaiting human approval before implementation
- Scope: F-01..F-04, with the F-05/F-10 decisions applied
- Baseline: `41eb475` (M0 complete, 128 tests / 388 assertions)

## 1. Goals

1. Make authority per operation instead of binary parent/ancestor.
2. Record the spawn fact separately from management authority.
3. Allow collaboration and supervision in the same relation graph without
   cycles in authority.
4. Keep the existing behavior usable through an explicit migration.

## 2. Data model

### Spawn fact

```ts
type SpawnRecord = {
  childID: string
  spawnedBy: string
  spawnedAt: number
  location?: string
}
```

- Key: `spawn/<childID>`.
- `parent/<childID>` remains a compatibility mirror for the current tree and
  Phase 1 close/interrupt paths until they are migrated.
- The spawn fact never grants authority by itself.

### Relation grant

```ts
type Operation =
  | "send"      // letters, status, verify, question
  | "task"      // forced assignment
  | "spawn"     // create a child under the target
  | "interrupt" // stop the target's current turn
  | "close"     // delete the target
  | "history"   // read the target's postal log / status
  | "approve"   // approve an operation bound to the target

type GrantRule = {
  allowed: boolean
  approvalRequired: boolean
  expiresAt?: number
  constraints?: { maxKind?: string; maxRally?: number }
}

type RelationGrant = {
  from: string
  to: string
  operations: Record<Operation, GrantRule>
  initialized: true
  createdAt: number
  updatedAt: number
  revokedAt?: number
}
```

- Key: `grants/<from>/<to>`.
- Index: `grants/index` (array of `from/to` keys) for listing without a storage
  scan; `addGrantIndex` / `removeGrantIndex` use the cross-process lock.
- `send` is a communication edge and may be bidirectional.
- `task`, `spawn`, `interrupt`, `close`, and `approve` are authority edges and
  must form a DAG.

### Operation registry and enforceable flag (F-10)

```ts
type Enforceable = "postal" | "host" | "none"

type OperationSpec = {
  id: Operation | "host.shell" | "host.edit" | "host.deploy"
  label: string
  enforceable: Enforceable
  defaultApprovalRequired: boolean
}
```

| Operation | Enforceable | Default approval |
| --- | --- | --- |
| `send` | postal | off |
| `task` | postal | off |
| `spawn` | postal | on |
| `interrupt` | postal | on |
| `close` | postal | on |
| `history` | postal | off |
| `approve` | postal | on |
| `host.shell` | host (or none without integration) | on |
| `host.edit` | host (or none without integration) | on |
| `host.deploy` | host (or none without integration) | on |

- Every operation is represented in the approval framework.
- If `enforceable === "none"`, the UI shows
  `approval required but not enforceable by Postal`.
- Host integration uses `ctx.permission.assert` / a guarded tool registration.
  Postal never claims to block a shell command it cannot see.

## 3. Default grants and migration

### Defaults on spawn

- Parent → child: `send`, `task`, `interrupt`, `close`, `history`.
- Child → parent: `send` (the consultation path).
- `spawn` and `approve`: not granted by default.
- This satisfies "A supervises B while B consults A" without making ancestry a
  full-authority shortcut.

### Defaults on pair (non-parent)

- Both directions: `send` only.
- Existing paired peers keep working without gaining task/close/interrupt.

### Legacy `allowAncestorCommands`

- Ancestor → descendant: `interrupt` and `close` only (never `task`, `spawn`,
  or `approve`).
- This preserves the old command behavior without making ancestry a full grant.

### Migration rules

- On first relation access, if `grants/<from>/<to>` is absent:
  1. Backfill `spawn/<child>` from `parent/<child>`.
  2. Materialize parent/child defaults when a spawn fact exists.
  3. Materialize `send` from an existing pair.
  4. Materialize ancestor `interrupt`/`close` when the legacy option is on.
- `initialized: true` is written with the record.
- Revocation sets `allowed: false` and `revokedAt`, never deletes the record, so
  migration cannot re-add a revoked grant.
- The migration is idempotent and uses the cross-process lock on
  `grants/<from>/<to>`.

## 4. Cycle detection

### Parent/spawn fact

Before writing `spawn/<child>` or `parent/<child>`:

```
wouldCreateParentCycle(child, parent):
  current = parent
  for depth in 0..63:
    if current == child: return true
    current = readParent(current)?.parentID
    if !current: return false
  return true
```

Reject with `postal: relation cycle rejected`.

### Authority grants

- Build the authority graph from `grants/index` for
  `task`, `spawn`, `interrupt`, `close`, `approve`.
- Before adding/updating an authority grant `from → to`, DFS from `to`:
  - If `from` is reachable, reject (`authority cycle rejected`).
  - Depth limit 64, visited set.
- `send` grants are excluded from the cycle check, so A ↔ B consultation is
  allowed.
- A self-grant for `send` is allowed; authority self-grants are rejected.
- Expired grants are ignored in the graph.

## 5. Tool API

### `postal_grant`

Input: `to`, `operations` (array or object), optional `approvalRequired`,
`expiresAt`, `constraints`.

- The caller may grant a relation where they are the `from` side, or where they
  are the spawn parent/owner of `from` and hold `approve`.
- A child cannot grant itself authority over its parent.
- Reject authority cycles; allow bidirectional `send`.

### `postal_revoke`

Input: `to`, optional `operations` (omit = all).

- The same authority as `postal_grant`.
- Sets `allowed: false`, `revokedAt`, keeps the record as a tombstone.
- Pending outbox records that no longer satisfy `send`/`task` are marked
  `revoked` at the next retry/reconcile (F-08 groundwork).

### `postal_relations`

Input: optional `sessionID`.

Output table: `DIRECTION PEER OPERATIONS ENFORCEABLE APPROVAL EXPIRES`.
Shows incoming and outgoing grants, including tombstones as `revoked`.

### Enforcement points

| Tool/action | Grant |
| --- | --- |
| `postal_send` (letter/status/verify/question) | `send` |
| `postal_send` kind `task` / `assignment` | `task` |
| `postal_spawn` (delegated child under target) | `spawn` |
| `postal_interrupt` | `interrupt` |
| `postal_close` | `close` |
| `postal_log`, cross-session `postal_status`/`inbox` | `history` or self |
| `postal_approve`/`postal_reject` (M3) | `approve` |

- Self-inspection stays allowed.
- `postal_directory` remains discovery-only; it grants nothing.
- The existing `allowAncestorCommands` flag is read only by migration; runtime
  checks use grants.

## 6. Audit

- `grant-audit/<timestamp>_<random>` records
  `{ actor, action, from, to, operationsBefore, operationsAfter, at }`.
- `postal_relations` exposes current state; M3 adds an audit query and approval
  audit.
- The audit record is written under the same cross-process lock as the grant.

## 7. Tests

- Spawn defaults: parent can task/interrupt/close/history; child can send to
  parent; child cannot task parent.
- Pair defaults: both directions send; no task/close.
- `allowAncestorCommands` migration: ancestor gets interrupt/close, not task.
- Revoke `send`: subsequent send rejected; an undelivered record becomes
  `revoked` at retry.
- Cycle: A→B task grant then B→A task grant rejected; A↔B send allowed.
- Parent cycle: spawn/writeParent rejects A→B→A.
- Grant authorization: child cannot self-grant over parent; parent can grant.
- Required scenario 1: A supervises B, B consults A; both directions verified.
- Required scenario 2 (M3): supervision does not bypass approval.

## 8. Implementation split

1. `feat(grants): add relation grants and spawn facts` — schema, index,
   migration, `postal_grant`/`postal_revoke`/`postal_relations`, tests.
2. `feat(grants): enforce operation grants` — send/task/spawn/interrupt/close/
   history checks, tests.
3. `feat(grants): reject authority cycles` — parent and grant DAG checks, tests.
4. `feat(tree): show spawn facts and grants` — tree annotations (after M1).
Each commit under 500 lines.

## 9. Estimate

- Store, migration, tools: best 8–12h / worst 3–4 days.
- Enforcement: best 6–10h / worst 2–3 days.
- Cycles and migration tests: best 4–6h / worst 1–2 days.
- M1 total: best 2–4 days / worst 6–9 days.
- Reuse: M0's cross-process locks and the existing `parent/` records reduce
  risk; grants and approval semantics are new, so the upper bound stays.
