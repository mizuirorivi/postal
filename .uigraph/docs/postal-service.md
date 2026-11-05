# Postal service overview

Postal is an OpenCode v2 plugin that turns separate sessions into a mail network.
Each session keeps its own model, agent, permissions, and transcript; Postal only
forwards letters between them.

The repository has no build step and no npm runtime dependencies. OpenCode loads
the TypeScript sources directly.

## Runtime surface

`index.ts` exports the server plugin (`id: "postal"`, `setup`). At startup it:

- registers the `postal` RPC contract: `connect`, `disconnect`, `status`, `presence`
- registers the bundled agent skill from `skills/postal/SKILL.md`
- registers the `postal_*` tools for directory lookup, peer listing, sending,
  broadcast, outbox inspection, retry, claims, spawn, interrupt, close,
  HMAC key rotation, watchdog scanning, and outbox cleanup
- starts a 15-second outbox retry scanner
- installs the prompt hook for `@ses_` mentions, HMAC verification, task
  authorization, relay ACK marking, and the TUI connect/disconnect/reset
  handshake

`tui.tsx` exports the TUI plugin: Ctrl+P commands, the fuzzy session picker, the
prompt footer, and peer coloring. `sessions.ts` holds the testable new/close
session flows, `status.ts` resolves the current session identity, `rpc.ts`
defines the RPC contract, `lock.ts` serializes per-key work, and `fuzzy.ts` is the
picker matcher.

## State in plugin KV storage

| Key | Purpose |
| --- | --- |
| `peers/<sessionID>` | Array of connected peers (`{ id, title }`) |
| `peer/<sessionID>` | Legacy single-peer record, migrated on first read |
| `spawn/<sessionID>` | Spawn fact (`spawnedBy`), separate from authority |
| `parent/<sessionID>`, `children/<sessionID>` | Current hierarchy mirror used by tree/orphan handling |
| `grants/index`, `grants/<from>/<to>` | Per-operation relation grants, delivery mode, tombstones |
| `approval/index`, `approval/<approvalID>` | Operation-bound approval with sha256 hash, proposer/approver/executor, expiry, and status |
| `audit/index`, `audit/<timestamp>_<random>` | Append-only grant, revoke, delivery, task, and approval decisions |
| `task/index`, `task/<from>/<taskID>` | Task work state separate from message ACK |
| `seen/<from>/<to>/<msgID>` | Receiver replay marker with a 24h TTL |
| `rally/<min>:<max>` | Shared rally counter and window start for a session pair |
| `last/<min>:<max>` | Timestamp of the last letter in a pair |
| `msg/<from>/<msgID>` | Sender-scoped delivered-message marker for idempotency |
| `outbox/index`, `outbox/<from>/<msgID>` | Sender-scoped delivery queue and retry metadata |
| `receipt/index`, `receipt/<from>/<to>/<msgID>` | Receiver admission decision (`accepted`/`rejected`), reason, and task authorizer |
| `claim/<scope>` | Advisory claim with owner and expiry |
| `presence/<sessionID>` | TUI-reported session state, ignored after 30 seconds |
| `hmac/<min>:<max>` | Current and previous HMAC keys for a pair, with key IDs and grace expiry |

## Delivery model

Delivery mode is per relation: `interrupt` uses `steer`, `idle` steers only when
presence is idle and otherwise queues, and `inbox` queues with `resume: false`
(non-waking, drained on the next turn). System notices always steer.
The receiver gets a `[postal]` letter with the sender label, rally position,
`msg_id`, kind, optional task/reply IDs, envelope details, and an instruction to
reply with `postal_send`. Relay deliveries carry `metadata.postal.relay = true`
and the prompt hook ignores them, so they are not forwarded again.

- **Mention mode.** A prompt that starts with `@ses_...` is forwarded immediately
  and the sender's turn ends. Mid-sentence, documentation, and code-fence
  mentions are ordinary text. The receiver answers with `postal_send`, which
  starts the sender's next turn.
- **Tool mode.** `postal_send` resolves the target, checks idempotency, counts the
  rally, writes an outbox record, and attempts delivery. Without `to`, exactly
  one connected peer is required.
- **Rally limit.** The counter is keyed by the sorted session pair and defaults
  to 30 letters per 10-minute window. Sends beyond the limit are rejected unless
  `queueOnLimit` is set; a queued letter is released after the window.
