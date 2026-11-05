# Postal — session-to-session mail for OpenCode

Postal turns separate OpenCode sessions into a small mail network. Connect one
or more peer sessions, then let their AIs talk — or send a letter from a human
prompt with `@ses_...`.

No subagents, no shared context, no parent-child hierarchy. Each session keeps
its own model, agent, permissions, and tab.

## Why Postal?

- **Peer sessions, not subagents.** A subagent is a child with a copied task. A
  Postal peer is a first-class session with its own history, model, and tools.
- **Human-visible.** Letters and replies stay in the normal session transcripts,
  so you can read and audit both sides.
- **Explicit and bounded.** Mail is only sent by an `@ses_...` mention or a
  `postal_send` call. A shared rally counter stops runaway AI-to-AI loops.
- **Zero dependencies.** TypeScript sources are loaded directly by OpenCode. No
  build step, no npm dependencies.
- **Works with your setup.** Mention mode for humans, tool mode for agents, and
  Ctrl+P commands for connecting peers.

## Features

- `@ses_XXXX <message>` at the start of a prompt (mention delivery that returns immediately)
- `postal_send` tool for AI-to-AI letters (non-blocking)
- `postal_directory`, `postal_peers`, and `postal_spawn` tools for address discovery and worker creation
- Structured envelopes (`kind`, `task_id`, `reply_to`, artifacts, commands, `msg_id`)
- HMAC Phase 1: per-pair keys, signed envelopes, ±120s window, 24h key grace, task parent/ancestor allowlist
- `postal_status` (rally budget / last letter / busy-idle / inbox count) and `postal_log` (postal audit)
- TUI presence bridge for live busy/idle and pending-inbox metadata
- Artifact existence + sha256 verification on `verify` letters
- Persistent outbox with retry + ACK (`postal_inbox`, `postal_resend`)
- Advisory claims (`postal_claim` / `postal_release`)
- Agent lifecycle (`postal_interrupt`, `postal_close`) with a spawn-parent allowlist, and `postal_broadcast`
- Idle-worker watchdog nudges and outbox TTL cleanup
- Multiple connected peers per session
- Ctrl+P commands: new session, connect, close session, disconnect peers, show
  connected peers, reset rally
- Shared per-conversation rally counter (default 30 letters / 10 minutes)
- RPC (`postal.connect` / `postal.disconnect` / `postal.status`) for exact TUI
  feedback
- Fuzzy session picker sorted by recency
- Current session title + ID in the prompt footer, including an explicit
  placeholder while a new session has no ID yet
- Connected peers are green in the session picker and in the footer's
  `→ peers` segment

## Quick start

```sh
# Install with OpenCode (adds the plugin to the global config)
opencode plugin add github:mizuirorivi/postal

# Or run the bundled installer with npx (global)
npx --yes github:mizuirorivi/postal

# Project-local install
npx --yes github:mizuirorivi/postal --project .
```

OpenCode loads the plugin automatically. Run `/reload` in the TUI if it does not
appear.

### Agent skill

The plugin registers a `postal` skill with OpenCode. The npx installer also copies
`skills/postal/SKILL.md` to:

- `~/.config/opencode/skills/postal/SKILL.md` (global)
- `.opencode/skills/postal/SKILL.md` (project)

Load it with `@postal` or the `skill` tool. The skill covers when to use mentions
vs `postal_send`, rally limits, and untrusted-mail handling.

### Manual clone

```sh
# global
git clone https://github.com/mizuirorivi/postal.git ~/.config/opencode/plugins/postal

# or project-local
git clone https://github.com/mizuirorivi/postal.git .opencode/plugins/postal
```

Or add it explicitly to `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./.opencode/plugins/postal"]
}
```

### Update

```sh
opencode plugin update          # installed with opencode plugin add
# or
git -C ~/.config/opencode/plugins/postal pull
```

### Uninstall

Before removing the plugin, run `postal_disconnect` in each open session (or
close the sessions). This clears the per-session `postal-peer` instruction
note.

```sh
opencode plugin remove github:mizuirorivi/postal
rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/postal"
rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills/postal"
# project install:
rm -rf .opencode/plugins/postal .opencode/skills/postal
```

