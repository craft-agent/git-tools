import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = fileURLToPath(new URL("../../", import.meta.url))
const ORIGIN = "https://github.com/acme/widget-tools.git"
const REQUIRED = ["--prefix", "widget", "--description", "Widget tools for agents."]
const GIT_IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false"]

/** What no file may still say once the starter is renamed. */
const LEFTOVERS = [
  "agent-tool-starter",
  "agent_tool_starter",
  "AGENT_TOOL_STARTER",
  "<!-- starter",
  "example_",
  "example-notes",
]

/** The file the setup writes after the renames, which names the starter on purpose. */
const STARTER_REFERENCE = "opencode.jsonc"

let workspace
let template

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  if (command === "git" && result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
  return result
}

const git = (cwd, ...args) => run("git", args, cwd).stdout
const setup = (cwd, ...args) => run("node", ["scripts/setup/main.mjs", ...args], cwd)
const commitAll = (cwd) => {
  git(cwd, "add", "-A")
  git(cwd, ...GIT_IDENTITY, "commit", "-m", "snapshot")
}

/** A committed copy of this repository's working tree (uncommitted files included) with a GitHub origin. */
function makeTemplate(dir) {
  const files = git(REPO, "ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean)
  for (const file of files) {
    if (!existsSync(join(REPO, file))) continue
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    cpSync(join(REPO, file), join(dir, file))
  }
  git(dir, "init", "-q")
  git(dir, "remote", "add", "origin", ORIGIN)
  commitAll(dir)
}

/** A fresh checkout of the template. */
function checkout(name) {
  const dir = join(workspace, name)
  cpSync(template, dir, { recursive: true })
  return dir
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === ".git") return []
    const path = join(dir, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  })
}

const read = (dir, file) => readFileSync(join(dir, file), "utf8")
const readJson = (dir, file) => JSON.parse(read(dir, file))

function expectNoLeftovers(dir, leftovers = LEFTOVERS) {
  const files = walk(dir).filter((path) => relative(dir, path) !== STARTER_REFERENCE)
  const hits = files.flatMap((path) => {
    const text = readFileSync(path, "utf8")
    return leftovers
      .filter((leftover) => text.includes(leftover))
      .map((leftover) => `${relative(dir, path)}: ${leftover}`)
  })
  expect(hits).toEqual([])
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "setup-e2e-"))
  template = join(workspace, "template")
  mkdirSync(template)
  makeTemplate(template)
})

afterAll(() => rmSync(workspace, { recursive: true, force: true }))

