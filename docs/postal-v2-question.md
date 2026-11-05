# Postal v2 — question/answer bridge

- Status: implemented + security hardening (pending human review)
- Scope: form hook + `question`/`answer` envelopes + `postal_answer`
- Baseline: `c243617` plus the hardening commit
- Host: OpenCode 2.2.5

## 1. Goal

A child session often needs a decision from its parent (the host's `question`
tool creates a form and blocks the child). Postal forwards that form to the
parent, lets the parent answer with `postal_answer`, and closes the loop when
the form is answered or cancelled elsewhere.

## 2. Host API facts (verified)

- The host `question` tool creates a form with
  `metadata = { kind: "question", tool: { messageID, id } }` and fields
  `q0..qN` (`packages/core/src/tool/plugin/question.ts`).
- Form events: `form.created { form }`, `form.replied { id, sessionID, answer }`,
  `form.cancelled { id, sessionID }`.
- Plugin context exposes `ctx.event.subscribe({ types })`.
- `@opencode/plugin@2.2.5` does **not** expose `session.form`; the plugin
  context's `SessionDomain` omits it. `postal_answer` prefers a runtime
  `ctx.session.form.reply` when a future host adds it and otherwise uses
  `POST /api/session/{sessionID}/form/{formID}/reply` (204 on success).
- The OpenAPI service registration is read from
  `$XDG_STATE_HOME/opencode/service.json` (fallback
  `~/.local/state/opencode/service.json`, then `~/.config/opencode/service.json`)
  and uses Basic auth (`opencode:<password>`).
- Forms are in memory per location. **Pending forms do not expire**; settled
  forms are retained for 10 minutes (`packages/core/src/form.ts`, `RETENTION`).

## 3. Data model

`question/<formID>` (host form IDs):

```ts
type QuestionRecord = {
  formID: string
  asker: string        // session that owns the form
  target: string       // current parent that was notified
  msgID: string        // question letter id (reply_to anchor)
  title: string
  status: "pending" | "answered" | "cancelled"
  createdAt: number
  updatedAt: number
  settlingBy?: string  // postal_answer in flight
  settlingAt?: number  // stale-marker recovery (30s)
  answeredBy?: string
  answeredAt?: number
  cancelledAt?: number
  note?: string
}
```

Answer bodies are never stored in Postal. `settlingBy` is written before the
host call so a concurrent `form.replied` event cannot mistake the answer for an
external settlement.

## 4. Flows

### form.created

1. Require the host `question` marker: `metadata.kind === "question"` **and**
   `metadata.tool.id` (generic forms that only set `kind` stay local).
2. Validate the form ID and session ID against the `frm_...`/`ses_...` shapes.
3. `target = parent(asker)`. No parent → ignore.
4. Require the target to be a paired peer and an active `send` grant from asker
   to target. Enforce the shared rally cap.
5. Reserve `question/<formID>` under the state lock (dedupe replayed events).
6. Deliver a `question` letter with `steer` (see §5), `form_id`, field keys,
   types, titles, and options. The letter's reply instruction names
   `postal_answer`, not `postal_send`. `kind` is part of the HMAC v2 payload.
7. On delivery failure, remove the reservation. `form.created` fires once, so
   there is **no automatic retry** (see §6).
8. Ignore events whose `location.directory` is not the bridge's location.

### form.replied

1. Ignore unknown forms, malformed IDs, or events whose `sessionID` is not the
   asker.
2. Mark the record `answered` (`answeredBy = settlingBy`, if present).
3. If the target answered through `postal_answer`, no notice is sent.
4. Otherwise (human TUI answer, another ancestor, etc.) the asker sends a
   `status` letter to the target: "answered; you do not need to answer it".
   This prevents a stale answer to a question that is already settled.

The asking session does not receive an `answer` letter: the host form tool
returns the answer directly and unblocks the child.

### form.cancelled

Mark the record `cancelled` and send the same stand-down `status` letter.

### postal_answer({ form_id, answer })

1. Require a known pending record.
2. Authority: the actor must be an ancestor of the asker **and** hold an active
   `task` grant from actor to asker.
   - The direct parent has `send + task` by default, so it works out of the box.
   - Ancestors beyond the direct parent have only `interrupt/close` by default.
     `postal_grant` cannot currently create a grandparent → child `task` grant;
     delegation is a follow-up (§8). This document does not claim otherwise.