The installer copies the skill to the global or project skills directory in
addition to the plugin directory, so removing only the plugin leaves the skill
behind. Sessions that were not disconnected may keep the `postal-peer` note in
host session state until the session is deleted or the runtime restarts; the
plugin has no unload/teardown hook.

### Requirements

- OpenCode v2.x (tested with 2.1.4)
- No npm dependencies; TypeScript sources are loaded directly

## Usage

### Human: mention a session

Start a normal prompt with a session ID:

```text
@ses_abc123 Please review the changes in src/foo.ts and reply with the risks.
```

The address must be the first token of the prompt. An `@ses_...` that appears
mid-sentence, in documentation, or inside a code fence is treated as ordinary
text and is never forwarded.

Postal forwards the message to `ses_abc123` immediately and returns. The
receiving session replies with `postal_send`, which starts your next turn.
There is no blocking wait and no queued reply in your inbox:

```text
[postal] from ses_abc123 (reviewer) (rally 1/30)
...
```

### AI: send mail

Ask an agent to use the tools:

```text
Use postal_peers to see my connected peers. If there is one, postal_send a
summary of the current diff; if there are several, pass the target with 'to'.
```

`postal_send` returns immediately. The peer receives a `[postal]` letter and can
continue the conversation by calling `postal_send` again. Omit `to` only when
exactly one peer is connected; with multiple peers, `postal_send` lists them so
you can choose. `postal_directory` lists every session in the project.

### AI: spawn a worker

`postal_spawn` creates a session from an agent, so no CLI or database lookup is
needed:

```text
postal_spawn({
  title: "Worker",
  model: "opencode-go/deepseek-v4.1-flash#max",
  agent: "build",
  directory: "/path/to/project",
  autoPair: true
})
-> spawned ses_... and paired
```

The new session is idle until you send it a letter with `postal_send`. `model`
uses `provider/model` with an optional `#variant`; `autoPair` defaults to `true`.

### Structured envelope

`postal_send` accepts an optional envelope so progress can be checked without
re-parsing prose:

```jsonc
postal_send({
  to: "ses_worker",
  kind: "task",              // task | status | verify | error | letter
  task_id: "T1",
  reply_to: "T0",
  msg_id: "msg_phase1",      // idempotency key; generated when omitted
  text: "Phase 1 complete",
  artifacts: [{ path: "src/foo.ts", sha256: "..." }],
  commands: [{ cmd: "bun test", exit: 0 }]
})
```

The receiver sees the body plus a machine-readable `--- postal envelope ---`
section. For any letter with artifacts, Postal adds a `verification:` section
with `ok` / `missing` / `sha256 mismatch`. Commands are reported, not re-run.
A retried `msg_id` is not delivered twice.

`postal_status` shows connected peers, remaining rally budget, last letter
time, live `STATE` (idle/running), `INBOX_COUNT`, and the presence timestamp.
`postal_inbox` combines the outbox with each peer's pending-inbox metadata
(item ID, type, and source session only). `postal_log` returns recent `[postal]`
messages from a transcript for audit.

Presence is published by the TUI every five seconds for the focused session and
its peers. It expires after 30 seconds; a headless or closed TUI shows
`unknown`. Message bodies are not published by this bridge.

### Delivery reliability

Every `postal_send` writes a sender-scoped outbox record before delivery:

- `pending`: queued or waiting for retry (`nextAt`); failed delivery is retried
  after 1s, 2s, 4s, … up to 6 attempts
- `delivered`: `session.prompt` accepted the letter; this is not proof that the
  receiver processed it
- `rejected`: the receiver verified the envelope but rejected it; `lastError`
  carries `invalid_signature` or `unauthorized_task`
- `acked`: the peer replied with `reply_to: <msg_id>`; admission alone does not
  count as an ACK
- `failed`: all retry attempts were exhausted

