import { describe, expect, it } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverService } from "../forms.js"

function writeRegistration(mode: number): string {
  const root = mkdtempSync(join(tmpdir(), "postal-perm-"))
  const dir = join(root, "opencode")
  mkdirSync(dir, { recursive: true })
  const file = join(dir, "service.json")
  writeFileSync(file, JSON.stringify({ url: "http://127.0.0.1:1234", password: "pw" }), { mode })
  chmodSync(file, mode)
  return root
}

function captureWarnings(run: () => void): string {
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.join(" "))
  }
  try {
    run()
  } finally {
    console.warn = originalWarn
  }
  return warnings.join("\n")
}

describe("service registration permissions", () => {
  it("warns when the registration is group/world readable", () => {
    const root = writeRegistration(0o644)
    let endpoint: ReturnType<typeof discoverService>
    const warnings = captureWarnings(() => {
      endpoint = discoverService({
        env: { XDG_STATE_HOME: root },
        home: "/nonexistent-postal-home",
        readFile: (path) => readFileSync(path, "utf8"),
      })
    })
    expect(endpoint).toMatchObject({ url: "http://127.0.0.1:1234", password: "pw" })
    expect(warnings).toContain("group/world readable")
  })

  it("does not warn for a 0600 registration", () => {
    const root = writeRegistration(0o600)
    const warnings = captureWarnings(() => {
      discoverService({
        env: { XDG_STATE_HOME: root },
        home: "/nonexistent-postal-home",
        readFile: (path) => readFileSync(path, "utf8"),
      })
    })
    expect(warnings).not.toContain("group/world readable")
  })
})