- **Retry.** Failed deliveries retry after 1s, 2s, 4s, and so on, up to six
  attempts and a five-minute cap, driven by the 15-second scanner.
- **Receipts.** On admission the receiver writes `receipt/<from>/<to>/<msg_id>`
  with `accepted` or `rejected` (and a reason). Only authenticated decisions are
  recorded: a valid signature, `invalid_signature` after a matching key ID, or
  `unauthorized_task`. `postal_inbox` reconciles receipts into the sender's
  outbox and sets `rejected` plus `lastError`.
- **ACK.** A reply that includes `reply_to: <msg_id>` marks the original outbox
  record `acked` when the relay reaches the sender. Admission alone is not an
  ACK; the watchdog keeps watching delivered tasks until a reply arrives. This is
  application-level, not transport-level, acknowledgement.
- **Artifacts.** For letters with artifacts, Postal reports `ok`, `missing`, or
  `sha256 mismatch`; commands are listed, never executed.
- **HMAC Phase 1.** Pairing creates a 32-byte HMAC-SHA256 key per pair. Every
  letter is signed over a v2 canonical payload: key ID, `issued_at`, `from`,
  `to`, `msg_id`, `kind`, `task_id`, `reply_to`, and the rendered letter. The
  receiver rebuilds the payload from metadata, verifies within
  `hmacWindowSeconds` (default 120), and clears the body with a `reason` when the
  signature is missing, stale, invalid, or from an unsupported version.
  `kind: "task"` / `assignment` requires an active `task` grant; the receipt
  records the grant holder. `postal_rekey` rotates a key; the old key verifies
  for `keyGraceHours` (default 24). Keys are plugin-scoped and shared across
  locations on the same server.
- **Broadcast.** Each peer gets its own outbox record and rally accounting, with
  a per-peer suffix on the idempotency key.
- **Grants.** `postal_grant` / `postal_revoke` / `postal_relations` manage
  send/task/spawn/interrupt/close/history/approve. Spawn defaults: parent→child
  send/task/interrupt/close/history; child→parent send; paired non-parent send.
  Authority edges must form a DAG; `send` may be bidirectional.
- **Approvals.** `postal_request_approval` stores a pending record bound by
  sha256 over `operation`, `resource`, and sorted `parameters` (default 15
  minutes, clamped to 1 minute–24 hours). The proposer's parent/owner or an
  `approve` grant holder calls `postal_approve` / `postal_reject`; the proposer
  cannot self-approve. `postal_consume_approval` checks the hash and executor,
  then marks the record `consumed`; one approval authorizes one execution.
  `postal_close` / `postal_interrupt` consume a matching approval when the
  relation's rule has `approvalRequired` (spawn-parent defaults do). With
  `enforceApprovals: false`, records are advisory and the operation runs without
  consuming one. `host.shell`, `host.edit`, and `host.deploy` are recorded but
  are not enforceable by Postal (a guarded tool must consume the approval).
- **Audit.** `postal_audit` reads append-only records for grant, revoke,
  delivery, task, and approval request/approve/reject/consume. The caller sees
  its own records, or records for a target it may inspect with `history`.
- **Tasks.** Assignment/task letters create `task/<from>/<taskID>` state
  (`open`/`in_progress`/`blocked`/`done`/`cancelled`). ACK does not complete a
  task; `postal_task_state` updates it. `request` uses `send`, `assignment` uses
  `task`; `task` remains the legacy alias.
- **Watchdog.** Delivered task/assignment records that remain unacked and are
  not terminal are checked against TUI presence. Idle workers receive a
  `kind: "system"` nudge with the original `reply_to`; running workers are
  skipped. Defaults: 300s age, 600s between nudges, 2 nudges.
- **Revocation.** `postal_revoke` marks pending matching outbox records
  `revoked`, cancels open assignment tasks, and `attemptOutbox` re-checks grants
  on every retry.
- **Outbox cleanup.** Delivered/rejected/revoked/acked/failed records older than
  `outboxTtlDays` (default 7) are removed together with their receipts;
  sender-scoped `msg` idempotency markers remain. The background timer runs a
  real cleanup; the tool defaults to a dry run.