The receiver writes a receipt under `receipt/<from>/<to>/<msg_id>` for every
accepted letter and for authenticated rejections. `postal_inbox` reconciles
receipts into the sender's outbox, so a rejected signature or unauthorized task
is visible without waiting for a reply. Use `postal_inbox` to inspect the
outbox, `postal_resend` to clear a rejection and retry, and `postal_retry` to
scan due pending records. This is a delivery queue, not the AI's pending inbox.
When the rally limit is reached, pass `queueOnLimit: true` to retry after the
window instead of rejecting the letter.

### HMAC Phase 1

Pairing creates a 32-byte HMAC-SHA256 key per pair (same location only). Every
letter is signed over a v2 canonical payload containing `keyID`, `issued_at`,
`from`, `to`, `msg_id`, `kind`, `task_id`, `reply_to`, and the rendered letter.
The receiver rebuilds that payload from the metadata it is about to trust, so
altering any of those fields fails verification. Legacy signatures are rejected
with `unsupported_signature_version`. The receiver verifies before the AI sees
it:

- `issued_at` must be within `hmacWindowSeconds` (default 120; clamp 30–3600)
- an invalid or missing signature clears the body and records
  `reason` (`invalid_signature`, `missing_signature`, `stale_signature`,
  `unknown_key`) in `postal` metadata
- `kind: "task"` is accepted only from the target's parent or an ancestor
- `postal_rekey` rotates a pair key; the old key verifies for `keyGraceHours`
  (default 24; clamp 1–168), then expires

Manual root sessions have no parent, so agents cannot send them `kind: "task"`
letters. This is intentional least privilege.

### Watchdog and cleanup

`postal_watchdog` finds `kind: "task"` letters that were delivered but never
acked. If the worker's TUI presence says `idle`, it sends one `kind: "system"`
nudge that asks for a status or completion and references the original
`msg_id`. It does not nudge running workers; unknown presence is skipped unless
`nudgeUnknown` is passed. Defaults: 300s minimum age, 600s between nudges, max
2 nudges per task. Use `dryRun` to inspect candidates.

`postal_cleanup` removes delivered/rejected/acked/failed outbox records older
than `outboxTtlDays` (default 7) and their receipts. It defaults to a dry run;
pass `dryRun: false` to delete. Sender-scoped `msg/<from>/<id>` idempotency
markers are retained.

### Claims and lifecycle

`postal_claim({ scope, ttl })` takes an advisory lock for a path or task.
Re-claim to heartbeat; `postal_release({ scope })` releases it. Claims are
coordination hints, not filesystem enforcement.

`postal_interrupt` interrupts a running session. `postal_close` deletes another
session and disconnects its peers. Both are restricted to the session that
spawned the target (the direct parent); set `allowAncestorCommands: true` to
let any ancestor use them. When a parent is closed, its children are reparented
to the grandparent (or become unowned if there is no grandparent), so they are
not orphaned. `orphanPolicy` controls this: `reparent` (default, notifies the
grandparent with a `kind: "system"` letter), `terminate` (stops and deletes the
descendant subtree), or `detach` (removes parent links; nobody can close the
orphan). `postal_status` shows `SESSION_PARENT`.

`postal_broadcast` sends one letter to every connected peer with per-peer outbox
and rally accounting.

### Reliability tradeoffs

- **Outbox storage** is the plugin KV table. It is per-location, not a global
  distributed queue; cross-project delivery still relies on the target being
  reachable. TTL cleanup removes old records but keeps `msg` markers for
  idempotency.
- **Watchdog** only nudges sessions whose TUI presence is `idle`; headless
  workers stay `unknown` and need `nudgeUnknown` or external supervision.
  Nudges start a worker turn and therefore cost tokens.
- **ACK** is application-level: the receiver must include `reply_to: msg_id`.
  There is no transport-level acknowledgement from the model runtime.
- **Claims** are advisory; a rogue worker can ignore them. Filesystem
  permissions remain the real enforcement boundary.
- **Commander allowlist** covers lifecycle operations only (interrupt/close),
  not mail. A manually created session has no parent, so agents cannot close
  it; use the TUI. Deleting a parent from the TUI (outside Postal) can leave
  child parent records pointing at a missing session.
