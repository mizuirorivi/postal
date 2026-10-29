#!/usr/bin/env node
/**
 * Postal installer.
 *
 * Usage:
 *   npx github:mizuirorivi/postal            # global (~/.config/opencode/plugins/postal)
 *   npx github:mizuirorivi/postal --project . # <project>/.opencode/plugins/postal
 *   opencode-postal                          # same as the global form
 *
 * Copies the plugin sources into the OpenCode plugins directory. No build step.
 */
import { cpSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Postal installer

Usage:
  opencode-postal [--project <dir>]

Options:
  --project <dir>  Install into <dir>/.opencode/plugins/postal
  --help, -h       Show this help

Without --project, installs to:
  $XDG_CONFIG_HOME/opencode/plugins/postal
  (or ~/.config/opencode/plugins/postal)
`)
  process.exit(0)
}

let project = ""
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--project") {
    project = args[index + 1] ?? ""
    index += 1
  }
}

if (args.includes("--project") && !project) {
  console.error("error: --project requires a directory")
  process.exit(2)
}

const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
const target = project
  ? join(resolve(project), ".opencode", "plugins", "postal")
  : join(configHome, "opencode", "plugins", "postal")

const files = [
  "index.ts",
  "tui.tsx",
  "rpc.ts",
  "lock.ts",
  "fuzzy.ts",
  "package.json",
  "README.md",
  "LICENSE",
]

mkdirSync(target, { recursive: true })
for (const file of files) {
  cpSync(join(here, file), join(target, file))
}

const skillTarget = project
  ? join(resolve(project), ".opencode", "skills", "postal")
  : join(configHome, "opencode", "skills", "postal")
mkdirSync(skillTarget, { recursive: true })
cpSync(join(here, "skills", "postal", "SKILL.md"), join(skillTarget, "SKILL.md"))

console.log(`Postal installed to ${target}`)
console.log(`Postal skill installed to ${skillTarget}`)
console.log("Run /reload in OpenCode if the plugin does not appear.")
