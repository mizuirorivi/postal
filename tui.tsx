/**
 * Postal TUI — Ctrl+P commands.
 *
 * Commands:
 *   Postal: Select peer session   connect the current (or selected) session to a peer
 *   Postal: Disconnect pair       remove the pairing on both sides
 *   Postal: Show current pair     show the connected peer
 *   Postal: Reset rally           reset the shared rally counter
 *
 * The current session is taken from the router when available; otherwise the
 * command asks which session to use. Pickers are sorted by recency and use
 * fuzzy search over titles and session IDs.
 */
import { fuzzySearch } from "./fuzzy.js"
import { PostalRpc } from "./rpc.js"

type SessionInfo = { id: string; title?: string; time?: { created?: number; updated?: number } }

type RouteLike = {
  type?: unknown
  name?: unknown
  sessionID?: unknown
  params?: Record<string, unknown>
}

type TuiContext = {
  keymap: {
    layer(factory: () => {
      mode: string
      priority?: number
      commands: Array<{
        id: string
        title: string
        group?: string
        palette?: boolean
        run: () => unknown
      }>
    }): unknown
  }
  ui: {
    slot(input: {
      append?: string
      prepend?: string
      before?: string
      after?: string
      replace?: string
      render: (input?: { sessionID?: string }) => unknown
    }): unknown
    dialog: {
      select(input: {
        title: string
        placeholder?: string
        options: Array<{
        title: string
        value: string
        description?: string
      }>
      }): Promise<string | undefined>
      confirm(input: {
        title: string
        message: string
        label?: { confirm?: string; cancel?: string }
      }): Promise<boolean>
      alert(input: { title: string; message: string }): Promise<unknown>
    }
    toast: { show(input: { title?: string; message: string; variant?: string; duration?: number }): void }
    router?: { current(): unknown }
  }
  route?: { current?: unknown }
  data: { session: { list(): SessionInfo[]; get(sessionID: string): SessionInfo | undefined } }
  client: {
    rpc?: (contract: unknown) => {
      connect(input: { sessionID: string; peerID: string }): Promise<{ ok?: boolean; title?: string; error?: string }>
      disconnect(input: { sessionID: string }): Promise<{ ok?: boolean; error?: string }>
    }
    session: {
      prompt(input: {
        sessionID: string
        text: string
        resume?: boolean
        metadata?: Record<string, unknown>
      }): Promise<unknown>
    }
  }
}

/** TUI-side view of pairings made through this command (display only). */
const peers = new Map<string, { id: string; title: string }>()

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function idFromRoute(route: unknown): string {
  if (!route || typeof route !== "object") return ""
  const value = route as RouteLike
  // v2 route shape: { type: "session", sessionID }
  if (value.type === "session" && typeof value.sessionID === "string") return value.sessionID
  const candidates = [value.sessionID, value.params?.sessionID, value.params?.sessionId, value.params?.id]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.startsWith("ses")) return candidate
  }
  if (typeof value.name === "string" && value.name.startsWith("ses")) return value.name
  return ""
}

function currentSessionID(context: TuiContext): string {
  let id = ""
  try {
    id = idFromRoute(context.ui.router?.current())
  } catch {
    id = ""
  }
  if (!id) {
    try {
      id = idFromRoute(context.route?.current)
    } catch {
      id = ""
    }
  }
  return id
}

function recentSessions(context: TuiContext): SessionInfo[] {
  return [...context.data.session.list()].sort(
    (left, right) => (right.time?.updated ?? right.time?.created ?? 0) - (left.time?.updated ?? left.time?.created ?? 0),
  )
}

function optionsFor(sessions: SessionInfo[]) {
  return sessions.map((session) => ({
    title: session.title?.trim() || "(untitled)",
    value: session.id,
    description: session.id,
  }))
}

async function pickSession(context: TuiContext, title: string): Promise<string | undefined> {
  const sessions = recentSessions(context)
  if (sessions.length === 0) {
    context.ui.toast.show({ title: "Postal", message: "No sessions found", variant: "warning" })
    return undefined
  }
  return context.ui.dialog.select({
    title,
    placeholder: "Search sessions (fuzzy)",
    options: optionsFor(sessions),
    search: fuzzySearch,
  })
}

/** Resolve the session to act on: router first, otherwise ask the user. */
async function resolveSession(context: TuiContext, pickerTitle: string): Promise<string | undefined> {
  const fromRoute = currentSessionID(context)
  if (fromRoute) return fromRoute
  return pickSession(context, pickerTitle)
}

