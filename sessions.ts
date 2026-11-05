/**
 * Session lifecycle commands: create a session in a new tab and close or
 * delete one. Kept separate from `tui.tsx` so the command flow can be tested
 * without the OpenTUI runtime.
 */
import { PostalRpc } from "./rpc.js"

export type SessionInfo = { id: string; title?: string; location?: { directory: string } }
export type SessionLocation = { directory: string }

type CreatedSession = SessionInfo | { data?: SessionInfo }

export type SessionActionClient = {
  session: {
    create?: (input: { title?: string; location?: SessionLocation }) => Promise<CreatedSession>
    remove?: (input: { sessionID: string }) => Promise<unknown>
  }
  rpc?: (contract: unknown) => {
    disconnect(input: { sessionID: string }): Promise<{ ok?: boolean; error?: string }>
  }
}

export type SessionActionData = {
  session?: {
    get?: (sessionID: string) => SessionInfo | undefined
  }
  location?: {
    default?: () => SessionLocation
  }
}

export type SessionActionUi = {
  toast: {
    show(input: { title?: string; message: string; variant?: string; duration?: number }): void
  }
  router?: {
    navigate?(destination: { type: "home" } | { type: "session"; sessionID: string }): void
  }
  tabs?: {
    enabled(): boolean
    focus(sessionID: string): boolean
    close(sessionID?: string): boolean
  }
  dialog?: {
    prompt?(input: {
      title: string
      description?: string
      placeholder?: string
      value?: string
    }): Promise<string | undefined>
    select?<Value>(input: {
      title: string
      placeholder?: string
      options: Array<{ title: string; value: Value; description?: string }>
    }): Promise<Value | undefined>
    confirm?(input: {
      title: string
      message: string
      label?: { confirm?: string; cancel?: string }
    }): Promise<boolean | undefined>
  }
}

export type SessionActionContext = {
  location?: SessionLocation
  client: SessionActionClient
  data?: SessionActionData
  ui: SessionActionUi
}

export type CreateResult =
  | { ok: true; sessionID: string; title: string }
  | { ok: false; error?: string; cancelled?: boolean }

export type CloseResult =
  | { ok: true; deleted: boolean }
  | { ok: false; error?: string; cancelled?: boolean }

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function locationOf(context: SessionActionContext): SessionLocation | undefined {
  const location = context.location ?? context.data?.location?.default?.()
  if (!location?.directory) return undefined
  return { directory: location.directory }
}

function unwrapCreated(value: unknown): SessionInfo | undefined {
  if (!value || typeof value !== "object") return undefined
  const direct = value as SessionInfo
  if (typeof direct.id === "string" && direct.id.length > 0) return direct
  const wrapped = (value as { data?: unknown }).data
  if (wrapped && typeof wrapped === "object") {
    const info = wrapped as SessionInfo
    if (typeof info.id === "string" && info.id.length > 0) return info
  }
  return undefined
}

function navigate(
  context: SessionActionContext,
  destination: { type: "home" } | { type: "session"; sessionID: string },
): void {
  context.ui.router?.navigate?.(destination)
}

function revealSession(context: SessionActionContext, sessionID: string): void {
  const tabs = context.ui.tabs
  if (tabs) {
    try {
      if (tabs.enabled() && tabs.focus(sessionID)) return
    } catch {
      // Fall through to navigation when the tab API is unavailable.
    }
  }
  navigate(context, { type: "session", sessionID })
}

function closeTab(context: SessionActionContext, sessionID: string): boolean {
  try {
    return context.ui.tabs?.close(sessionID) ?? false
  } catch {
    return false
  }
}

/** Best-effort cleanup of every postal peer before a session is deleted. */
async function disconnectPeers(context: SessionActionContext, sessionID: string): Promise<void> {
  const factory = context.client.rpc
  if (typeof factory !== "function") return
  try {
    const rpc = factory(PostalRpc)
    const result = await rpc?.disconnect({ sessionID })
    if (result?.ok === false) {
      console.warn(`postal: disconnect ${sessionID} failed: ${result.error ?? "unknown error"}`)
    }
  } catch (error) {
    console.warn(`postal: disconnect ${sessionID} failed: ${errorText(error)}`)
  }
}

/** Create a session and reveal it in a tab (or the session route without tabs). */
export async function createSession(
  context: SessionActionContext,
  options: { title?: string; location?: SessionLocation } = {},
): Promise<CreateResult> {
  const title = options.title?.trim() || "Postal session"
  const create = context.client.session.create
  if (typeof create !== "function") {
    const error = "session creation is not supported by this OpenCode version"
    context.ui.toast.show({ title: "Postal", message: `New session failed: ${error}`, variant: "error" })
    return { ok: false, error }
  }

  try {
    const requested = options.location ?? locationOf(context)
    const location = requested?.directory ? { directory: requested.directory } : undefined
    const created = unwrapCreated(await create({ title, ...(location ? { location } : {}) }))
    if (!created) throw new Error("session create returned no id")
    const sessionTitle = created.title?.trim() || title
    revealSession(context, created.id)
    context.ui.toast.show({
      title: "Postal",
      message: `New session: ${sessionTitle} (${created.id})`,
      variant: "success",
    })
    return { ok: true, sessionID: created.id, title: sessionTitle }
  } catch (error) {
    const message = errorText(error)
    context.ui.toast.show({ title: "Postal", message: `New session failed: ${message}`, variant: "error" })
    return { ok: false, error: message }
  }
}

