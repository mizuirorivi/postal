/**
 * Current-session identity for the Postal footer.
 *
 * A brand-new OpenCode session has no server-side record until the first
 * prompt is submitted, so the route has no `ses_` ID yet. The footer says so
 * explicitly instead of disappearing, and still shows the ID as soon as one
 * exists.
 */

type RouteLike = {
  type?: unknown
  name?: unknown
  sessionID?: unknown
  params?: Record<string, unknown>
}

const NEW_SESSION_LABEL = "new session · ID assigned on first message"
const LOADING_LABEL = "loading session…"

/** Footer colors: muted for an unpaired session, green for connected peers. */
export const FOOTER_COLOR = "#8a8a8a"
export const FOOTER_CONNECTED_COLOR = "#7fd88f"

export type FooterPeer = { id: string; title?: string }
export type FooterPresentation = {
  current: string
  peer: string | undefined
  color: string
  peerColor: string
}

/** Return the route's raw session ID, including the `dummy` continue placeholder. */
export function routeSessionID(route: unknown): string | undefined {
  if (!route || typeof route !== "object") return undefined
  const value = route as RouteLike

  // v2 route shape: { type: "session", sessionID }
  if (value.type === "session" && typeof value.sessionID === "string" && value.sessionID.length > 0) {
    return value.sessionID
  }

  const candidates = [value.sessionID, value.params?.sessionID, value.params?.sessionId, value.params?.id]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.startsWith("ses")) return candidate
  }

  // Older route shape: { name: "ses_...", params }
  if (typeof value.name === "string" && value.name.startsWith("ses")) return value.name
  return undefined
}

/** Return the route's session ID only when it is a real server session. */
export function realSessionID(route: unknown): string | undefined {
  const sessionID = routeSessionID(route)
  return sessionID?.startsWith("ses") ? sessionID : undefined
}

/**
 * Pick the most useful session ID from the route, the focused tab, and the
 * footer input. A new session tab can be active while the route is still
 * `home`, so a real `ses_` ID always wins over the placeholder.
 */
export function preferredSessionID(candidates: ReadonlyArray<string | undefined>): string | undefined {
  return (
    candidates.find((id) => typeof id === "string" && id.startsWith("ses")) ??
    candidates.find((id) => typeof id === "string" && id.length > 0)
  )
}

/** Footer text for the current session, including the pre-session state. */
export function footerIdentity(input: { sessionID?: string; info?: { title?: string } | undefined }): string {
  const sessionID = input.sessionID
  if (!sessionID) return NEW_SESSION_LABEL
  if (sessionID === "dummy") return LOADING_LABEL
  if (!sessionID.startsWith("ses")) return NEW_SESSION_LABEL
  const title = input.info?.title?.trim() || "(untitled)"
  return `${title} · ${sessionID}`
}

/**
 * Footer text plus color. Connected peers get a distinct color and are named,
 * so the connected state is readable at a glance.
 */
export function footerPresentation(input: {
  sessionID?: string
  info?: { title?: string } | undefined
  peers?: ReadonlyArray<FooterPeer> | undefined
}): FooterPresentation {
  const current = footerIdentity({ sessionID: input.sessionID, info: input.info })
  const connected = input.sessionID?.startsWith("ses") ? (input.peers ?? []).filter((peer) => peer.id) : []
  const peer = connected.length
    ? connected.map((item) => item.title?.trim() || item.id).join(", ")
    : undefined
  return {
    current,
    peer,
    color: FOOTER_COLOR,
    peerColor: FOOTER_CONNECTED_COLOR,
  }
}
