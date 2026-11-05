# Phase 2 ADR — cross-location mail and cross-process coordination

- Status: accepted for Phase 2A planning
- Baseline: Phase 1 at `28b7c65`
- Date: 2026-11-05

## Context

Phase 1 delivered per-session mail, HMAC v2, receipts, sender-scoped outbox
keys, and cooperative delivery. Phase 2 was proposed as three items:

1. cross-process locks for claims and outbox writes;
2. cross-location central state and HMAC key distribution;
3. pause/resume (blocked on core API).

Before implementation we ran a spike against OpenCode 2.2.5 (Bun 1.4.2) to
check which parts already exist.

## Spike results

### 1. Cross-location delivery already works

Created a session in `/tmp/opencode/cross-loc` and sent a letter from the
`/home/rivi/postal` session. The sender resolved the target, signed the letter,
and delivered it with `session.prompt`. The target received the letter and
replied with `postal_send`; the sender verified the reply and marked the outbox
record `acked`.

The target's `postal_directory` returned only its own location (header, no
sessions), while the global HTTP `GET /api/session` listed both sessions. This
means:

- `ctx.storage` is scoped to the plugin, not to a location. HMAC keys and pair
  records are already shared across locations on the same server.
- `ctx.location.directory` is the plugin instance's location, not every
  session's location. Tool calls for a session in another location still use
  their own session ID.
- `postal_directory` is location-scoped because it passes
  `ctx.location.directory`; cross-location discovery is the missing piece.

### 2. Core API: no true pause/resume

The OpenAPI document has no `/api/session/{id}/pause` or `/resume`. Only
`/api/experimental/schedule/{id}/pause|resume` exists. `session.interrupt`
exists. Cooperative pause (hold postal traffic, interrupt the current turn) is
the only implementable option.

### 3. SQLite is available

`bun:sqlite` created a WAL database and executed an upsert in a probe. OpenCode
2.2.5 runs on Bun. A plugin-scoped state DB is viable for cross-process locks.

### 4. Plugin event and form APIs

The V2 server plugin API exposes:

- `ctx.event.subscribe({ types: [...] })` for public events, including
  `form.created`, `form.replied`, and `form.cancelled`;
- `ctx.session.list({ directory, limit, cursor })` with `Session.Info.parentID`
  and `Session.Info.location`;
- `ctx.storage.scan({ prefix, after, limit })`;
- `ctx.session.interrupt({ sessionID })` and `ctx.session.remove`.

The OpenAPI surface has `session.form.list|create|get|cancel|reply`. The plugin
context mirrors the server client; `ctx.session.form.reply` is expected but
must be verified at implementation time. If it is absent, the TUI client or a
local HTTP call is the fallback.

## Decisions

1. **Do not build a separate central keyring for Phase 2A.** The plugin storage
   is already the shared keyring and pair store for same-machine locations.
   Add cross-location discovery, policy, replay protection, migration tests,
   and documentation instead.
2. **Cross-process locks use SQLite** (`state.db`, WAL, `BEGIN IMMEDIATE`) under
   `$XDG_STATE_HOME/opencode/postal/` (fallback `~/.local/state/...`), mode
   0600. Keep the in-process `serialized()` mutex as the first layer.
3. **Pause is cooperative.** Persist a paused flag, hold relay letters in a
   bounded queue with TTL, drain on resume, and skip paused sessions in the
   watchdog. True runtime freeze is out of scope.
4. **Cross-location `kind: "task"` stays disabled** until a central parent or
   commander model exists. Allow `letter`, `status`, `verify`, and `question`
   in Phase 2A.
5. **2B is the cross-machine broker.** It needs explicit authentication,
   encryption, replay protection, and key distribution; it is not covered by
   the shared local KV.

## Revised Phase 2A work

1. Cross-location discovery:
   - add an `allLocations` option to `postal_directory`/`postal_tree`;
   - use `ctx.session.list` without a directory filter or the global HTTP list;
   - label sessions with `Session.Info.location`.
2. Cross-location policy and replay:
   - central `seen(msg_id)` with TTL (plugin storage or SQLite);
   - keep `kind=task` blocked across locations;
   - add cross-location pair/delivery tests.
3. Cross-process locks:
   - `withLock(key, ttl, fn)` backed by SQLite;
   - wrap claim/release and outbox put/update/ack/attempt;
   - two-process and stale-lease tests.
4. Cooperative pause/resume:
   - `paused/<sessionID>`, bounded hold queue, `postal_pause`/`postal_resume`,
     watchdog skip, tests.
5. Documentation:
   - replace "per-location KV" with "plugin-scoped, shared across locations on
     the same server";
   - document the cross-location trust boundary and the task restriction.

## Risks

- `ctx.session.form.reply` may not be exposed to the server plugin; verify with
  a runtime check before implementing question forwarding.
- Multiple plugin instances (one per location) may receive the same global
  event; deduplicate with a `form/<id>/forwarded` marker.
- SQLite WAL is unsuitable for network filesystems; the state directory must be
  local.
- Cross-location data sharing weakens project isolation; document it and keep
  session/parent authorization checks.
- Replay protection must cover cross-location letters; HMAC alone does not
  prevent replay within the 120-second window.

## Evidence

- Cross-location probe: `ses_e55789391ffe3UIgR7tGEcY6Qz` created in
  `/tmp/opencode/cross-loc`; letter `msg_cross_loc_spike` delivered, reply
  `msg_mw37c9dt_0cnhc1` verified, outbox `acked`.
- Target `postal_directory`: only its own location header.
- Global `GET /api/session`: both sessions visible.
- `bun:sqlite`: WAL upsert probe succeeded.
- OpenAPI: no session pause/resume; form reply operations present.
- Plugin docs: `ctx.event.subscribe`, `ctx.storage.scan`,
  `Session.Info.parentID/location`.
