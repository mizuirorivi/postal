/**
 * Postal TUI — Ctrl+P commands.
 *
 * Commands:
 *   Postal: New session           create a session with a readable name and ID
 *   Postal: Select peer session   connect the current (or selected) session to another peer
 *   Postal: Close session          close the tab or delete the session
 *   Postal: Disconnect peers      remove one peer, or every peer
 *   Postal: Show connected peers  show every connected peer
 *   Postal: Reset rally           reset the shared rally counter
 *
 * The current session is taken from the router when available; otherwise the
 * command asks which session to use. Pickers are sorted by recency and use
 * fuzzy search over titles and session IDs.
 */
import { RGBA } from "@opentui/core"
import { createEffect, createSignal, on } from "solid-js"
import { fuzzySearch } from "./fuzzy.js"
import { PostalRpc } from "./rpc.js"
import { closeSessionCommand, newSessionCommand } from "./sessions.js"
import {
  FOOTER_COLOR,
  FOOTER_CONNECTED_COLOR,
  footerPresentation,
  preferredSessionID,
  routeSessionID,
} from "./status.js"

type SessionInfo = {
  id: string
  title?: string
  location?: { directory: string }
  time?: { created?: number; updated?: number }
}

type TuiContext = {
  location?: { directory: string; workspaceID?: string }
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
          footer?: string
          footerColor?: unknown
          fg?: unknown
        }>
      }): Promise<string | undefined>
      prompt(input: {
        title: string
        description?: string
        placeholder?: string
        value?: string
      }): Promise<string | undefined>
      confirm(input: {
        title: string
        message: string
        label?: { confirm?: string; cancel?: string }
      }): Promise<boolean | undefined>
      alert(input: { title: string; message: string }): Promise<unknown>
      set(options: { size?: "medium" | "large" | "xlarge"; centered?: boolean }): void
      show(render: () => unknown, onClose?: () => void): void
    }
    toast: { show(input: { title?: string; message: string; variant?: string; duration?: number }): void }
    router?: { current(): unknown; navigate?: (destination: { type: string; sessionID?: string }) => void }
    tabs?: {
      enabled(): boolean
      list(): Array<{ sessionID: string; title?: string; active: boolean }>
      focus(sessionID: string): boolean
      close(sessionID?: string): boolean
    }
  }
  route?: { current?: unknown }
  data: {
    session: {
      list(): SessionInfo[]
      get(sessionID: string): SessionInfo | undefined
      status?(sessionID: string): "idle" | "running"
      pending?: {
        list(sessionID: string): Array<any>
        sync(sessionID: string): Promise<void>
      }
    }
    location?: { default?: () => { directory: string } }
  }
  client: {
    rpc?: (contract: unknown) => {
      connect(input: { sessionID: string; peerID: string }): Promise<{ ok?: boolean; title?: string; error?: string }>
      disconnect(input: { sessionID: string; peerID?: string }): Promise<{ ok?: boolean; error?: string }>
      status(input: { sessionID: string }): Promise<{
        ok?: boolean
        peerID?: string
        title?: string
        peers?: PeerRecord[]
        error?: string
      }>
      presence(input: {
        sessions: Array<{
          id: string
          title?: string
          state: "idle" | "running" | "unknown"
          pending: Array<{ id?: string; type?: string; source?: string }>
        }>
      }): Promise<{ ok?: boolean; error?: string }>
    }
    session: {
      create?: (input: {
        title?: string
        location?: { directory: string }
      }) => Promise<{ id: string; title?: string } | { data?: { id: string; title?: string } }>
      remove?: (input: { sessionID: string }) => Promise<unknown>
      prompt(input: {
        sessionID: string
        text: string
        resume?: boolean
        metadata?: Record<string, unknown>
      }): Promise<unknown>
    }
  }
}

type PeerRecord = { id: string; title: string }

/** TUI-side cache of connected peers per session (display only). */
const knownPeers = new Map<string, PeerRecord[]>()

/** Session IDs that are connected to the focused session, used to color picker rows. */
const connectedPeers = new Set<string>()
const CONNECTED_COLOR_RGBA = RGBA.fromInts(127, 216, 143, 255)

function setKnownPeers(sessionID: string, peers: PeerRecord[]): void {
  if (peers.length === 0) knownPeers.delete(sessionID)
  else knownPeers.set(sessionID, peers)
}

function addKnownPeer(sessionID: string, peer: PeerRecord): void {
  const peers = knownPeers.get(sessionID) ?? []
  if (!peers.some((item) => item.id === peer.id)) peers.push(peer)
  knownPeers.set(sessionID, peers)
}