- **Grandchild policy**: direct parent only by default. `allowAncestorCommands`
  opt-in permits any ancestor. `orphanPolicy` decides what happens on parent
  close: `reparent` (default; notifies the grandparent and may wake its AI),
  `terminate` (destructive auto-close of the subtree), or `detach` (orphans
  cannot be closed by anyone).
- **Retries** use a 15-second scanner, six attempts, and exponential backoff up
  to five minutes. Delivered/acked records are kept for idempotency and audit;
  prune them if the outbox grows.
- **`postal_status`** sees busy/idle only while a TUI is publishing presence
  for that session or one of its peers. Headless sessions show `unknown`.
  Presence is TUI-sourced and expires after 30 seconds.
- **Presence payload**: only item IDs, types, and source session IDs cross the
  TUI→server bridge; message bodies stay in the TUI. Body previews are an
  explicit future opt-in.
- **HMAC Phase 1** authenticates the pair, not intent: a compromised peer with
  the pair key can still sign a malicious task. Task letters are additionally
  limited to parent/ancestor sessions. Keys live in the plugin KV and are
  same-location only; cross-location key distribution is Phase 2.
- **Manual root sessions** cannot receive `kind: "task"` from agents because
  they have no parent. Use the TUI or create a spawned worker.

### Ctrl+P commands

| Command | What it does |
|---|---|
| `Postal: New session` | Create a named session, open it in a tab, and make its ID readable immediately |
| `Postal: Select peer session` | Connect the current (or selected) session to another peer |
| `Postal: Close session` | Close the tab, or permanently delete the session after confirmation |
| `Postal: Disconnect peers` | Disconnect one peer, or every peer |
| `Postal: Show connected peers` | Show every peer connected to the session |
| `Postal: Reset rally` | Reset the shared rally counter |

The picker sorts sessions by recency and uses fuzzy search over titles and IDs.

### Session IDs at the start of a session

OpenCode creates a server-side session only when the first prompt is submitted.
Before that, the built-in new-session screen has no `ses_...` ID or title to
read, so the Postal footer shows:

```text
new session · ID assigned on first message
```

Use `Postal: New session` when you want a real ID and name before typing: the
command creates the session immediately, asks for an optional name, and opens
it in a new tab. `Postal: Close session` can then close just that tab or delete
the session (and all of its postal peers).

When the current session has connected peers, the footer appends them and
colors just that segment green, for example:

```text
Reviewer · ses_abc123 → Implementer, Tester
```

The peer entries are also green in the session picker, and the connected-peers
dialog shows each peer name in green. The state comes from `postal.status`, so
it also appears after a restart or when the peers were connected from another
TUI instance.

## How it works

```text
Session A ── @ses_B / postal_send ──▶ Postal ──▶ Session B
    ▲                                              │
    └──────────── reply / next rally ──────────────┘
```

- **Mention mode** runs on prompt admission only when the prompt starts with an
  `@ses_...` address. It forwards the text with `steer` and returns immediately.
  The receiver answers with `postal_send`, which starts the sender's next turn;
  no reply is parked in the sender's inbox. Mid-sentence, documentation, and
  code-fence mentions are ignored.
- **Tool mode** delivers with `steer` so an idle target starts immediately. The
  receiving AI replies with another `postal_send`.
- **Worker creation** uses `ctx.session.create` with the requested title,
  model, agent, directory, and permissions. `autoPair` connects the new
  session in both directions before returning its ID.
- **Multiple peers** are stored as an array per session
  (`peers/<sessionID>`). Connecting a new peer preserves the existing ones;
  `postal_send` without `to` requires exactly one peer.
- **Rally counter** is keyed by the sorted session pair
  (`rally/<min>:<max>`) and shared by both sides. It defaults to 30 letters per
  10-minute window (both configurable) and refuses sends beyond that unless
  `queueOnLimit` delays them through the outbox.
- **Pairing** is stored in the plugin `kv` table (`peers/<sessionID>`) and
  taught to both sessions. The old single-peer `peer/<sessionID>` record is
  migrated on first read.

## Configuration

