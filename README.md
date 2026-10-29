# Postal — session-to-session mail for OpenCode

Postal turns separate OpenCode sessions into a small mail network. Pair two
sessions, then let their AIs talk — or send a letter from a human prompt with
`@ses_...`.

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
  Ctrl+P commands for pairing.

## Features

- `@ses_XXXX <message>` mention delivery with reply relay
- `postal_send` tool for AI-to-AI letters (non-blocking)
- `postal_directory` tool to list sessions
- Ctrl+P commands: connect, disconnect, show pair, reset rally
- Reply tokens so a mention reply is matched to the right letter
- Shared per-conversation rally counter (default 30 letters / 10 minutes)
- RPC (`postal.connect` / `postal.disconnect`) for exact TUI feedback
- Fuzzy session picker sorted by recency
- Current session title + ID in the prompt footer

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

```sh
opencode plugin remove github:mizuirorivi/postal
# or remove the cloned directory
rm -rf ~/.config/opencode/plugins/postal
```

### Requirements

- OpenCode v2.x (tested with 2.1.4)
- No npm dependencies; TypeScript sources are loaded directly

## Usage

### Human: mention a session

Type a normal prompt with a session ID:

```text
@ses_abc123 Please review the changes in src/foo.ts and reply with the risks.
```

Postal forwards the message to `ses_abc123`, waits for its reply, and admits the
reply back to your session as:

```text
[postal reply from ses_abc123 (reviewer)]
...
```

### AI: send mail

Ask an agent to use the tools:

```text
Use postal_directory to find the reviewer session, then postal_send a summary
of the current diff and ask for a review.
```

`postal_send` returns immediately. The peer receives a `[postal]` letter and can
continue the conversation by calling `postal_send` again. Omit `to` to write to
the peer connected via Ctrl+P.

### Ctrl+P commands

| Command | What it does |
|---|---|
| `Postal: Select peer session` | Pair the current (or selected) session with a peer |
| `Postal: Disconnect pair` | Remove the pairing on both sides |
| `Postal: Show current pair` | Show the connected peer |
| `Postal: Reset rally` | Reset the shared rally counter |

The picker sorts sessions by recency and uses fuzzy search over titles and IDs.

## How it works

```text
Session A ── @ses_B / postal_send ──▶ Postal ──▶ Session B
    ▲                                              │
    └──────────── reply / next rally ──────────────┘
```

- **Mention mode** runs on prompt admission. It forwards the text, waits for a
  reply token, and queues the reply in the sender's transcript.
- **Tool mode** delivers with `steer` so an idle target starts immediately. The
  receiving AI replies with another `postal_send`.
- **Rally counter** is keyed by the sorted session pair
  (`rally/<min>:<max>`) and shared by both sides. It defaults to 30 letters per
  10-minute window and refuses sends beyond that.
- **Pairing** is stored in the plugin `kv` table (`peer/<sessionID>`) and taught
  to both sessions.

## Configuration

Pass plugin options with the object form:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:mizuirorivi/postal",
      "options": { "maxRally": 10 }
    }
  ]
}
```

`maxRally` is the per-conversation letter limit (default 30). The 10-minute
window and the reply-token timeout are fixed.

## Security model

**Message bodies are untrusted.** The plugin forwards bodies verbatim and only
interprets `@ses_*` tokens as addresses. A receiving AI may act on the content
(tools, commands, further mail), so treat mail like any other untrusted input.

**Prompt injection.** A malicious or compromised session can send instructions
to a peer. The rally limit bounds volume, not content. Mitigations:

- Require approval (or deny) for `postal_send` via the agent's tool permission
  rules.
- Pair only with sessions you trust; disconnect when done
  (`Postal: Disconnect pair`).
- Do not pair sessions that ingest untrusted external content with sessions
  that have powerful tool access.

**Audit.** Pairing and rally state live in the plugin `kv` table
(`peer/<sessionID>`, `rally/<pair>`). Letters and replies are in the session
transcripts; plugin failures are logged by the server. Review these when
investigating unexpected mail.

## Troubleshooting

- **Plugin not listed** — run `/reload`; check `opencode plugin list`.
- **`postal: no recipient`** — no peer is connected, or the peer session was
  deleted. Run `Postal: Select peer session`.
- **`postal: rally limit reached`** — wait for the 10-minute window or run
  `Postal: Reset rally`.
- **Peer notes appear queued** — this runtime lacks
  `ctx.session.instructions.entry`, so the pairing note is delivered as a queued
  context message by design.
- **RPC is unavailable** — the TUI falls back to the prompt handshake; check the
  plugin is active for the current location.

## Development

The plugin is a local OpenCode plugin with no build step:

```text
index.ts    server part: tools, prompt hook, RPC, pairing, rally
tui.tsx     Ctrl+P commands, session picker, footer status
rpc.ts      postal.connect / postal.disconnect contract
lock.ts     per-conversation serialization for rally increments
fuzzy.ts    fuzzy matcher for the session picker
skills/postal/SKILL.md  agent-facing usage guide
```

To test changes, place the directory under `.opencode/plugins/postal/` in a
project and run `/reload`.

## Runtime notes

- This runtime requires `events: {}` in the RPC contract. Without it,
  registration fails with `Object.entries requires that input parameter not be
  null or undefined`.
- `ctx.session.instructions.entry` is not available in this runtime; peer notes
  fall back to a queued context message.
- RPC calls from the HTTP API need the location query, e.g.
  `POST /api/rpc/postal/connect?location[directory]=/path/to/project`.

## License

MIT. See [LICENSE](LICENSE).