async function connect(context: TuiContext): Promise<void> {
  const sessionID = await resolveSession(context, "Postal: Select source session")
  if (!sessionID) return

  const others = recentSessions(context).filter((session) => session.id !== sessionID)
  if (others.length === 0) {
    context.ui.toast.show({
      title: "Postal",
      message: "No other sessions to connect",
      variant: "warning",
    })
    return
  }

  const peerID = await context.ui.dialog.select({
    title: "Postal: Select peer session",
    placeholder: "Search sessions (fuzzy)",
    options: optionsFor(others),
    search: fuzzySearch,
  })
  if (!peerID) return

  const peerTitle = others.find((session) => session.id === peerID)?.title?.trim() || ""

  const rpc = context.client.rpc?.(PostalRpc)
  if (rpc) {
    try {
      const result = await rpc.connect({ sessionID, peerID })
      if (result?.ok === false) {
        context.ui.toast.show({
          title: "Postal",
          message: `Connect failed: ${result.error ?? "pairing failed"}`,
          variant: "error",
        })
        return
      }
      peers.set(sessionID, { id: peerID, title: result?.title || peerTitle })
      context.ui.toast.show({
        title: "Postal",
        message: `Connected: ${result?.title || peerTitle || peerID}`,
        variant: "success",
      })
      return
    } catch {
      // RPC unavailable at runtime: fall through to the prompt handshake.
    }
  }

  try {
    // The server part observes metadata.postal.connect during prompt admission:
    // it stores the peer on both sides and writes the address into instructions.
    await context.client.session.prompt({
      sessionID,
      text: `[postal] connect ${peerID}`,
      resume: false,
      metadata: { postal: { connect: peerID } },
    })
    peers.set(sessionID, { id: peerID, title: peerTitle })
    context.ui.toast.show({
      title: "Postal",
      message: `Connecting: ${peerTitle || peerID}`,
      variant: "info",
    })
  } catch (error) {
    context.ui.toast.show({
      title: "Postal",
      message: `Connect failed: ${errorMessage(error)}`,
      variant: "error",
    })
  }
}

async function disconnect(context: TuiContext): Promise<void> {
  const sessionID = await resolveSession(context, "Postal: Select session to disconnect")
  if (!sessionID) return

  const peer = peers.get(sessionID)
  const confirmed = await context.ui.dialog.confirm({
    title: "Postal",
    message: peer
      ? `Disconnect the current pair "${peer.title || peer.id}"?`
      : "Disconnect this session's pair?",
    label: { confirm: "Disconnect", cancel: "Cancel" },
  })
  if (!confirmed) return

  const rpc = context.client.rpc?.(PostalRpc)
  if (rpc) {
    try {
      const result = await rpc.disconnect({ sessionID })
      if (result?.ok === false) {
        context.ui.toast.show({
          title: "Postal",
          message: `Disconnect failed: ${result.error ?? "disconnect failed"}`,
          variant: "error",
        })
        return
      }
      peers.delete(sessionID)
      context.ui.toast.show({ title: "Postal", message: "Pair disconnected", variant: "success" })
      return
    } catch {
      // RPC unavailable at runtime: fall through to the prompt handshake.
    }
  }

  try {
    await context.client.session.prompt({
      sessionID,
      text: "[postal] disconnect",
      resume: false,
      metadata: { postal: { disconnect: true } },
    })
    peers.delete(sessionID)
    context.ui.toast.show({ title: "Postal", message: "Disconnecting…", variant: "info" })
  } catch (error) {
    context.ui.toast.show({
      title: "Postal",
      message: `Disconnect failed: ${errorMessage(error)}`,
      variant: "error",
    })
  }
}

async function resetRally(context: TuiContext): Promise<void> {
  const sessionID = await resolveSession(context, "Postal: Select session to reset")
  if (!sessionID) return
  try {
    await context.client.session.prompt({
      sessionID,
      text: "[postal] reset rally",
      resume: false,
      metadata: { postal: { resetRally: true } },
    })
    context.ui.toast.show({ title: "Postal", message: "Rally counter reset", variant: "success" })
  } catch (error) {
    context.ui.toast.show({
      title: "Postal",
      message: `Reset failed: ${errorMessage(error)}`,
      variant: "error",
    })
  }
}

async function showPeer(context: TuiContext): Promise<void> {
  const sessionID = await resolveSession(context, "Postal: Select session to inspect")
  if (!sessionID) return
  const peer = peers.get(sessionID)
  await context.ui.dialog.alert({
    title: "Postal",
    message: peer
      ? `Connected peer: ${peer.title || "(untitled)"}\n${peer.id}`
      : "No pair for this session.\n(Ctrl+P → Postal: Select peer session)",
  })
}

const plugin = {
  id: "postal.tui",
  setup(context: TuiContext) {
    // Bottom-right status: current session title and ID, so it is easy to
    // search for the right session in the Postal picker.
    context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        const sessionID = input?.sessionID ?? currentSessionID(context)
        if (!sessionID) return null
        const info = context.data.session.get(sessionID)
        const title = info?.title?.trim() || "(untitled)"
        return <text fg="#8a8a8a">{`${title} · ${sessionID}`}</text>
      },
    })

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "postal.connect",
          title: "Postal: Select peer session",
          group: "Postal",
          palette: true,
          run: () => connect(context),
        },
        {
          id: "postal.disconnect",
          title: "Postal: Disconnect pair",
          group: "Postal",
          palette: true,
          run: () => disconnect(context),
        },
        {
          id: "postal.peer",
          title: "Postal: Show current pair",
          group: "Postal",
          palette: true,
          run: () => showPeer(context),
        },
        {
          id: "postal.resetRally",
          title: "Postal: Reset rally",
          group: "Postal",
          palette: true,
          run: () => resetRally(context),
        },
      ],
    }))
  },
}

export default plugin