/** Ask for an optional name, then create the session. */
export async function newSessionCommand(
  context: SessionActionContext,
  options: { title?: string; promptForTitle?: boolean; location?: SessionLocation } = {},
): Promise<CreateResult> {
  let title = options.title
  if (options.promptForTitle !== false) {
    const dialog = context.ui.dialog
    if (typeof dialog?.prompt === "function") {
      const input = await dialog.prompt({
        title: "Postal: New session",
        description: "Name for the new session (optional)",
        placeholder: "Postal session",
      })
      if (input === undefined) return { ok: false, cancelled: true }
      title = input.trim() || undefined
    }
  }
  return createSession(context, { title, location: options.location })
}

/** Close a session tab, or delete the session permanently. */
export async function closeSession(
  context: SessionActionContext,
  options: { sessionID: string; currentSessionID?: string; deleteSession?: boolean },
): Promise<CloseResult> {
  const sessionID = options.sessionID?.trim()
  if (!sessionID) {
    const error = "no session selected"
    context.ui.toast.show({ title: "Postal", message: `Close failed: ${error}`, variant: "warning" })
    return { ok: false, error }
  }

  const info = context.data?.session?.get?.(sessionID)
  const label = info?.title?.trim() || sessionID
  const isCurrent = options.currentSessionID === sessionID

  if (options.deleteSession) {
    const remove = context.client.session.remove
    if (typeof remove !== "function") {
      const error = "session deletion is not supported by this OpenCode version"
      context.ui.toast.show({ title: "Postal", message: `Delete failed: ${error}`, variant: "error" })
      return { ok: false, error }
    }
    // Delete first: if removal fails, keep the peer records untouched.
    try {
      await remove({ sessionID })
    } catch (error) {
      const message = errorText(error)
      context.ui.toast.show({ title: "Postal", message: `Delete failed: ${message}`, variant: "error" })
      return { ok: false, error: message }
    }
    await disconnectPeers(context, sessionID)
    closeTab(context, sessionID)
    if (isCurrent) navigate(context, { type: "home" })
    context.ui.toast.show({ title: "Postal", message: `Deleted session: ${label}`, variant: "success" })
    return { ok: true, deleted: true }
  }

  const closed = closeTab(context, sessionID)
  if (!closed && !isCurrent) {
    const error = "session tab is not open"
    context.ui.toast.show({ title: "Postal", message: `Close failed: ${error}`, variant: "warning" })
    return { ok: false, error }
  }
  if (isCurrent) navigate(context, { type: "home" })
  context.ui.toast.show({ title: "Postal", message: `Closed tab: ${label}`, variant: "success" })
  return { ok: true, deleted: false }
}

/** Choose between closing the tab and deleting the session, then apply it. */
export async function closeSessionCommand(
  context: SessionActionContext,
  options: { sessionID?: string; currentSessionID?: string } = {},
): Promise<CloseResult> {
  const sessionID = options.sessionID?.trim()
  if (!sessionID) {
    context.ui.toast.show({ title: "Postal", message: "No session selected", variant: "warning" })
    return { ok: false, error: "no session selected" }
  }

  const dialog = context.ui.dialog
  if (typeof dialog?.select !== "function") {
    return closeSession(context, { sessionID, currentSessionID: options.currentSessionID })
  }

  const info = context.data?.session?.get?.(sessionID)
  const label = info?.title?.trim() || sessionID
  const action = await dialog.select<"tab" | "delete">({
    title: "Postal: Close session",
    options: [
      { title: "Close tab", value: "tab", description: "Keep the session and its history" },
      { title: "Delete session", value: "delete", description: "Remove the session permanently" },
    ],
  })
  if (!action) return { ok: false, cancelled: true }

  if (action === "delete") {
    if (typeof dialog.confirm === "function") {
      const confirmed = await dialog.confirm({
        title: "Postal: Delete session",
        message: `Delete "${label}" permanently? Postal peers are disconnected.`,
        label: { confirm: "Delete", cancel: "Cancel" },
      })
      if (!confirmed) return { ok: false, cancelled: true }
    }
  }

  return closeSession(context, {
    sessionID,
    currentSessionID: options.currentSessionID,
    deleteSession: action === "delete",
  })
}
