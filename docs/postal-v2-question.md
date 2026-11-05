# Postal v2 — question/answer bridge

- Status: implemented (pending human review)
- Scope: `postal_question` (form hook + `question`/`answer` envelopes + `postal_answer`)
- Baseline: `f2dd78a` (M2 + question modules)
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
  context's `SessionDomain` omits it. `postal_answer` therefore prefers a
  runtime `ctx.session.form.reply` when a future host adds it and otherwise uses
  `POST /api/session/{sessionID}/form/{formID}/reply` (204 on success).
- The OpenAPI service registration is read from
  `$XDG_STATE_HOME/opencode/service.json` (fallback
  `~/.local/state/opencode/service.json`, then `~/.config/opencode/service.json`)
  and uses Basic auth (`opencode:<password>`).
- Forms live in memory per location and expire 10 minutes after settlement
  (`packages/core/src/form.ts`, `RETENTION`).

## 3. Data model

`question/<formID>` (form IDs are unique):

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
  answeredBy?: string
  answeredAt?: number
  cancelledAt?: number
  note?: string
}
```

Answer bodies are never stored in Postal. The record is routing/audit metadata
only. `settlingBy` is written before the host call so a concurrent
`form.replied` event cannot mistake the answer for an external settlement.

## 4. Flows

### form.created

1. Ignore anything whose `metadata.kind !== "question"` (MCP elicitation and
   other forms stay local).
2. `target = parent(asker)`. No parent → ignore.
3. Require an active `send` grant from asker to target.
4. Reserve `question/<formID>` under the state lock (dedupe replayed events).
5. Deliver a `question` letter with `steer` (see §5), `form_id`, field keys,
   types, titles, and options. The letter is HMAC-signed like every other
   letter; `kind` is part of the HMAC v2 payload.
6. On delivery failure, remove the reservation so a later event can retry.

### form.replied

1. Ignore unknown forms or events whose `sessionID` is not the asker.
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
   - A grandparent has only `interrupt/close` by default (M1 ancestor defaults);
     it must be granted `task` explicitly to answer. This matches the approved
     "task grant と同様" authority model.
3. Validate the wire shape (`string | number | boolean | string[]`, ≤64 fields,
   ≤64 KiB, no `__proto__`/`constructor`/`prototype`).
4. Reserve `settlingBy = actor`, call the host form API, then mark `answered`.
5. Failure handling:
   - Host 404 → mark `cancelled` with `note = "form_not_found"`.
   - Host 409 → mark `answered` with `note = "form_already_settled"`; return the
     error to the caller.
   - Other failures clear `settlingBy` and leave the record `pending`.
6. The host validates the actual field keys/types/options; Postal does not
   duplicate that schema.

## 5. Delivery policy exception

A blocking question is delivered with `steer` even when the relation policy is
`idle` or `inbox`. Queueing a blocking question would deadlock the child until a
human intervenes. Status/stand-down notices use the relation policy normally.
Set the plugin option `questionBridge: false` to disable the bridge entirely.

## 6. Security and limits

- No credential is logged, lettered, or committed. HTTP is restricted to
  loopback (`127.0.0.1`, `localhost`, `::1`) or `https`.
- HTTP timeout: 5 seconds. Errors are sanitized and capped at 300 characters.
- HMAC v2 covers `kind`, message id, `reply_to`, and the rendered letter; a
  tampered `question`/`answer` letter fails admission.
- Receiver-side admission now requires `send` for every non-`system` kind
  (M2 change); `question`/`answer` use `send`, never `task`.
- Only `asker → current parent` is forwarded. Parent → child questions are out
  of scope; the parent's own `question` form stays local.
- Same-location only: the form service is in-memory and location-scoped.
  Cross-location question/answer is a later milestone.
- Form state expires after 10 minutes; a `postal_answer` after expiry returns the
  host's 404 and marks the record `cancelled`.
- Installing the plugin twice (global + project) would run two bridges. Keep one
  install per environment, as with the rest of Postal.

## 7. Files

- `forms.ts` — record, rendering, answer shape, service discovery, form reply.
- `question-bridge.ts` — `form.created`/`replied`/`cancelled` flows.
- `question-answer.ts` — `postal_answer` authority and host call.
- `index.ts` — envelope kinds, tool enums, tool registration, event bridge.
- Tests: `test/forms.test.ts`, `test/questions.test.ts`,
  `test/question-answer.test.ts`, `test/question-integration.test.ts`.

## 8. Follow-ups

- Cross-location forms (needs a location-aware form RPC).
- A `postal_question` creation tool (currently the host `question` tool is the
  only producer).
- Optional pruning of old `question/*` records (terminal records are small).
- Revisit authority if humans prefer `send`-only answers; the current model
  follows the approved task-grant design.
