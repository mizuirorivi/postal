# Changelog

## 0.2.0 — 2026-11-06

### Added

- Question bridge: a child's `question` form is forwarded to the parent and
  answered with `postal_answer`; a failed delivery cancels the host form so the
  child is not left blocked.
- Runtime and HTTP host-error classification (`_tag` / `id` / status).
- HTTPS form transport with an optional CA (`FormsDeps.ca`).
- One-time warning when the OpenCode service registration is group/world
  readable.

### Changed

- 404/409 settle a question record only on the HTTP status plus a structured
  `_tag` and matching form `id`; prose and bare status codes no longer count.
- Form events are location fail-closed; a missing location is warned once.
- A delivery failure marks the record `cancelling` and cancels the host form in
  the background without holding the question lock; answers are refused while
  the cancel is in flight and a 30s stale marker recovers.
- Delivery retries once with a fixed `msg_id` without double-counting the rally
  budget; status notices are not retried.
- `handleFormReplied` no longer credits `answeredBy` from an in-flight
  `settlingBy`; only a confirmed `postal_answer` credits the actor.
- Documentation and README updated; tests for HTTPS, permissions, cancellation,
  runtime classification, and the bridge flows added.

### Security

- Form requests use a dedicated non-keepalive agent, a total-time deadline, and
  a 4 KiB response cap; the shared `globalAgent` is never used.
- The cooperative boundary of the host form API is documented: any same-user
  process that can read `service.json` can answer forms directly.
