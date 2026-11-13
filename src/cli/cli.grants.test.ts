import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { defineTool, grantTools, type Grant, type ToolSpec } from "../core"
import { addGrant, type GrantStoreOptions } from "../core/grant/store"
import { readUsage } from "../core/grant/usage"
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "./cli"
import { cli as runCli, json, READ_ID, type Run } from "./testing"

const KEY_TEXT = "k".repeat(32)
const NOTE = "demo_note_create"
const CREATE = "demo_grant_create"
const READ_GRANTS = "demo_grant_read"
const DAY_MS = 24 * 60 * 60 * 1000
const ARGS = JSON.stringify({ path: "/work/a.md", text: "hello" })
const GRANT_ARGS = JSON.stringify({
  tool: NOTE,
  targets: ["/work/a.md"],
  bounds: { text_length: 10 },
  rate: 2,
  days: 3,
  reason: "daily notes",
})
const input = z.object({ path: z.string(), text: z.string() })

const note = defineTool({
  id: NOTE,
  title: "Create a note",
  description: "d",
  toolset: "alpha",
  class: "add",
  targets: (args) => [args.path],
  bounds: { text_length: { kind: "max", description: "The longest text" } },
  measure: (args) => ({ text_length: args.text.length }),
  input,
  output: z.object({ ok: z.boolean() }),
  execute: async () => ({ ok: true }),
})
const specs: ToolSpec[] = [note, ...grantTools([note], "demo")]

let base: string
let store: GrantStoreOptions

function grant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: "g1",
    tool: NOTE,
    targets: ["/work/a.md"],
    bounds: { text_length: 10 },
    rate: 2,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + DAY_MS).toISOString(),
    reason: "daily notes",
    ...overrides,
  }
}

/** Runs the command line over the note and grant tools, with the key in its environment. */
const cli = (argv: string[], stdin = ARGS, env: Record<string, string | undefined> = { DEMO_GRANT_KEY: KEY_TEXT }) =>
  runCli(argv, stdin, { specs, env })

const unattended = () => ["--unattended", "--grants-dir", store.dir]
const run = (extra: string[] = [], tool = NOTE) => ["run", tool, "--cwd", "/x", ...extra]
const target = (extra: string[] = [], tool = NOTE) => ["target", tool, "--cwd", "/x", ...extra]
const error = (result: Run) => json(result).error

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "cli-grants-"))
  store = { dir: join(base, "grants"), key: Buffer.from(KEY_TEXT, "utf8") }
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe("run while unattended", () => {
  test("runs a write a grant covers, and logs its start and its ok end", async () => {
    await addGrant(store, grant())
    const result = await cli(run(unattended()))
    expect(result.code).toBe(EXIT_OK)
    expect(json(result)).toEqual({ result: { ok: true } })
    const [start, end] = await readUsage(store)
    expect(start).toMatchObject({ kind: "start", grant: "g1", tool: NOTE })
    expect(end).toMatchObject({ kind: "end", start: 1, outcome: "ok" })
  })

  test("refuses a write no grant covers, with the reason", async () => {
    const result = await cli(run(unattended()))
    expect(result.code).toBe(EXIT_FAILED)
    expect(error(result)).toMatchObject({ code: "forbidden", details: { reason: "no_grant", tool: NOTE } })
  })

  test("refuses a call once the grant's rate is spent", async () => {
    await addGrant(store, grant({ rate: 1 }))
    expect((await cli(run(unattended()))).code).toBe(EXIT_OK)
    const second = await cli(run(unattended()))
    expect(second.code).toBe(EXIT_FAILED)
    expect(error(second).details.reason).toBe("rate")
  })

  test("refuses a write outside its grant's targets", async () => {
    await addGrant(store, grant())
    const result = await cli(run(unattended()), JSON.stringify({ path: "/work/b.md", text: "hello" }))
    expect(result.code).toBe(EXIT_FAILED)
    expect(error(result).details.reason).toBe("target")
  })

  test("refuses a write over its grant's bound", async () => {
    await addGrant(store, grant())
    const result = await cli(run(unattended()), JSON.stringify({ path: "/work/a.md", text: "x".repeat(11) }))
    expect(result.code).toBe(EXIT_FAILED)
    expect(error(result).details).toMatchObject({ reason: "bound", bound: "text_length" })
  })

  test("refuses a write past its grant's expiry", async () => {
    await addGrant(store, grant({ expires_at: new Date(Date.now() - 1000).toISOString() }))
    const result = await cli(run(unattended()))
    expect(result.code).toBe(EXIT_FAILED)
    expect(error(result).details.reason).toBe("expired")
  })

  test("refuses every write as tampered when a grant was edited on disk", async () => {
    await addGrant(store, grant())
    const path = join(store.dir, "grants.json")
    await writeFile(path, (await readFile(path, "utf8")).replace('"rate": 2', '"rate": 2000'))
    const result = await cli(run(unattended()))
    expect(result.code).toBe(EXIT_FAILED)
    expect(error(result).details.reason).toBe("tampered")
  })

  test("reads --unattended and the directory from the environment too", async () => {
    await addGrant(store, grant())
    const env = { DEMO_GRANT_KEY: KEY_TEXT, DEMO_UNATTENDED: "true", DEMO_GRANTS_DIR: store.dir }
    expect(json(await cli(run(), ARGS, env))).toEqual({ result: { ok: true } })
    const none = await cli(run(), ARGS, { ...env, DEMO_GRANTS_DIR: join(base, "empty") })
    expect(error(none).details.reason).toBe("no_grant")
  })

  test("runs a read tool without a grant or a key", async () => {
    const result = await runCli(["run", READ_ID, "--cwd", "/x", ...unattended()], "", { env: {} })
    expect(result.code).toBe(EXIT_OK)
  })

  test("is unchanged when no one is unattended: a write runs with no grant", async () => {
    const result = await cli(run())
    expect(json(result)).toEqual({ result: { ok: true } })
    expect(await readUsage(store)).toEqual([])
  })

  test("refuses grant_create before any question", async () => {
    const result = await cli(run([...unattended(), "--tools", CREATE], CREATE), GRANT_ARGS)
    expect(error(result)).toMatchObject({ code: "forbidden", details: { reason: "unattended" } })
  })
})

