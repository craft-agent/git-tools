import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { isToolError } from "../errors"
import { askPersonOnly, exemptFromGrants } from "./guard"
import { defineTool, invoke, type ToolContext, type ToolSpec } from "../tool"
import type { Grant } from "./model"
import { addGrant, type GrantStoreOptions } from "./store"
import { readUsage } from "./usage"

const KEY = Buffer.alloc(32, 7)
const TOOL = "demo_note_delete"
const NOW = new Date("2026-06-01T12:00:00Z")

const input = z.object({ path: z.string() })
const output = z.object({ ok: z.boolean() })

let runs: number
let base: string
let store: GrantStoreOptions

function deleteTool(overrides: Partial<ToolSpec<typeof input, typeof output>> = {}) {
  return defineTool({
    id: TOOL,
    title: "Delete a note",
    description: "d",
    toolset: "notes",
    class: "overwrite",
    targets: (args) => [args.path],
    input,
    output,
    execute: async () => {
      runs += 1
      return { ok: true }
    },
    ...overrides,
  })
}

function grant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: "g1",
    tool: TOOL,
    targets: ["/work/a.md"],
    bounds: {},
    rate: 2,
    created_at: "2026-05-31T12:00:00Z",
    expires_at: "2026-06-30T12:00:00Z",
    reason: "cleanup",
    ...overrides,
  }
}

function context(now: Date = NOW): ToolContext {
  return { cwd: base, grants: { unattended: true, dir: store.dir, key: KEY, now: () => now } }
}

const ARGS = { path: "/work/a.md" }

async function reasonOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => isToolError(error) && error.details?.reason,
  )
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "guard-unbounded-"))
  store = { dir: join(base, "grants"), key: KEY }
  runs = 0
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe("a write tool that declares no bounds, unattended", () => {
  test("runs under a grant naming it, and the log holds its start and end", async () => {
    await addGrant(store, grant())
    expect(await invoke(deleteTool(), ARGS, context())).toEqual({ ok: true })
    expect(runs).toBe(1)
    const [start, end] = await readUsage(store)
    expect(start).toMatchObject({ kind: "start", grant: "g1", tool: TOOL, targets: ["/work/a.md"], measure: {} })
    expect(end).toMatchObject({ kind: "end", start: 1, outcome: "ok" })
  })

  test("is refused as no_grant while no grant names it", async () => {
    expect(await reasonOf(invoke(deleteTool(), ARGS, context()))).toBe("no_grant")
    expect(runs).toBe(0)
  })

  test("is refused outside the grant's targets, past its expiry and over its rate", async () => {
    await addGrant(store, grant())
    expect(await reasonOf(invoke(deleteTool(), { path: "/work/b.md" }, context()))).toBe("target")
    expect(await reasonOf(invoke(deleteTool(), ARGS, context(new Date("2026-07-01T00:00:00Z"))))).toBe("expired")
    await invoke(deleteTool(), ARGS, context())
    await invoke(deleteTool(), ARGS, context())
    expect(await reasonOf(invoke(deleteTool(), ARGS, context()))).toBe("rate")
    expect(runs).toBe(2)
  })

  test("a measure that throws refuses only under a grant that sets a bound", async () => {
    const tool = deleteTool({
      bounds: { size: { kind: "max", description: "The size" } },
      measure: () => {
        throw new Error("cannot tell")
      },
    })
    await addGrant(store, grant({ bounds: { size: 5 } }))
    expect(await reasonOf(invoke(tool, ARGS, context()))).toBe("bound")
    expect(runs).toBe(0)
    await addGrant(store, grant({ id: "g2", bounds: {} }))
    expect(await invoke(tool, ARGS, context())).toEqual({ ok: true })
    expect((await readUsage(store))[0]).toMatchObject({ grant: "g2", measure: {} })
  })

  test("a grant that leaves a bound out lets any value through", async () => {
    const tool = deleteTool({
      bounds: { size: { kind: "max", description: "The size" }, force: { kind: "allow", description: "Forced" } },
      measure: () => ({ size: 9999, force: true }),
    })
    await addGrant(store, grant({ bounds: {} }))
    expect(await invoke(tool, ARGS, context())).toEqual({ ok: true })
    expect((await readUsage(store))[0]).toMatchObject({ measure: { size: 9999, force: true } })
  })
})

describe("a person-only tool", () => {
  test("is never covered, whatever grant names it", async () => {
    await addGrant(store, grant({ targets: ["*"], rate: null }))
    expect(await reasonOf(invoke(askPersonOnly(deleteTool()), ARGS, context()))).toBe("person_only")
    expect(runs).toBe(0)
    expect(await readUsage(store)).toEqual([])
  })

  test("is refused even when also marked exempt", async () => {
    const both = askPersonOnly(exemptFromGrants(deleteTool()))
    expect(await reasonOf(invoke(both, ARGS, context()))).toBe("person_only")
    expect(runs).toBe(0)
  })
})

describe("a grant for any target", () => {
  test("covers a call with any target, with a *, and with no targets function", async () => {
    await addGrant(store, grant({ targets: ["*"], rate: null }))
    await invoke(deleteTool(), { path: "/anywhere/else.md" }, context())
    await invoke(deleteTool(), { path: "*" }, context())
    await invoke(deleteTool({ targets: undefined }), ARGS, context())
    await invoke(deleteTool({ targets: () => [] }), ARGS, context())
    expect(runs).toBe(4)
    const starts = (await readUsage(store)).filter((entry) => entry.kind === "start")
    expect(starts.map((entry) => entry.targets)).toEqual([["/anywhere/else.md"], ["*"], ["*"], ["*"]])
  })
})

describe("a grant with no rate", () => {
  test("is never refused for it, and every call is logged", async () => {
    await addGrant(store, grant({ rate: null }))
    for (let index = 0; index < 5; index += 1) await invoke(deleteTool(), ARGS, context())
    expect(runs).toBe(5)
    const entries = await readUsage(store)
    expect(entries.filter((entry) => entry.kind === "start")).toHaveLength(5)
    expect(entries.filter((entry) => entry.kind === "end")).toHaveLength(5)
  })
})