3. Validate the wire shape (`string | number | boolean | string[]`, ≤64 fields,
   ≤64 KiB, no `__proto__`/`constructor`/`prototype`).
4. Reserve `settlingBy = actor` + `settlingAt`, call the host form API, then mark
   `answered`. A non-stale `settlingBy` (including the same actor) is rejected;
   a marker older than 30 seconds is treated as stale and recovered.
5. Failure handling:
   - Host 404 with a confirmed `Form not found: <id>` → mark `cancelled` with
     `note = "form_not_found"`.
   - Ambiguous 404 (wrong server/port/registration) → leave `pending` with
     `note = "form_state_unknown"` and return the error.
   - Host 409 → mark `answered` with `note = "form_already_settled"` but do
     **not** credit the caller (`answeredBy` stays unset).
   - Other failures clear `settlingBy`/`settlingAt` and leave the record
     `pending`.
6. The host validates the actual field keys/types/options; Postal does not
   duplicate that schema.

## 5. Delivery policy exception

A blocking question is delivered with `steer` even when the relation policy is
`idle` or `inbox`. Queueing a blocking question would deadlock the child until a
human intervenes. Status/stand-down notices use the relation policy normally.
Set the plugin option `questionBridge: false` to disable the bridge entirely.

## 6. Security and limits

### Capability boundary

`postal_answer`'s ancestor/task check is **cooperative**. The OpenCode 2.2.5
form reply route is authenticated by the server password, not by the actor's
session. Any same-user process that can read `service.json` can answer a form
directly, bypassing Postal. Do not treat this check as a security boundary
against a hostile local process. The HTTP fallback exists only because the
plugin context does not expose an actor-scoped form API.

- HTTP uses `node:http`/`node:https` directly, not `fetch`: Bun's `fetch`
  honors `HTTP_PROXY`/`HTTPS_PROXY` and would forward `Authorization` to the
  proxy. The direct client ignores proxy env, does not follow redirects, has a
  5s timeout, and caps error bodies at 4 KiB.
- HTTP and HTTPS endpoints are loopback-only (`127.0.0.1`, `localhost`, `::1`);
  URL credentials are rejected. No credential is logged, lettered, or committed.
- Errors are sanitized and capped at 300 characters.
- HMAC v2 covers `kind`, message id, `reply_to`, and the rendered letter; a
  tampered `question`/`answer` letter fails admission.
- Receiver-side admission requires `send` for every non-`system` kind;
  `question`/`answer` use `send`, never `task`.
- Only `asker → current parent` is forwarded, and only when the parent is a
  paired peer; parent → child questions are out of scope.
- Same-location only: the form service is in-memory and location-scoped; events
  from another location are ignored.
- Pending forms never expire. Settled forms expire after 10 minutes.
- A question delivery is best-effort: it is not in the outbox and has no retry.
  A failed delivery removes the record and leaves the child blocked until a
  human answers its form directly. Reliable question delivery is a follow-up.
- Installing the plugin twice (global + project) runs two bridges. Keep one
  install per environment, as with the rest of Postal.

## 7. Files

- `forms.ts` — record, rendering, answer shape, service discovery, direct HTTP
  form reply.
- `question-bridge.ts` — `form.created`/`replied`/`cancelled` flows.
- `question-answer.ts` — `postal_answer` authority and host call.
- `index.ts` — envelope kinds, tool enums, tool registration, event bridge.
- Tests: `test/forms.test.ts`, `test/questions.test.ts`,
  `test/question-answer.test.ts`, `test/question-integration.test.ts`,
  `test/form-reply.test.ts`.

## 8. Follow-ups

- Outbox/watchdog delivery for questions (retry, receipt, rally accounting).
- Delegated `task` grants for ancestors, or a `postal_question` creation tool.
- Reparent/close recovery and a startup scan for pending `question/*` records.
- Bridge reconnect/backoff and a single-bridge leader lock.
- Cross-location forms (needs a location-aware form RPC).
- An actor-scoped host form API would turn the cooperative check into a real
  security boundary.
- Optional pruning of old terminal `question/*` records.
