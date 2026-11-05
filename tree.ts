/**
 * Session hierarchy rendering for Postal.
 *
 * Sources are merged in this order:
 * 1. OpenCode's native `Session.Info.parentID` (covers forks and manual sessions)
 * 2. Postal's `parent/<id>` and `children/<id>` records (authoritative for spawns)
 *
 * Postal records win because they are written by `postal_spawn`.
 */

export type TreeSession = {
  id: string
  title?: string
  parentID?: string
  location?: { directory?: string } | string
}

export type TreeContext = {
  session: {
    list(input?: Record<string, unknown>): Promise<{ data: TreeSession[]; cursor?: { next?: string } }>
  }
  storage: {
    scan?(input: {
      prefix: string
      after?: string
      limit?: number
    }): Promise<{ entries: Array<{ key: string; value: unknown }>; next?: string }>
  }
}

export type TreeOptions = {
  callerID: string
  root?: string
  depth?: number
  all?: boolean
  maxSessions?: number
  annotations?: Record<string, string>
}

const MAX_DEPTH = 32

export async function renderSessionTree(ctx: TreeContext, options: TreeOptions): Promise<string> {
  const sessions = await loadSessions(ctx, options.maxSessions ?? 500)
  if (sessions.length === 0) return "postal: no sessions"

  const byID = new Map<string, TreeSession>()
  for (const session of sessions) byID.set(session.id, session)

  const parentOf = new Map<string, string>()
  for (const session of sessions) {
    if (session.parentID) parentOf.set(session.id, session.parentID)
  }
  for (const entry of await scan(ctx, "parent/")) {
    const id = entry.key.slice("parent/".length)
    const value = entry.value as { parentID?: unknown } | undefined
    if (typeof value?.parentID === "string" && value.parentID) parentOf.set(id, value.parentID)
  }

  const childrenOf = new Map<string, string[]>()
  const addChild = (parent: string, child: string): void => {
    const children = childrenOf.get(parent) ?? []
    if (!children.includes(child)) children.push(child)
    childrenOf.set(parent, children)
  }
  for (const [child, parent] of parentOf) addChild(parent, child)
  for (const entry of await scan(ctx, "children/")) {
    const parent = entry.key.slice("children/".length)
    if (!Array.isArray(entry.value)) continue
    for (const child of entry.value) {
      if (typeof child === "string" && child) addChild(parent, child)
    }
  }

  const ensure = (id: string): void => {
    if (!byID.has(id)) byID.set(id, { id, title: "(missing)" })
  }
  for (const [child] of parentOf) ensure(child)
  for (const [, children] of childrenOf) {
    for (const child of children) ensure(child)
  }

  const rootOf = (id: string): string => {
    let current = id
    const seen = new Set<string>()
    for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
      const parent = parentOf.get(current)
      if (!parent || !byID.has(parent) || seen.has(parent)) return current
      seen.add(current)
      current = parent
    }
    return current
  }

  const roots = [...byID.keys()].filter((id) => {
    const parent = parentOf.get(id)
    return !parent || !byID.has(parent)
  })

  const targetRoot = options.root
    ? byID.has(options.root)
      ? options.root
      : undefined
    : options.all
      ? undefined
      : byID.has(options.callerID)
        ? rootOf(options.callerID)
        : undefined

  if (options.root && !targetRoot) return `postal: session not found: ${options.root}`

  const depthLimit = Math.max(1, Math.min(MAX_DEPTH, Math.floor(options.depth ?? MAX_DEPTH)))
  const lines: string[] = []

  const render = (id: string, prefix: string, isLast: boolean, depth: number, ancestors: Set<string>): void => {
    const node = byID.get(id)
    if (!node) return
    const flags: string[] = []
    if (id === options.callerID) flags.push("[you]")
    const parent = parentOf.get(id)
    if (parent && !byID.has(parent)) flags.push(`[missing parent: ${parent}]`)
    if (ancestors.has(id)) {
      lines.push(`${prefix}${isLast ? "└── " : "├── "}${label(node, flags, options.annotations?.[id])} [cycle]`)
      return
    }
    if (depth === 0) {
      lines.push(label(node, flags, options.annotations?.[id]))
    } else {
      lines.push(`${prefix}${isLast ? "└── " : "├── "}${label(node, flags, options.annotations?.[id])}`)
    }
    if (depth >= depthLimit) {
      const children = visibleChildren(id)
      if (children.length > 0) lines.push(`${prefix}${isLast ? "    " : "│   "}└── …`)
      return
    }
    const nextAncestors = new Set(ancestors)
    nextAncestors.add(id)
    const children = visibleChildren(id)
    children.forEach((child, index) => {
      const childIsLast = index === children.length - 1
      const childPrefix = depth === 0 ? "" : `${prefix}${isLast ? "    " : "│   "}`
      render(child, childPrefix, childIsLast, depth + 1, nextAncestors)
    })
  }

  const visibleChildren = (id: string): string[] =>
    (childrenOf.get(id) ?? []).filter((child) => byID.has(child)).sort(compareSessions(byID))

  const renderRoot = (id: string): void => {
    const node = byID.get(id)
    if (!node) return
    const flags: string[] = []
    if (id === options.callerID) flags.push("[you]")
    const parent = parentOf.get(id)
    if (parent && !byID.has(parent)) flags.push(`[missing parent: ${parent}]`)
    lines.push(label(node, flags, options.annotations?.[id]))
    const children = visibleChildren(id)
    children.forEach((child, index) => {
      render(child, "", index === children.length - 1, 1, new Set([id]))
    })
  }

  if (targetRoot) {
    renderRoot(targetRoot)
  } else {
    const sortedRoots = roots.sort(compareSessions(byID))
    sortedRoots.forEach((root, index) => {
      if (index > 0) lines.push("")
      renderRoot(root)
    })
  }

  return lines.length > 0 ? lines.join("\n") : "postal: no sessions"
}

function label(node: TreeSession, flags: string[], annotation?: string): string {
  const title = node.title ? ` (${node.title})` : ""
  return `${node.id}${title}${flags.length > 0 ? ` ${flags.join(" ")}` : ""}${annotation ? ` ${annotation}` : ""}`
}

function compareSessions(byID: Map<string, TreeSession>): (a: string, b: string) => number {
  return (a, b) => {
    const left = byID.get(a)
    const right = byID.get(b)
    return (left?.title ?? a).localeCompare(right?.title ?? b) || a.localeCompare(b)
  }
}

async function loadSessions(ctx: TreeContext, maxSessions: number): Promise<TreeSession[]> {
  const sessions: TreeSession[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < 20 && sessions.length < maxSessions; page += 1) {
    const result = await ctx.session.list({
      limit: Math.min(200, maxSessions - sessions.length),
      ...(cursor ? { cursor } : {}),
    })
    for (const session of result.data ?? []) {
      if (!session?.id || seen.has(session.id)) continue
      seen.add(session.id)
      sessions.push(session)
    }
    cursor = result.cursor?.next
    if (!cursor) break
  }
  return sessions
}

async function scan(ctx: TreeContext, prefix: string): Promise<Array<{ key: string; value: unknown }>> {
  if (typeof ctx.storage.scan !== "function") return []
  const entries: Array<{ key: string; value: unknown }> = []
  let after: string | undefined
  for (let page = 0; page < 20; page += 1) {
    const result = await ctx.storage.scan({ prefix, limit: 200, ...(after ? { after } : {}) })
    entries.push(...(result.entries ?? []))
    after = result.next
    if (!after) break
  }
  return entries
}