describe("the setup on a clone of the starter", () => {
  test("renames everything and removes the example, the markers and itself", () => {
    const dir = checkout("default")
    const result = setup(dir, ...REQUIRED, "--yes")
    expect(result.stderr).not.toContain("Error")
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("pnpm run build && pnpm run manifests")

    expectNoLeftovers(dir)
    const pkg = readJson(dir, "package.json")
    expect(pkg).toMatchObject({ name: "@acme/widget-tools", mcpName: "io.github.acme/widget-tools", author: "acme" })
    expect(pkg.version).toBe("0.0.0")
    expect(read(dir, "plugin.yaml")).toContain("\nversion: 0.0.0\n")
    expect(readJson(dir, ".claude-plugin/plugin.json").version).toBe("0.0.0")
    expect(pkg.description).toBe("Widget tools for agents.")
    expect(pkg).not.toHaveProperty("private")
    expect(pkg.scripts).not.toHaveProperty("setup")
    expect(pkg.devDependencies["@craftsamo/repo-kit"]).toBeString()
    expect(read(dir, ".github/workflows/release-draft.yml")).toContain("craftsamo/repo-kit/")
    expect(read(dir, "src/hermes/widget_tools_hermes/project.py")).toContain('SKILL_PREFIX = "widget-"')
    expect(existsSync(join(dir, "src/hermes/agent_tool_starter_hermes"))).toBe(false)
    expect(existsSync(join(dir, "src/core/example"))).toBe(false)
    expect(existsSync(join(dir, "skills/example-notes"))).toBe(false)
    expect(existsSync(join(dir, "scripts/setup"))).toBe(false)
    expect(read(dir, "skills/.gitkeep")).toBe("")
    expect(read(dir, "src/tools.ts")).toContain("export const ALL_TOOLS: ToolSpec[] = []\n")
    expect(read(dir, "plugin.yaml")).toContain("provides_tools: []\n")
    expect(read(dir, "src/project.ts")).toContain('toolPrefix: "widget"')
    expect(read(dir, "src/project.ts")).toContain("toolsets: [] as readonly string[]")
    expect(read(dir, ".claude-plugin/marketplace.json")).toContain('"name": "acme"')
    expect(read(dir, "LICENSE")).toContain("Copyright (c) 2026 acme")
    expect(read(dir, "README.md")).not.toContain("Using this starter")
    expect(read(dir, STARTER_REFERENCE)).toContain('"repository": "craftsamo/agent-tool-starter"')
    expect(readJson(dir, "plugin.json").author).toEqual({ name: "acme", url: "https://github.com/acme" })
    expect(readJson(dir, ".claude-plugin/plugin.json").author).toEqual({ name: "acme", url: "https://github.com/acme" })
    expect(readJson(dir, ".antigravity-plugin/plugin.json").author).toEqual({
      name: "acme",
      url: "https://github.com/acme",
    })
    expect(readJson(dir, ".claude-plugin/marketplace.json").owner).toEqual({
      name: "acme",
      url: "https://github.com/acme",
    })
    expect(readJson(dir, ".claude-plugin/marketplace.json").description).toBe("Plugins by acme.")
    expect(readJson(dir, ".agents/plugins/marketplace.json").interface.displayName).toBe("acme")
  })

  test("is refused when it runs again on the result", () => {
    const dir = checkout("again")
    expect(setup(dir, ...REQUIRED, "--yes").status).toBe(0)
    cpSync(join(REPO, "scripts/setup"), join(dir, "scripts/setup"), { recursive: true })
    commitAll(dir)
    const result = setup(dir, ...REQUIRED, "--yes")
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("run already")
    expect(git(dir, "status", "--porcelain")).toBe("")
  })

  test("keeps the example, renamed to the prefix, with --keep-example", () => {
    const dir = checkout("keep")
    const result = setup(
      dir,
      ...REQUIRED,
      "--author-url",
      "https://github.com/someone",
      "--publisher",
      "Acme Inc",
      "--keep-example",
      "--yes",
    )
    expect(result.stderr).not.toContain("Error")
    expect(result.status).toBe(0)

    expectNoLeftovers(dir)
    expect(readJson(dir, "plugin.json").author).toEqual({ name: "acme", url: "https://github.com/someone" })
    expect(readJson(dir, ".claude-plugin/marketplace.json").owner).toEqual({
      name: "Acme Inc",
      url: "https://github.com/acme",
    })
    expect(readJson(dir, ".claude-plugin/marketplace.json").description).toBe("Plugins by Acme Inc.")
    expect(readJson(dir, ".agents/plugins/marketplace.json").interface.displayName).toBe("Acme Inc")
    expect(read(dir, "src/core/example/read.ts")).toContain("widget_note_read")
    expect(read(dir, "plugin.yaml")).toContain("  - widget_note_create\n  - widget_note_read\n")
    expect(read(dir, "skills/widget-notes/SKILL.md")).toContain("name: widget-notes")
    expect(existsSync(join(dir, "skills/example-notes"))).toBe(false)
    expect(existsSync(join(dir, "skills/.gitkeep"))).toBe(false)
    expect(read(dir, "src/tools.ts")).toContain("./core/example/read")
    expect(read(dir, "src/project.ts")).toContain('toolsets: ["notes"]')
    expect(read(dir, "README.md")).toContain("### Notes (`notes`)")
    expect(read(dir, "README.md")).not.toContain("<!-- example")
  })

  test("--dry-run shows the plan and writes nothing", () => {
    const dir = checkout("dry")
    const result = setup(dir, ...REQUIRED, "--dry-run")
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("@craftsamo/agent-tool-starter -> @acme/widget-tools")
    expect(result.stdout).toContain("Dry run")
    expect(git(dir, "status", "--porcelain")).toBe("")
  })

  test("asks for --yes when there is no terminal to ask on, and writes nothing", () => {
    const dir = checkout("no-tty")
    const result = setup(dir, ...REQUIRED)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("--yes")
    expect(git(dir, "status", "--porcelain")).toBe("")
  })

  test("refuses a dirty working tree and writes nothing", () => {
    const dir = checkout("dirty")
    writeFileSync(join(dir, "stray.txt"), "x\n")
    const result = setup(dir, ...REQUIRED, "--yes")
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("uncommitted")
    expect(git(dir, "status", "--porcelain")).toBe("?? stray.txt\n")
  })

  test("refuses unbalanced markers before writing anything", () => {
    const dir = checkout("unbalanced")
    writeFileSync(join(dir, "docs/conventions.md"), `${read(dir, "docs/conventions.md")}\n<!-- example -->\n`)
    commitAll(dir)
    const result = setup(dir, ...REQUIRED, "--yes")
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("docs/conventions.md")
    expect(git(dir, "status", "--porcelain")).toBe("")
  })

  test("exits 2 for a missing or unknown option", () => {
    const dir = checkout("usage")
    const missing = setup(dir, "--prefix", "widget", "--yes")
    expect(missing.status).toBe(2)
    expect(missing.stderr).toContain("--description")
    expect(setup(dir, ...REQUIRED, "--nope").status).toBe(2)
  })
})
