# Postal v2 — question/answer bridge

- Status: implemented + hardening rounds 3-5
- Scope: form hook + `question`/`answer` envelopes + `postal_answer`
- Baseline: `2b8eb7b` plus the round 3-5 hardening commit
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
  `form.cancelled { id, sessionID }`, each carrying `location.directory`
  (live-verified: a `form.created` stream item included
  `"location":{"directory":"/home/rivi/postal"}`).
- The bridge processes an event only when both the event and the bridge expose a
  matching `location.directory`; a missing location is skipped and warned once
  (fail-closed).
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
  cancelling?: boolean    // background host cancel in flight
  cancellingAt?: number   // stale-marker recovery (30s)
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
7. On a delivery failure, mark `cancelling = true` + `cancellingAt` under the
   `question/<formID>` lock (no host call while locked) and return immediately.
   A background `finishCancellation` then cancels the host form —
   `ctx.session.form.cancel` when available, otherwise
   `DELETE /api/session/{id}/form/{fid}?message=...` (a failing runtime cancel
   falls back to HTTP; HTTP retries network errors and 5xx up to 3 attempts with
   150ms/300ms backoff and never retries 4xx). On completion it clears the
   marker under the lock: a successful cancel makes the record `cancelled` with
   `note = "delivery_failed: <line>"`, while a failed cancel keeps it `pending`
   with `note = "cancel_failed: <reason>"` and warns. If an answer reserved
   (`settlingBy`) while the cancel was in flight, the record stays `pending`
   with `note = "cancel_raced: answer in flight"` and the in-flight answer
   decides the final state. The failure text is returned to the caller as
   `{ status: "failed", error }`. `form.created` fires once, so there is no
   further retry (see §6).
8. Ignore events whose `location.directory` is missing or does not match the
   bridge's location (missing is warned once).
9. `no_parent`, `not_paired`, and `send_not_granted` are ignored and warned
   (formID + reason); no letter, no `question/<formID>` record, no cancel. The
   child's form stays open, so the child remains blocked until a human answers
   or cancels it directly.

### form.replied

1. Ignore unknown forms, malformed IDs, or events whose `sessionID` is not the
   asker.
2. Mark the record `answered`. `answeredBy` is **not** credited here: it is set
   only by `postal_answer` after the host confirms the reply. An in-flight
   `settlingBy` suppresses the stand-down notice below instead.
3. If no in-flight answer existed and the target did not itself answer, the
   asker sends a `status` letter to the target: "answered; you do not need to
   answer it". This prevents a stale answer to a question that is already
   settled. An in-flight answer suppresses this notice.

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
   a marker older than 30 seconds is treated as stale and recovered. A non-stale
   `cancelling` marker (background cancel in flight) is rejected with
   `question is being cancelled`; a missing/older-than-30s marker is treated as
   stale and cleared before proceeding.
5. Failure handling keys on the HTTP status **and** the structured host error,
   never on prose. A runtime `ctx.session.form.reply` error is classified the
   same way (`_tag`/`name` → tag, `id`, and a status derived from the tag or
   `cause.status`); an unclassifiable transport error stays `pending`.
   - `404` + `{ _tag: "FormNotFoundError", id: <formID> }` → mark `cancelled`
     with `note = "form_not_found"`.
   - `409` + `{ _tag: "FormAlreadySettledError", id: <formID> }` → mark
     `answered` with `note = "form_already_settled"` but do **not** credit the
     caller (`answeredBy` stays unset).
   - Any other 404/409, or a tag/id on a `200`/`500` body, leaves the record
     `pending` with `note = "form_state_unknown"`.
   - Other failures clear `settlingBy`/`settlingAt` and leave the record
     `pending`.
   - If the record is no longer `pending` when the reply returns (e.g. cancelled
     concurrently), the call reports `ok: false` instead of success.
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
session: any same-user process that can read `service.json` can answer a form
directly, bypassing Postal. This is an upstream constraint (the host exposes no
actor-scoped form API); Postal only adds a permission warning and loopback-only
HTTP, and this check must not be treated as a security boundary against a
hostile local process.

