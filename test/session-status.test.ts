import { describe, expect, it } from "bun:test"
import {
  FOOTER_COLOR,
  FOOTER_CONNECTED_COLOR,
  footerIdentity,
  footerPresentation,
  preferredSessionID,
  realSessionID,
  routeSessionID,
} from "../status.js"

describe("routeSessionID", () => {
  it("reads the v2 session route", () => {
    expect(routeSessionID({ type: "session", sessionID: "ses_abc" })).toBe("ses_abc")
  })

  it("reads older route shapes", () => {
    expect(routeSessionID({ name: "ses_abc" })).toBe("ses_abc")
    expect(routeSessionID({ params: { sessionID: "ses_abc" } })).toBe("ses_abc")
    expect(routeSessionID({ params: { id: "ses_abc" } })).toBe("ses_abc")
  })

  it("returns undefined for home and non-route values", () => {
    expect(routeSessionID({ type: "home" })).toBeUndefined()
    expect(routeSessionID(undefined)).toBeUndefined()
    expect(routeSessionID("ses_abc")).toBeUndefined()
  })
})

describe("realSessionID", () => {
  it("accepts only server session IDs", () => {
    expect(realSessionID({ type: "session", sessionID: "ses_abc" })).toBe("ses_abc")
  })

  it("rejects the placeholder ID used while continuing a session", () => {
    expect(realSessionID({ type: "session", sessionID: "dummy" })).toBeUndefined()
  })
})

describe("preferredSessionID", () => {
  it("prefers a real server session over the home route and dummy placeholder", () => {
    expect(preferredSessionID([undefined, "dummy", "ses_abc"])).toBe("ses_abc")
  })

  it("uses the focused tab when the route is home", () => {
    expect(preferredSessionID([undefined, undefined, "ses_tab"])).toBe("ses_tab")
  })

  it("falls back to a placeholder only when no session exists", () => {
    expect(preferredSessionID([undefined, "dummy"])).toBe("dummy")
    expect(preferredSessionID([])).toBeUndefined()
  })
})

describe("footerIdentity", () => {
  it("explains that a new session has no ID until its first message", () => {
    expect(footerIdentity({})).toBe("new session · ID assigned on first message")
    expect(footerIdentity({ sessionID: "dummy" })).toBe("loading session…")
  })

  it("shows the title and session ID once the session exists", () => {
    expect(footerIdentity({ sessionID: "ses_abc", info: { id: "ses_abc", title: "Reviewer" } })).toBe(
      "Reviewer · ses_abc",
    )
  })

  it("falls back to (untitled) when the session has no name", () => {
    expect(footerIdentity({ sessionID: "ses_abc", info: { id: "ses_abc" } })).toBe("(untitled) · ses_abc")
    expect(footerIdentity({ sessionID: "ses_abc", info: { id: "ses_abc", title: "   " } })).toBe(
      "(untitled) · ses_abc",
    )
  })

  it("keeps showing the ID when the session data has not loaded yet", () => {
    expect(footerIdentity({ sessionID: "ses_abc" })).toBe("(untitled) · ses_abc")
  })
})

describe("footerPresentation", () => {
  it("keeps the muted color when no peer is connected", () => {
    const view = footerPresentation({ sessionID: "ses_a", info: { id: "ses_a", title: "Me" } })

    expect(view).toEqual({
      current: "Me · ses_a",
      peer: undefined,
      color: FOOTER_COLOR,
      peerColor: FOOTER_CONNECTED_COLOR,
    })
  })

  it("marks only the connected peers for the green color", () => {
    const view = footerPresentation({
      sessionID: "ses_a",
      info: { id: "ses_a", title: "Me" },
      peers: [
        { id: "ses_b", title: "Reviewer" },
        { id: "ses_c", title: "Writer" },
      ],
    })

    expect(view).toEqual({
      current: "Me · ses_a",
      peer: "Reviewer, Writer",
      color: FOOTER_COLOR,
      peerColor: FOOTER_CONNECTED_COLOR,
    })
    expect(view.peerColor).not.toBe(view.color)
  })

  it("falls back to the peer ID when a peer has no title", () => {
    const view = footerPresentation({
      sessionID: "ses_a",
      info: { id: "ses_a", title: "Me" },
      peers: [{ id: "ses_b" }],
    })

    expect(view.peer).toBe("ses_b")
  })

  it("does not show peers while the session is still a placeholder", () => {
    const view = footerPresentation({
      sessionID: "dummy",
      peers: [{ id: "ses_b", title: "Reviewer" }],
    })

    expect(view).toEqual({
      current: "loading session…",
      peer: undefined,
      color: FOOTER_COLOR,
      peerColor: FOOTER_CONNECTED_COLOR,
    })
  })
})
