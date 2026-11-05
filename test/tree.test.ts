import { describe, expect, it } from "bun:test"
import { renderSessionTree, type TreeContext, type TreeSession } from "../tree.js"

function fake(sessions: TreeSession[], parents: Record<string, string>, annotations?: Record<string, string>) {
  const storage = new Map<string, unknown>()
  for (const [child, parent] of Object.entries(parents)) {
    storage.set(`parent/${child}`, { parentID: parent })
  }
  const ctx: TreeContext = {
    session: { list: async () => ({ data: sessions }) },
    storage: {
      scan: async ({ prefix, after, limit }) => {
        const keys = [...storage.keys()].filter((key) => key.startsWith(prefix)).sort()
        const start = after ? keys.indexOf(after) + 1 : 0
        const slice = keys.slice(start, start + (limit ?? 200))
        return {
          entries: slice.map((key) => ({ key, value: storage.get(key) })),
          ...(start + slice.length < keys.length ? { next: slice.at(-1) } : {}),
        }
      },
    },
  }
  return { ctx, annotations }
}

const sessions: TreeSession[] = [
  { id: "ses_a", title: "Root" },
  { id: "ses_b", title: "Child" },
  { id: "ses_c", title: "Grandchild" },
  { id: "ses_d", title: "Other root" },
]

describe("session tree", () => {
  it("renders the caller's root subtree by default", async () => {
    const { ctx } = fake(sessions, { ses_b: "ses_a", ses_c: "ses_b" })
    const tree = await renderSessionTree(ctx, { callerID: "ses_c" })
    expect(tree).toContain("ses_a (Root)")
    expect(tree).toContain("ses_b (Child)")
    expect(tree).toContain("ses_c (Grandchild)")
    expect(tree).not.toContain("ses_d")
  })

  it("renders all roots, depth limits, and orphan markers", async () => {
    const orphan = [...sessions, { id: "ses_e", title: "Orphan" }]
    const { ctx } = fake(orphan, { ses_b: "ses_a", ses_c: "ses_b", ses_e: "ses_missing" })
    const all = await renderSessionTree(ctx, { callerID: "ses_c", all: true })
    expect(all).toContain("ses_d (Other root)")
    expect(all).toContain("missing parent: ses_missing")

    const shallow = await renderSessionTree(ctx, { callerID: "ses_c", depth: 1 })
    expect(shallow).toContain("ses_b")
    expect(shallow).not.toContain("ses_c (Grandchild)")
  })

  it("includes relation annotations", async () => {
    const { ctx } = fake(sessions, { ses_b: "ses_a" }, { ses_a: "→ses_b[send]" })
    const tree = await renderSessionTree(ctx, { callerID: "ses_a", annotations: { ses_a: "→ses_b[send]" } })
    expect(tree).toContain("→ses_b[send]")
  })
})
