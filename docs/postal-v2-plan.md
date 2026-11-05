# Postal v2 — requirements analysis and staged plan

- Status: proposal, awaiting human approval
- Baseline: Phase 1 `28b7c65` plus Phase 2 spike/lock work (`22c51ac`)
- Date: 2026-11-05

## 1. Current-state analysis

Legend: ✅ implemented, ◐ partial, ❌ missing.

| ID | Requirement | State | Evidence / gap |
| --- | --- | --- | --- |
| F-01 | Per-operation relation grants (send/task/spawn/interrupt/close/history/approve) | ◐ | `parent/` + `allowAncestorCommands` is binary. `postal_interrupt`/`postal_close` check parent/ancestor; `postal_send`/task have no per-operation grant. |
| F-02 | Collaboration, supervision, and approval separation in one environment | ◐ | Pairing is bidirectional; parent/ancestor is the only authority model; there is no approval role. |
| F-03 | Record spawn fact separately from management authority | ◐ | `parent/<id>` is both the spawn fact and the authority source. |
| F-04 | Bidirectional requests, no cycles, ancestor ≠ full authority | ◐ | Pairs are bidirectional and task letters are parent/ancestor-only. `writeParent` has no cycle guard; ancestors implicitly gain close/interrupt when `allowAncestorCommands` is on. |
| F-05 | Delivery policy (inbox / start when idle / interrupt) | ◐ | Every delivery is `steer`; `queueOnLimit` delays only for the rally window. No per-relation policy. |
| F-06 | Separate mail state from task state | ◐ | Outbox has `delivered`/`acked`/`rejected`; there is no task record (`open`/`in_progress`/`done`). |
| F-07 | Distinguish collaborative request from forced assignment | ◐ | `kind: "task"` is the only assignment form; no collaborative request type. |
| F-08 | Revocation/permission changes apply to undelivered mail | ❌ | Outbox/hold queues are not filtered by current grants. |
| F-09 | Approval tied to a concrete operation (proposer/approver/executor, hash, expiry) | ❌ | No approval record or workflow. |
| F-10 | Only enforceable operations marked approval-required | ❌ | No policy surface. |
| F-11 | Auditable settings and decisions | ◐ | `postal_log` and receipts exist; grants/approvals/settings changes are not audited. |
| R-01/P0 | Reject delivery after disconnect | ❌ | `postal_send` with explicit `to` validates only `session.get`; it does not require an active pair. |
| R-02/P0 | Do not infer a recipient from lookup results | ◐ | Without `to`, `postal_send` uses `peerStatus` live peers; a live but unpaired session can be selected. |
| R-03/P0 | Receiver-side duplicate rejection | ❌ | Only the sender writes `msg/<from>/<id>`; the prompt hook does not check a seen cache. |
| R-04/P0 | Consistent concurrent sends with the same ID | ◐ | The sender-scoped `msg/`/`outbox/` keys and dispatch cross-process lock landed at `22c51ac`; receiver-side behavior and cross-process tests are still missing. |
| R-05/P1 | Serialize shared-record updates | ◐ | Claims/outbox use SQLite locks; pair/parent/children/HMAC updates are still read-modify-write. |
| R-06/P1 | Apply a delivery cap to resends | ❌ | `postal_resend` resets `attempts` and has no lifetime cap. |

## 2. R-01..R-06 design

### R-01 — Disconnected delivery is rejected

- `postal_send`/`broadcast` require `readPeers(from)` to contain the target, unless
  `allowUnpaired` is explicitly passed (default false).
- Check the pair before writing the outbox record; pending records that target a
  disconnected peer fail with `not_paired` on the next attempt.
- `disconnect` remains the revocation point. Add tests: unpaired reject, paired
  success, disconnect-then-send reject, pending-record failure.
- Cross-location explicit sends now require pairing; add a `postal_pair` tool or
  document the Ctrl+P flow.

### R-02 — No recipient inference

- With `to` omitted, choose only from `readPeers(from)` (paired peers), not
  `peerStatus` live sessions and not `postal_directory` results.
- Exactly one paired peer is required; zero or multiple returns an error listing
  the paired peers.
- Add a test where a live, unpaired session exists and is not selected.

### R-03 — Receiver-side deduplication

- Add a `seen` store keyed by `(from, to, msgID)` with a TTL (default 24h).
- Verify the signature first, then check/insert `seen` atomically. A duplicate
  clears the body with `reason: "duplicate"` and does not write a receipt.
- Use SQLite `INSERT OR IGNORE` or a KV record with a cross-process lock.
- Sender-side `msg/` markers stay for idempotent sends; receiver-side `seen` is
  the replay boundary.

### R-04 — Same-ID concurrency

- Same sender + same `msgID`: one record; the dispatch cross-process lock and the
  duplicate check already serialize this. Add a cross-process test.
- Different senders + same `msgID`: distinct records (sender-scoped keys).
- Receiver: `seen` rejects the second delivery even if the sender is buggy.
- Define the result: `duplicate` for the second send, no second prompt.

### R-05 — Shared-record serialization

- Apply `crossProcessLock` to `pair`/`disconnect` (sorted pair key),
  `writeParent`/`removeParent` (child key), and `ensureHmacRecord`/`postal_rekey`
  (pair key).
- Presence writes stay last-write-wins (TUI telemetry).
- Add concurrent pair/close/key-rotation tests.

### R-06 — Resend cap

- Add `resendCount` and a lifetime `maxResends` (default 5) to OutboxRecord.
- `postal_resend` increments and refuses beyond the cap; a new message ID is
  required.
- Tests: 5 resends allowed, 6th refused, a new ID works.

## 3. F-01..F-11 milestones