/** Refreshes the focused session's peer state after connect/disconnect/delete. */
let refreshPeerState: (() => void) | undefined

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Extract the source session from TUI inbox shapes without publishing the body. */
function pendingSource(item: any): string | undefined {
  const candidates = [
    item?.metadata?.postal?.from,
    item?.prompt?.metadata?.postal?.from,
    item?.source?.sessionID,
    item?.source,
    item?.from,
  ]
  return candidates.find((value) => typeof value === "string" && value.startsWith("ses"))
}

function currentRoute(context: TuiContext): unknown {
  try {
    const route = context.ui.router?.current()
    if (route) return route
  } catch {
    // Fall back to the legacy route accessor below.
  }
  try {
    return context.route?.current
  } catch {
    return undefined
  }
}

function activeTabSessionID(context: TuiContext): string {
  try {
    return context.ui.tabs?.list().find((tab) => tab.active)?.sessionID ?? ""
  } catch {
    return ""
  }
}

function currentSessionID(context: TuiContext): string {
  const sessionID = preferredSessionID([routeSessionID(currentRoute(context)), activeTabSessionID(context)])
  return sessionID?.startsWith("ses") ? sessionID : ""
}

function recentSessions(context: TuiContext): SessionInfo[] {
  return [...context.data.session.list()].sort(
    (left, right) => (right.time?.updated ?? right.time?.created ?? 0) - (left.time?.updated ?? left.time?.created ?? 0),
  )
}

function optionsFor(sessions: SessionInfo[]) {
  return sessions.map((session) => {
    const title = session.title?.trim() || "(untitled)"
    return {
      title,
      value: session.id,
      description: session.id,
      // The host colors the active row from `fg` and the footer from
      // `footerColor`. Creating JSX here would run outside the dialog render
      // context and abort the picker, so use the host's per-row fields.
      ...(connectedPeers.has(session.id)
        ? {
            fg: CONNECTED_COLOR_RGBA,
            footer: "connected",
            footerColor: CONNECTED_COLOR_RGBA,
          }
        : {}),
    }
  })
}

async function pickSession(context: TuiContext, title: string): Promise<string | undefined> {
  const sessions = recentSessions(context)
  if (sessions.length === 0) {
    context.ui.toast.show({ title: "Postal", message: "No sessions found", variant: "warning" })
    return undefined
  }
  try {
    return await context.ui.dialog.select({
      title,
      placeholder: "Search sessions (fuzzy)",
      options: optionsFor(sessions),
      search: fuzzySearch,
    })
  } catch (error) {
    context.ui.toast.show({
      title: "Postal",
      message: `Select session failed: ${errorMessage(error)}`,
      variant: "error",
    })
    return undefined
  }
}

/** Resolve the session to act on: router first, otherwise ask the user. */
async function resolveSession(context: TuiContext, pickerTitle: string): Promise<string | undefined> {
  const fromRoute = currentSessionID(context)
  if (fromRoute) return fromRoute
  return pickSession(context, pickerTitle)
}

async function newSession(context: TuiContext): Promise<void> {
  // Keep a session created from a tab in that tab's project, even when the
  // TUI's default location points elsewhere.
  const sourceID = currentSessionID(context)
  const source = sourceID ? context.data.session.get(sourceID) : undefined
  await newSessionCommand(context, { location: source?.location })
}