- HTTP uses `node:http`/`node:https` directly, not `fetch`: Bun's `fetch`
  honors `HTTP_PROXY`/`HTTPS_PROXY` and would forward `Authorization` to the
  proxy. The direct client ignores proxy env, does not follow redirects, uses a
  dedicated non-keepalive `Agent` (never `globalAgent`), enforces a total-time
  deadline (default 5s, not socket inactivity), caps the read at 4 KiB without
  waiting for `end`, and guards resolve/reject so it settles exactly once.
  A synchronous `send` throw destroys the agent and rejects.
- HTTPS accepts an optional CA (`FormsDeps.ca`), used only for `https:` hosts;
  runtime form API errors are classified into tag/id/status so the same settle
  rule applies on both paths.
- HTTP and HTTPS endpoints are loopback-only (`127.0.0.1`, `localhost`, `::1`);
  URL credentials are rejected. No credential is logged, lettered, or committed.
  The service registration's mode is checked (`statSync`) and group/other
  readability is warned once; a same-user process can still read it, so treat the
  local server password as shared.
- Errors are sanitized and capped at 300 characters.
- HMAC v2 covers `kind`, message id, `reply_to`, and the rendered letter; a
  tampered `question`/`answer` letter fails admission.
- Receiver-side admission requires `send` for every non-`system` kind;
  `question`/`answer` use `send`, never `task`.
- Only `asker → current parent` is forwarded, and only when the parent is a
  paired peer; parent → child questions are out of scope.
- Same-location only: the form service is in-memory and location-scoped. Events
  without a location, or from another location, are skipped.
- Pending forms never expire. Settled forms expire after 10 minutes.
- A question delivery is best-effort: it is not in the outbox. `formsDeps`
  consumes the rally budget once and retries `postOnly` once after 150ms on a
  non-rally failure **only when a stable `msgID` was supplied** (question
  letters); `status` notices have no `msgID` and are never retried, so a notice
  cannot be delivered twice. On a delivery failure the
  record is marked `cancelling` and the host form is cancelled in the
  background; success marks it `cancelled`, a failed cancel keeps it `pending`
  with `cancel_failed`, the failure is surfaced via `console.warn`, and the child
  remains blocked until a human answers or cancels the form. Reliable delivery
  remains a follow-up.
- Installing the plugin twice (global + project) runs two bridges. Keep one
  install per environment, as with the rest of Postal.

### Known limitations

- The runtime `ctx.session.form.reply` path classifies `_tag`/`name`/`id`/status
  (`FormNotFoundError` → 404, `FormAlreadySettledError` → 409) so the same
  status + tag + id rule applies. An unclassifiable transport error (e.g.
  `ClientError` without a tag/id) still leaves the record `pending`; that is the
  safe side.
- A cancel/answer race on the same form converges to `ok: false` or
  `answered`: the host cancel runs in the background (not inside the question
  lock), so an answer is rejected while `cancelling` is set (30s stale window)
  and a settle that still races is caught by the §4 postal_answer step 5
  re-check.
- `handleFormReplied` no longer credits `answeredBy` from an in-flight
  `settlingBy`; `answeredBy` is set only by `postal_answer` after the host
  confirms. An in-flight settle suppresses the stand-down notice instead of
  recording a false actor.

## 7. Files

- `forms.ts` — record, rendering, answer shape, service discovery, direct HTTP
  form reply.
- `question-bridge.ts` — `form.created`/`replied`/`cancelled` flows.
- `question-answer.ts` — `postal_answer` authority and host call.
- `index.ts` — envelope kinds, tool enums, tool registration, event bridge.
- Tests: `test/forms.test.ts`, `test/questions.test.ts`,
  `test/question-answer.test.ts`, `test/question-integration.test.ts`,
  `test/form-reply.test.ts`, `test/cancel-form.test.ts`,
  `test/https-form-reply.test.ts`, `test/service-permissions.test.ts`
  (fixtures: `test/fixtures/server-{cert,key}.pem`).

## 8. Follow-ups

- Outbox/watchdog delivery for questions (retry, receipt, rally accounting).
- Delegated `task` grants for ancestors, or a `postal_question` creation tool.
- Reparent/close recovery and a startup scan for pending `question/*` records.
- Bridge reconnect/backoff and a single-bridge leader lock.
- Cross-location forms (needs a location-aware form RPC).
- An actor-scoped host form API would turn the cooperative check into a real
  security boundary.
- Optional pruning of old terminal `question/*` records.