### M0 — Delivery integrity (R-01..R-06)

Scope: pair-gated delivery, paired-only recipient resolution, receiver `seen`,
concurrent-ID tests, shared-record locks, resend cap.

Best 2–4 days / worst 1–2 weeks.

### M1 — Relations and grants (F-01..F-04)

- New `grants` table/record: `{ from, to, operations[], createdAt, revokedAt,
  constraints }`; operations are `send`, `task`, `spawn`, `interrupt`, `close`,
  `history`, `approve`.
- Keep `spawnedBy` as a fact (`parent/` or a new `spawn/` record). Grants are
  separate; `parent` no longer implies all operations.
- Defaults on spawn: parent gets `task/interrupt/close/history`; child gets
  `send` to the parent (the required consultation path). No implicit ancestor
  authority; `allowAncestorCommands` becomes an explicit grant.
- Cycle detection in `writeParent`/grant creation (depth 32, reject).
- Tools: `postal_grant`, `postal_revoke`, `postal_relations`.
- `postal_send`/`task`/`interrupt`/`close`/`log` consult grants.
- Tree shows `spawned by` and grants separately.
- Benefits from R-05 locks and R-03 dedupe.

Best 1–2 weeks / worst 3–5 weeks.

### M2 — Delivery and task separation (F-05..F-08)

- Relation delivery policy: `inbox` (non-waking, TUI inbox), `idle` (start when
  the target is idle), `interrupt` (steer). Default `inbox` for new relations;
  migrate existing peers to `idle` to preserve behavior.
- Separate records: message state (`delivered`/`read`/`acked`) and task state
  (`open`/`in_progress`/`done`/`rejected`). `task/<id>` records; receipts and
  ACKs stay message-level.
- `kind: "request"` (collaborative, no forced execution) vs `kind: "assignment"`
  (forced; requires `task` grant).
- Revocation/permission changes filter undelivered outbox/hold queues.
- Watchdog watches task state, not mail ACK.

Best 1–2 weeks / worst 3–5 weeks.

### M3 — Approvals and audit (F-09..F-11)

- Approval record: `{ id, operation, resourceHash, proposer, approver, executor,
  expiresAt, status, reason }`. Approver must hold `approve` (or be the parent
  when configured); proposer ≠ approver ≠ executor where required.
- Policy: only operations Postal can actually enforce can be marked
  approval-required (e.g., `postal_close`, `postal_interrupt`, a guarded
  `postal_exec`/deploy hook). Do not claim to gate shell/edit unless integrated
  with host permissions.
- `postal_approve`/`postal_reject`; expiry and hash binding; audit log for
  grant/revoke/approval changes.
- The required scenario: A supervises B but cannot skip a production approval;
  the approval is a separate record with an approver and expiry.

Best 1–2 weeks / worst 3–4 weeks.

### Integration and verification

Best 3–5 days / worst 1–2 weeks. Total v2 (M0–M3): **best 4–8 weeks, worst
10–18 weeks**. The cross-machine broker (2B) is separate: best 5 days, worst
3–4 weeks, and depends on M1 grants and R-01..R-03.

## 4. Dependencies and order

1. M0 (R-01..R-06).
2. M1 grants (needs R-05 locks; changes task/interrupt/close auth).
3. M2 delivery/task (needs R-01..R-04 and M1 grants).
4. M3 approvals (needs M1 operation names and M2 task/assignment split).
5. Tree: after M1 (show `spawnedBy` + grants). The current WIP tree can land
   first as a parent/child view, then add grant annotations.
6. Question: after M1 (`send` grant) and the form API spike; keep it separate
   from approvals.
7. 2B broker: after M1/M2 and R-03; cross-machine auth uses the grant model.

## 5. Required scenarios

1. **A supervises B, B consults A.** Bidirectional pair; grants A→B: task,
   interrupt, close, history; B→A: send. No cycle. B's consultation is a
   collaborative request, not a task assignment.
2. **Supervision does not bypass approval.** A has close/interrupt but the
   production operation has an approval policy; A proposes, an approver with
   `approve` accepts (hash + expiry), the executor runs it. A's ancestry does not
   satisfy the approval.

## 6. Risks and open questions

- **Enforcement boundary:** Postal can enforce its own operations; it cannot
  stop arbitrary shell/deploy unless the host permission system or a guarded
  tool is involved. F-10 must label only enforceable operations.
- **Core form API:** `form.created`/`replied` events exist; `ctx.session.form.reply`
  must be runtime-verified for question forwarding.
- **Global plugin storage:** keys/pairs are shared across locations on the same
  server; grants must define cross-location semantics explicitly.
- **Migration:** existing `parent/` + `allowAncestorCommands` must map to default
  grants without breaking current supervision.
- **Cycle safety:** parent/grant writes need a cycle check and tests.
- **Default delivery change:** switching to `inbox` is behavior-changing; migrate
  existing relations to `idle` to preserve current steering.
- **Approval scope:** decide which operations are approval-required and who may
  approve (parent only, or `approve` grant).
- **Resend policy:** choose `maxResends` and whether a rejected letter can be
  edited before a new ID.

## 7. Tree and question integration

- **Tree:** keep the parent/child ASCII view; add `spawned by` and `grants`
  annotations after M1. Default root stays the caller's root; `all` shows every
  root; orphans show a missing parent.
- **Question:** use `ctx.event.subscribe` for `form.created`/`replied`; forward a
  structured `kind: "question"` letter; answer with `postal_answer` under the
  `send`/`approve` grant. Do not conflate a question with an approval record.
- **Approvals:** a separate `kind: "approval"` envelope with operation/hash/
  expiry; questions remain conversational.