async function closeSession(context: TuiContext): Promise<void> {
  const sessionID = await resolveSession(context, "Postal: Select session to close")
  if (!sessionID) return
  const result = await closeSessionCommand(context, {
    sessionID,
    currentSessionID: currentSessionID(context),
  })
  if (result.ok && result.deleted) {
    knownPeers.delete(sessionID)
    refreshPeerState?.()
  }
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

  let peerID: string | undefined
  try {
    peerID = await context.ui.dialog.select({
      title: "Postal: Select peer session",
      placeholder: "Search sessions (fuzzy)",
      options: optionsFor(others),
      search: fuzzySearch,
    })
  } catch (error) {
    // A broken option renderer must not make the command silently do nothing.
    context.ui.toast.show({
      title: "Postal",
      message: `Select peer failed: ${errorMessage(error)}`,
      variant: "error",
    })
    return
  }
  if (!peerID) return

  const peerTitle = others.find((session) => session.id === peerID)?.title?.trim() || ""

  const rpc = context.client.rpc?.(PostalRpc)
  if (rpc) {
    try {
      const result = await rpc.connect({ sessionID, peerID })
      if (result?.ok === false) {
        context.ui.toast.show({
          title: "Postal",
          message: `Connect failed: ${result.error ?? "connect failed"}`,
          variant: "error",
        })
        return
      }
      addKnownPeer(sessionID, { id: peerID, title: result?.title || peerTitle })
      refreshPeerState?.()
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
    addKnownPeer(sessionID, { id: peerID, title: peerTitle })
    refreshPeerState?.()
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

  let list = knownPeers.get(sessionID) ?? []
  const rpc = context.client.rpc?.(PostalRpc)
  if (list.length === 0) {
    try {
      const status = await rpc?.status({ sessionID })
      if (status?.ok !== false) {
        list = status?.peers ?? (status?.peerID ? [{ id: status.peerID, title: status.title ?? "" }] : [])
        setKnownPeers(sessionID, list)
      }
    } catch {
      // Fall back to the cached list.
    }
  }
  if (list.length === 0) {
    context.ui.toast.show({ title: "Postal", message: "No connected peers", variant: "warning" })
    return
  }

  let choice: string | undefined = list[0]?.id
  if (list.length > 1) {
    choice = await context.ui.dialog.select({
      title: "Postal: Disconnect peer",
      placeholder: "Select a peer to disconnect",
      options: [
        ...list.map((peer) => ({
          title: peer.title || "(untitled)",
          value: peer.id,
          description: peer.id,
        })),
        { title: "All connected peers", value: "*", description: `Disconnect all ${list.length} peers` },
      ],
    })
    if (!choice) return
  }
  const target = choice === "*" ? undefined : choice
  const label = target ? list.find((peer) => peer.id === target)?.title || target : `${list.length} peers`
  const confirmed = await context.ui.dialog.confirm({
    title: "Postal",
    message: target ? `Disconnect "${label}"?` : `Disconnect all ${label}?`,
    label: { confirm: "Disconnect", cancel: "Cancel" },
  })
  if (!confirmed) return

  if (rpc) {
    try {
      const result = await rpc.disconnect({ sessionID, ...(target ? { peerID: target } : {}) })
      if (result?.ok === false) {
        context.ui.toast.show({
          title: "Postal",
          message: `Disconnect failed: ${result.error ?? "disconnect failed"}`,
          variant: "error",
        })
        return
      }
      if (target) {
        setKnownPeers(sessionID, list.filter((peer) => peer.id !== target))
      } else {
        knownPeers.delete(sessionID)
      }
      refreshPeerState?.()
      context.ui.toast.show({
        title: "Postal",
        message: target ? "Peer disconnected" : "All peers disconnected",
        variant: "success",
      })
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
      metadata: { postal: { disconnect: target ?? true } },
    })
    if (target) {
      setKnownPeers(sessionID, list.filter((peer) => peer.id !== target))
    } else {
      knownPeers.delete(sessionID)
    }
    refreshPeerState?.()
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

async function showPeers(context: TuiContext): Promise<void> {
  const sessionID = await resolveSession(context, "Postal: Select session to inspect")
  if (!sessionID) return
  let list = knownPeers.get(sessionID) ?? []
  try {
    const rpc = context.client.rpc?.(PostalRpc)
    const result = await rpc?.status({ sessionID })
    if (result?.ok !== false) {
      list = result?.peers ?? (result?.peerID ? [{ id: result.peerID, title: result.title ?? "" }] : [])
      setKnownPeers(sessionID, list)
    }
  } catch {
    // Fall back to the locally known peers.
  }
  if (list.length === 0) {
    await context.ui.dialog.alert({
      title: "Postal",
      message: "No connected peers.\n(Ctrl+P → Postal: Select peer session)",
    })
    return
  }
  context.ui.dialog.set({ size: "medium", centered: true })
  context.ui.dialog.show(() => (
    <box flexDirection="column" gap={1}>
      <text fg={FOOTER_COLOR}>{list.length === 1 ? "Connected peer" : "Connected peers"}</text>
      {list.map((peer) => (
        <box flexDirection="column">
          <text fg={FOOTER_CONNECTED_COLOR}>{peer.title || "(untitled)"}</text>
          <text fg={FOOTER_COLOR}>{peer.id}</text>
        </box>
      ))}
    </box>
  ))
}

const plugin = {
  id: "postal.tui",
  setup(context: TuiContext) {
    const [peerList, setPeerList] = createSignal<PeerRecord[]>([])
    let peerRequest = 0

    const refreshPeers = async (sessionID: string) => {
      const token = ++peerRequest
      if (!sessionID) {
        setPeerList([])
        connectedPeers.clear()
        return
      }
      // Show the locally known peers immediately, then confirm them with the
      // server so peers connected before a reload are still colored.
      const local = knownPeers.get(sessionID) ?? []
      setPeerList(local)
      connectedPeers.clear()
      for (const peer of local) connectedPeers.add(peer.id)
      try {
        const rpc = context.client.rpc?.(PostalRpc)
        if (typeof rpc?.status !== "function") return
        const result = await rpc.status({ sessionID })
        if (token !== peerRequest) return
        if (result?.ok !== false) {
          const list = result.peers ?? (result.peerID ? [{ id: result.peerID, title: result.title ?? "" }] : [])
          setKnownPeers(sessionID, list)
          setPeerList(list)
          connectedPeers.clear()
          for (const peer of list) connectedPeers.add(peer.id)
        } else {
          setPeerList([])
          connectedPeers.clear()
        }
      } catch {
        // Keep the local cache when the RPC is unavailable.
      }
    }

    const refresh = () => {
      void refreshPeers(currentSessionID(context))
    }
    refreshPeerState = refresh
    createEffect(refresh)

    // Publish busy/idle and pending-inbox metadata to the server. Only IDs,
    // types, and source session IDs are sent; message bodies stay in the TUI.
    let presenceBusy = false
    const publishPresence = async () => {
      if (presenceBusy) return
      presenceBusy = true
      try {
        const ids = new Set<string>()
        const focused = currentSessionID(context)
        if (focused) ids.add(focused)
        for (const peer of peerList()) ids.add(peer.id)
        if (ids.size === 0) return
        const sessions: Array<{
          id: string
          title: string
          state: "idle" | "running" | "unknown"
          pending: Array<{ id?: string; type?: string; source?: string }>
        }> = []
        for (const id of ids) {
          const info = context.data.session.get(id)
          if (!info) continue
          let state: "idle" | "running" | "unknown" = "unknown"
          try {
            state = context.data.session.status?.(id) ?? "unknown"
          } catch {
            state = "unknown"
          }
          const pendingApi = context.data.session.pending
          let pending: Array<{ id?: string; type?: string; source?: string }> = []
          if (pendingApi) {
            try {
              await pendingApi.sync(id)
              pending = pendingApi.list(id).slice(0, 20).map((item: any) => ({
                ...(typeof item?.id === "string" ? { id: item.id } : {}),
                ...(typeof item?.type === "string" ? { type: item.type } : {}),
                ...(pendingSource(item) ? { source: pendingSource(item) } : {}),
              }))
            } catch {
              pending = []
            }
          }
          sessions.push({ id, title: info.title ?? "", state, pending })
        }
        const rpc = context.client.rpc?.(PostalRpc)
        if (typeof rpc?.presence !== "function") return
        await rpc.presence({ sessions })
      } catch {
        // Presence is best effort; never break the TUI.
      } finally {
        presenceBusy = false
      }
    }
    const publishNow = () => {
      void publishPresence()
    }
    createEffect(on([peerList, () => currentSessionID(context)], publishNow, { defer: true }))
    void publishPresence()
    const presenceTimer = setInterval(publishNow, 5000)

    // Bottom-right status: current session title and ID, so it is easy to
    // search for the right session in the Postal picker. A paired session
    // appends its peers with the green accent.
    context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        const sessionID = preferredSessionID([
          input?.sessionID,
          routeSessionID(currentRoute(context)),
          activeTabSessionID(context),
        ])
        const info = sessionID?.startsWith("ses") ? context.data.session.get(sessionID) : undefined
        const view = footerPresentation({ sessionID, info, peers: peerList() })
        return (
          <text fg={view.color}>
            {view.current}
            {view.peer ? <span style={{ fg: view.peerColor }}>{` → ${view.peer}`}</span> : null}
          </text>
        )
      },
    })

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "postal.newSession",
          title: "Postal: New session",
          group: "Postal",
          palette: true,
          run: () => newSession(context),
        },
        {
          id: "postal.connect",
          title: "Postal: Select peer session",
          group: "Postal",
          palette: true,
          run: () => connect(context),
        },
        {
          id: "postal.closeSession",
          title: "Postal: Close session",
          group: "Postal",
          palette: true,
          run: () => closeSession(context),
        },
        {
          id: "postal.disconnect",
          title: "Postal: Disconnect peers",
          group: "Postal",
          palette: true,
          run: () => disconnect(context),
        },
        {
          id: "postal.peer",
          title: "Postal: Show connected peers",
          group: "Postal",
          palette: true,
          run: () => showPeers(context),
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

    return () => {
      clearInterval(presenceTimer)
      if (refreshPeerState === refresh) refreshPeerState = undefined
    }
  },
}

export default plugin