## Pairing, spawning, and lifecycle

Pairing writes the peer to both sessions and refreshes an instruction note when
the runtime exposes instruction entries. Connecting a peer preserves existing
ones; disconnect removes one peer or all of them. `peerStatus` drops records
whose session no longer exists.

`postal_spawn` calls `ctx.session.create` with the requested title, model,
agent, directory, and permissions, records the parent/child relationship, and
pairs the new session when `autoPair` is true (the default). The worker stays
idle until a letter arrives.

`postal_interrupt` and `postal_close` are limited to the direct parent session by
default; `allowAncestorCommands: true` extends this to ancestors. When a parent
closes, `orphanPolicy` decides what happens to its children:

- `reparent` (default): the grandparent adopts them and is notified with a
  `kind: "system"` letter
- `terminate`: the descendant subtree is stopped and deleted
- `detach`: parent links are removed and nobody can close the orphans

## Configuration

Plugin options are read from the plugin entry in `opencode.json(c)`:

| Option | Default | Effect |
| --- | --- | --- |
| `maxRally` | 30 | Letters per conversation window |
| `rallyWindowMinutes` | 10 | Rolling rally window |
| `allowAncestorCommands` | false | Let any ancestor interrupt/close a descendant |
| `enforceApprovals` | true | Require and consume approvals for approval-required close/interrupt; false writes advisory records only |
| `orphanPolicy` | `reparent` | Child handling when a parent closes |
| `hmacWindowSeconds` | 120 | Accepted `issued_at` skew (30–3600) |
| `keyGraceHours` | 24 | Old-key verification grace after `postal_rekey` (1–168) |
| `watchdogAfterSeconds` | 300 | Minimum age of an unacked task before a nudge |
| `watchdogIntervalSeconds` | 600 | Minimum time between nudges for one task |
| `watchdogMaxNudges` | 2 | Maximum nudges per task |
| `outboxTtlDays` | 7 | Retention for delivered/rejected/acked/failed outbox records and receipts |

## Operational limits

- Outbox state lives in the per-location plugin KV table. It is not a global
  distributed queue; cross-project delivery still needs a reachable target.
- ACK depends on the receiver passing `reply_to`; there is no runtime-level
  acknowledgement. Admission writes a receipt, not an ACK, so the watchdog keeps
  watching a delivered task until the reply arrives. Watchdog only sees idle
  sessions through TUI presence;
  headless workers remain `unknown`. Nudges wake the worker and cost tokens.
- Claims are advisory, serialized within one plugin process, and can be ignored;
  filesystem permissions remain the real enforcement boundary. Cross-process
  coordination is out of scope in Phase 1.
- `postal_inbox`, `postal_status`, and `postal_log` accept another session ID only
  when the caller is that session or its parent/ancestor. `postal_watchdog` and
  `postal_cleanup` operate on the caller's outbox; the background timer is the
  only fleet-wide supervisor.
- `postal_status` reports peers, rally budget, last letter, outbox count, and the
  session parent. It cannot see true busy/idle in the server plugin API; the TUI
  publishes presence separately.
- Mail bodies are untrusted. HMAC Phase 1 authenticates the pair, not intent: a
  compromised peer with the key can sign a malicious task. Task letters are
  limited to parent/ancestor sessions. Keys live in the per-location KV and are
  not shared across locations yet; pair only trusted sessions and use
  permissions or separate projects for isolation.

## Files

| File | Responsibility |
| --- | --- |
| `index.ts` | Server plugin: tools, RPC, prompt hook, KV state, delivery |
| `tui.tsx` | TUI commands, picker, footer, peer colors |
| `sessions.ts` | New/close/delete session flows |
| `status.ts` | Route and tab identity for the footer |
| `rpc.ts` | `postal.connect` / `disconnect` / `status` / `presence` contract |
| `lock.ts` | Per-key serialization helper |
| `fuzzy.ts` | Fuzzy matcher for the session picker |
| `skills/postal/SKILL.md` | Agent-facing usage guide |

## Tests

`bun test` runs the Bun test suite under `test/`: multi-peer storage, async
delivery, session lifecycle, footer identity, HMAC verification/task
authorization, inbound receipts and rejection reconciliation, retry/timer
behaviour, and headless server behaviour.