Pass plugin options with the object form:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:mizuirorivi/postal",
      "options": {
        "maxRally": 10,
        "rallyWindowMinutes": 10,
        "allowAncestorCommands": false,
        "orphanPolicy": "reparent",
        "hmacWindowSeconds": 120,
        "keyGraceHours": 24,
        "watchdogAfterSeconds": 300,
        "watchdogIntervalSeconds": 600,
        "watchdogMaxNudges": 2,
        "outboxTtlDays": 7
      }
    }
  ]
}
```

`maxRally` is the per-conversation letter limit (default 30).
`rallyWindowMinutes` is the rolling window (default 10). Both are per-pair.
`allowAncestorCommands` lets any ancestor interrupt/close a descendant; the
default is direct-parent only. `orphanPolicy` is `reparent` (default),
`terminate`, or `detach`. `hmacWindowSeconds` (default 120) bounds signature
age; `keyGraceHours` (default 24) keeps a rotated key valid for verification.
`watchdogAfterSeconds` (300), `watchdogIntervalSeconds` (600), and
`watchdogMaxNudges` (2) tune nudges; `outboxTtlDays` (7) bounds outbox retention.

## Security model

**Message bodies are untrusted.** The plugin forwards bodies verbatim and only
interprets `@ses_*` tokens as addresses. A receiving AI may act on the content
(tools, commands, further mail), so treat mail like any other untrusted input.

**Prompt injection.** A malicious or compromised session can send instructions
to a peer. The rally limit bounds volume, not content. Mitigations:

- Require approval (or deny) for `postal_send` via the agent's tool permission
  rules.
- Pair only with sessions you trust; disconnect when done
  (`Postal: Disconnect peers`).
- Do not pair sessions that ingest untrusted external content with sessions
  that have powerful tool access.

**Audit.** Pairing and rally state live in the plugin `kv` table
(`peers/<sessionID>`, `rally/<pair>`). Letters and replies are in the session
transcripts; plugin failures are logged by the server. Review these when
investigating unexpected mail.

## Troubleshooting

- **Plugin not listed** — run `/reload`; check `opencode plugin list`.
- **`postal: no recipient`** — no peer is connected, or every connected peer was
  deleted. Run `Postal: Select peer session`, or pass `to` explicitly.
- **`n peers are connected`** — `postal_send` needs `to` when more than one peer
  is connected. Run `postal_peers` to list them.
- **`postal: rally limit reached`** — wait for the window, pass
  `queueOnLimit: true`, or run `Postal: Reset rally`.
- **Peer notes are missing** — this runtime does not expose
  `ctx.session.instructions.entry`; Postal deliberately skips the note instead
  of creating a queued message. The letter itself still includes the sender ID.
- **RPC is unavailable** — the TUI falls back to the prompt handshake; check the
  plugin is active for the current location.

## Development

The plugin is a local OpenCode plugin with no build step:

```text
index.ts    server part: tools, prompt hook, RPC, multi-peer pairing, rally
tui.tsx     Ctrl+P commands, session picker, footer status
sessions.ts session create/close/delete flow (testable without OpenTUI)
status.ts   route/session identity for the footer, including new-session state
rpc.ts      postal.connect / postal.disconnect / postal.status contract
lock.ts     per-conversation serialization for rally increments
fuzzy.ts    fuzzy matcher for the session picker
test/       Bun tests for multi-peer storage, async delivery, session lifecycle,
            and footer identity
skills/postal/SKILL.md  agent-facing usage guide
```

Run the tests with:

```sh
bun test
```

To test UI changes, place the directory under `.opencode/plugins/postal/` in a
project and run `/reload`.

## Runtime notes

- This runtime requires `events: {}` in the RPC contract. Without it,
  registration fails with `Object.entries requires that input parameter not be
  null or undefined`.
- `ctx.session.instructions.entry` is not available in this runtime; peer notes
  are skipped rather than queued. Every letter includes the sender's session ID
  so a reply can always pass `to` explicitly.
- RPC calls from the HTTP API need the location query, e.g.
  `POST /api/rpc/postal/connect?location[directory]=/path/to/project`.

## License

MIT. See [LICENSE](LICENSE).
