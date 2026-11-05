# Postal v2 M3 — approvals and audit

- Status: implemented (M3); awaiting final review and push approval
- Scope: F-09..F-11
- Baseline: `818d12b` (M2 complete, 151 tests / 483 assertions)

## 1. Goals

1. Bind an approval to a concrete operation, resource, proposer, approver,
   executor, hash, and expiry.
2. Represent every operation in the approval framework, while distinguishing
   operations Postal can enforce from advisory approvals.
3. Audit grant/revoke, delivery policy, task, and approval changes.

## 2. Approval record (F-09)

```ts
type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "consumed"

type ApprovalRecord = {
  approvalID: string
  operation: string          // "close", "interrupt", "spawn", "host.shell", ...
  resource: string           // session ID, path, command, deployment target
  resourceHash: string       // sha256 of canonical operation+resource+parameters
  proposer: string
  approver?: string
  executor?: string
  requestedAt: number
  expiresAt: number
  status: ApprovalStatus
  reason?: string
  consumedAt?: number
}
```

- Key: `approval/<approvalID>`; index `approval/index`.
- `resourceHash` is computed over a canonical payload:
  `operation`, `resource`, and sorted `parameters`. It prevents approving one
  target and executing another.
- One approval authorizes one execution; successful enforcement marks it
  `consumed`. Expired/rejected/consumed approvals cannot be reused.
- `proposer`, `approver`, and `executor` are session IDs. The default policy
  requires `proposer !== approver`; executor may equal proposer unless the
  operation policy says otherwise.

## 3. Operation registry and enforceability (F-10)

Extend the M1 operation registry:

| Operation | Enforceable | Default approval |
| --- | --- | --- |
| `send` | postal | off |
| `task` | postal | off |
| `spawn` | postal | on |
| `interrupt` | postal | on |
| `close` | postal | on |
| `history` | postal | off |
| `approve` | postal | on |
| `host.shell` | host / none | on |
| `host.edit` | host / none | on |
| `host.deploy` | host / none | on |

- `postal` operations are enforced by Postal before the action.
- `host` operations are enforced only through an integration:
  `ctx.permission.assert` or a guarded tool calls
  `postal_consume_approval` before executing.
- `none` operations display
  `approval required but not enforceable by Postal`; Postal records the
  decision but cannot stop the action.
- `postal_relations` already shows `ENFORCEABLE` and `APPROVAL_REQUIRED`; M3
  adds the external operation rows and the non-enforceable warning.

## 4. Approval flow

### Request

`postal_request_approval({ operation, resource, parameters, expiresAt? })`

- Creates a `pending` approval with `proposer = caller`.
- The resource hash is computed immediately.
- Default expiry: 15 minutes (clamp 1 minute–24 hours).
- A request is audited.

### Approve / reject

`postal_approve({ approval_id, executor? })`

- The approver must hold the `approve` grant on the proposer or be the
  proposer's spawn parent/owner (M1 authority).
- `approver !== proposer` by default.
- Sets `status=approved`, `approver`, optional `executor`, and audits the
  decision.

`postal_reject({ approval_id, reason? })`

- Same authority; sets `status=rejected` and records the reason.

### Consume / enforce

`postal_consume_approval({ approval_id, executor })`

- Validates status `approved`, non-expired, hash match, and executor match.
- Marks `consumed` and writes an audit record. It is idempotent only before the
  first consume.

Enforcement points:

| Action | Approval check |
| --- | --- |
| `postal_close` | if the relation's `close` rule has `approvalRequired`, require a matching consumed/approved approval |
| `postal_interrupt` | same for `interrupt` |
| `postal_spawn` | same for delegated spawn |
| `postal_send` assignment | optional; default off, configurable in M3 |
| external host operation | guarded tool consumes first; Postal cannot enforce by itself |

- The approval and the action must use the same `operation`, `resource`, and
  normalized parameters. A mismatch fails closed.
- Failed validation does not consume the approval.

## 5. Audit (F-11)

```ts
type AuditRecord = {
  auditID: string
  at: number
  actor: string
  action: string          // grant, revoke, delivery, task, approval, settings
  target: string
  before?: unknown
  after?: unknown
  note?: string
}
```