describe("target while unattended", () => {
  test("prints the refusal of an uncovered write like a gate refusal, with exit 0", async () => {
    const result = await cli(target(unattended()))
    expect(result.code).toBe(EXIT_OK)
    const document = json(result)
    expect(Object.keys(document)).toEqual(["refused"])
    expect(document.refused).toMatchObject({ code: "forbidden", details: { reason: "no_grant", tool: NOTE } })
  })

  test("answers as usual for a write a grant covers, and records nothing", async () => {
    await addGrant(store, grant())
    const result = await cli(target(unattended()))
    expect(result.code).toBe(EXIT_OK)
    expect(json(result)).toMatchObject({ resources: ["/work/a.md"], title: "Create a note" })
    expect(await readUsage(store)).toEqual([])
  })

  test("answers as usual with no one unattended", async () => {
    const result = await cli(target())
    expect(json(result)).toMatchObject({ resources: ["/work/a.md"] })
    expect(json(result).refused).toBeUndefined()
  })

  test("takes the grant flags, and still refuses the other settings", async () => {
    for (const flag of ["--read-only", "--toolsets=beta", "--confirm=harness"]) {
      const result = await cli(target([...unattended(), flag]))
      expect(result.code).toBe(EXIT_USAGE)
      expect(result.stderr).toContain(flag.split("=")[0]!)
    }
  })
})

describe("target and person_only", () => {
  test("marks grant_create, and no other tool", async () => {
    const create = json(await cli(target([], CREATE), GRANT_ARGS))
    expect(create).toMatchObject({ person_only: true, title: "Delegate writes for when no one is asked" })
    expect(json(await cli(target([], NOTE))).person_only).toBeUndefined()
    expect("person_only" in json(await cli(target([], READ_GRANTS), "{}"))).toBe(false)
  })

  test("answers a refusal alone, with no mark, once the gate refuses grant_create while unattended", async () => {
    const document = json(await cli(target(unattended(), CREATE), GRANT_ARGS))
    expect(Object.keys(document)).toEqual(["refused"])
    expect(document.refused.details.reason).toBe("unattended")
  })
})

describe("the grant settings of the command line", () => {
  test.each([
    [["--grants-dir=rel"], {}, "--grants-dir"],
    [[], { DEMO_GRANTS_DIR: "rel" }, "DEMO_GRANTS_DIR"],
    [[], { DEMO_GRANT_KEY: "short" }, "DEMO_GRANT_KEY"],
  ])("a mistake in %p / %p is a usage error naming %s", async (flags, env, name) => {
    for (const command of [run, target]) {
      const result = await cli(command(flags), ARGS, env)
      expect(result.code).toBe(EXIT_USAGE)
      expect(result.stderr).toContain(name)
      expect(result.stderr).not.toContain("short")
    }
  })

  test("refuses --confirm for run and target", async () => {
    expect((await cli(run(["--unattended", "--confirm", "harness"]))).code).toBe(EXIT_USAGE)
    expect((await cli(target(["--unattended", "--confirm=harness"]))).code).toBe(EXIT_USAGE)
  })
})