- Key: `audit/<timestamp>_<random>`; index `audit/index`.
- Written for:
  - grant/revoke and delivery-mode changes;
  - task status changes;
  - approval request/approve/reject/consume/expire;
  - configuration changes that affect grants or approvals.
- `postal_audit({ limit?, action?, target? })` reads recent records. Access:
  self, parent/ancestor with `history`, or an `approve` holder.
- Audit records are append-only from the plugin's perspective; cleanup follows
  `outboxTtlDays` (or a separate audit TTL).

## 6. Required scenario 2

> A supervises B, but A's supervision does not bypass a production approval.

1. A holds `interrupt`/`close`/`task` on B but the operation policy marks
   `host.deploy` or `close` as approval-required.
2. A proposes the operation with the target and parameters.
3. An approver other than A (holding `approve`) approves.
4. A (or the configured executor) consumes the approval and executes.
5. A cannot use ancestry as an approval; `postal_close` without a matching
   approval fails closed.
6. All four steps appear in `postal_audit`.

## 7. Tests

- Approval hash binds operation/resource/parameters; changing any field fails.
- Expiry rejects; rejected/consumed approvals cannot be reused.
- Proposer cannot self-approve by default; an `approve` holder can.
- `postal_close` with `approvalRequired` fails without approval and succeeds
  with a consumed approval.
- Non-enforceable `host.*` rows display `approval required but not enforceable`.
- Audit records exist for grant, revoke, task, approval, and consume.
- Required scenario 2 passes end to end.
- Regression: 151 existing tests remain green.

## 8. Implementation split and estimate

1. `feat(approval): add approval records and request/approve/reject tools` —
   schema, hash, expiry, audit hook, tests (~300 lines).
2. `feat(approval): enforce approvals for postal operations` — close/interrupt/
   spawn checks, consume, tests (~200 lines).
3. `feat(audit): add grant/approval/task audit and postal_audit` — store,
   query, tests (~200 lines).
4. `docs`: README, skill, UIGraph.

M3 total: best 2–4 days / worst 8–12 days. The hash/canonicalization and
proposer/approver separation are the main correctness risks; the store reuses
M1/M2 lock and index patterns.

## 9. Open questions

- Default approval-required set: close/interrupt/spawn on, send/task/history off
  (proposed). The human said all operations are in scope; this keeps the
  framework global without making every letter require approval.
- Can the proposer approve when there is no other approver? Default no; add an
  explicit `allowSelfApproval` policy per operation/relation.
- `host.*` operation names and parameters must be registered by the host
  integration; Postal should not invent shell/edit semantics.

## 10. Implementation status

- `8fd2a9c` adds `approvals.ts` (canonical sha256, expiry, proposer/approver/
  executor, one-shot consume) and `audit.ts` (append-only decision records).
- `d802d0e` registers `postal_request_approval`, `postal_approve`,
  `postal_reject`, `postal_consume_approval`, `postal_approvals`, and
  `postal_audit`; grant/revoke/delivery/task/approval transitions write audit
  records, and audit failures never block the operation. `postal_close` and
  `postal_interrupt` accept `approval_id` and consume a matching approval when
  the relation rule has `approvalRequired`.
- `90b7319` covers hash/target mismatch, expiry, one-shot consume, non-enforceable
  `host.deploy`, audit decisions, and the required scenario (A supervises B
  while B consults A, but A's close needs an approval from A's parent).
- `enforceApprovals: false` keeps advisory mode for deployments that want the
  record without blocking close/interrupt.
- A root session (no current parent or spawn owner) may approve its own request;
  without this exception a manual root could never satisfy an approval-gated
  close/interrupt. Spawned sessions still require a parent/owner or an
  `approve` grant holder, and `postal_approvals` shows pending requests the
  caller may decide.
- Full suite after M3: **178 pass / 0 fail / 588 assertions**.
- Residual: `host.shell` / `host.edit` / `host.deploy` have no guarded-tool
  integration in this repository; Postal records and displays them as
  `approval required but not enforceable by Postal`.

