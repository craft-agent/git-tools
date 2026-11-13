import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { ToolError, isToolError } from "../errors"
import { defineTool, invoke, type ToolContext, type ToolSpec } from "../tool"
import { askPersonOnly, exemptFromGrants, grantCheck, isExemptFromGrants, type GrantContext } from "./guard"
import type { Grant } from "./model"
import { addGrant, type GrantStoreOptions } from "./store"
import { readUsage } from "./usage"

const KEY = Buffer.alloc(32, 7)
const TOOL = "demo_note_create"
const NOW = new Date("2026-06-01T12:00:00Z")

const input = z.object({ path: z.string(), text: z.string() })
const output = z.object({ ok: z.boolean() })

let runs: number
let behavior: () => Promise<{ ok: boolean }>

function noteTool(overrides: Partial<ToolSpec<typeof input, typeof output>> = {}) {
  return defineTool({
    id: TOOL,
    title: "Create a note",
    description: "d",
    toolset: "notes",
    class: "add",
    targets: (args) => [args.path],
    bounds: { text_length: { kind: "max", description: "The longest text" } },
    measure: (args) => ({ text_length: args.text.length }),
    input,
    output,
    execute: async () => {
      runs += 1
      return behavior()
    },
    ...overrides,
  })
}

function grant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: "g1",
    tool: TOOL,
    targets: ["/work/a.md"],
    bounds: { text_length: 10 },
    rate: 2,
    created_at: "2026-05-31T12:00:00Z",
    expires_at: "2026-06-30T12:00:00Z",
    reason: "daily notes",
    ...overrides,
  }
}

let base: string
let store: GrantStoreOptions

function context(overrides: Partial<GrantContext> = {}): ToolContext {
  return { cwd: base, grants: { unattended: true, dir: store.dir, key: KEY, now: () => NOW, ...overrides } }
}

const ARGS = { path: "/work/a.md", text: "hello" }

async function thrown(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  )
}

function refusal(error: unknown): unknown {
  return isToolError(error) && [error.code, error.details?.reason]
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "guard-"))
  store = { dir: join(base, "grants"), key: KEY }
  runs = 0
  behavior = async () => ({ ok: true })
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

const exists = async (path: string) => (await stat(path).catch(() => undefined)) !== undefined

describe("invoke with grants off", () => {
  test("without ctx.grants or with unattended off, a write runs and no file is touched", async () => {
    expect(await invoke(noteTool(), ARGS, { cwd: base })).toEqual({ ok: true })
    expect(await invoke(noteTool(), ARGS, context({ unattended: false }))).toEqual({ ok: true })
    expect(runs).toBe(2)
    expect(await exists(store.dir)).toBe(false)
  })

  test("a tool that declares no bounds runs as before", async () => {
    const tool = noteTool({ bounds: undefined, measure: undefined })
    expect(await invoke(tool, ARGS, context({ unattended: false }))).toEqual({ ok: true })
  })
})

describe("invoke while unattended", () => {
  test("a read tool runs without a grant, a key or a file", async () => {
    const tool = defineTool({
      id: "demo_note_read",
      title: "Read",
      description: "d",
      toolset: "notes",
      class: "read",
      input,
      output,
      execute: async () => ({ ok: true }),
    })
    expect(await invoke(tool, ARGS, context({ key: undefined }))).toEqual({ ok: true })
    expect(await exists(store.dir)).toBe(false)
  })

  test("a write with no grant is forbidden as no_grant, and execute never runs", async () => {
    const error = await thrown(invoke(noteTool(), ARGS, context()))
    expect(refusal(error)).toEqual(["forbidden", "no_grant"])
    expect(runs).toBe(0)
  })

  test("a write with no key is forbidden as no_key", async () => {
    const error = await thrown(invoke(noteTool(), ARGS, context({ key: undefined })))
    expect(isToolError(error) && error.details).toEqual({ reason: "no_key", tool: TOOL })
    expect(runs).toBe(0)
  })

  test("a person-only spec is forbidden as person_only before any file is touched, even without a key", async () => {
    const tool = askPersonOnly(noteTool())
    for (const key of [KEY, undefined]) {
      const error = await thrown(invoke(tool, ARGS, context({ key })))
      expect(isToolError(error) && error.details).toEqual({ reason: "person_only", tool: TOOL })
    }
    expect(refusal(await thrown(grantCheck(tool, ARGS, context(), "check")))).toEqual(["forbidden", "person_only"])
    expect(runs).toBe(0)
    expect(await exists(store.dir)).toBe(false)
  })

  test("a covered write runs, and the log holds its start and an ok end", async () => {
    await addGrant(store, grant())
    expect(await invoke(noteTool(), ARGS, context())).toEqual({ ok: true })
    expect(runs).toBe(1)
    const [start, end] = await readUsage(store)
    expect(start).toMatchObject({
      kind: "start",
      grant: "g1",
      tool: TOOL,
      targets: ["/work/a.md"],
      measure: { text_length: 5 },
    })
    expect(end).toMatchObject({ kind: "end", start: 1, outcome: "ok" })
  })

  test("a write outside the grant is refused with the reason, and execute never runs", async () => {
    await addGrant(store, grant())
    const wrongTarget = await thrown(invoke(noteTool(), { ...ARGS, path: "/work/b.md" }, context()))
    const tooLong = await thrown(invoke(noteTool(), { ...ARGS, text: "x".repeat(11) }, context()))
    expect(refusal(wrongTarget)).toEqual(["forbidden", "target"])
    expect(isToolError(tooLong) && tooLong.details).toEqual({
      reason: "bound",
      tool: TOOL,
      grant: "g1",
      bound: "text_length",
    })
    expect(runs).toBe(0)
    expect(await readUsage(store)).toEqual([])
  })

  test("a failing execute logs its code and the original error is rethrown", async () => {
    await addGrant(store, grant())
    const original = new ToolError("not_found", "no such note")
    behavior = async () => {
      throw original
    }
    expect(await thrown(invoke(noteTool(), ARGS, context()))).toBe(original)
    const plain = new Error("boom")
    behavior = async () => {
      throw plain
    }
    expect(await thrown(invoke(noteTool(), ARGS, context({ now: () => new Date(NOW.getTime() + 1) })))).toBe(plain)
    const ends = (await readUsage(store)).filter((entry) => entry.kind === "end")
    expect(ends.map((entry) => entry.kind === "end" && entry.outcome)).toEqual(["not_found", "internal_error"])
  })

  test("a result that fails the output schema logs internal_error", async () => {
    await addGrant(store, grant())
    behavior = async () => ({ ok: "yes" }) as never
    const error = await thrown(invoke(noteTool(), ARGS, context()))
    expect(isToolError(error) && error.code).toBe("internal_error")
    expect((await readUsage(store)).at(-1)).toMatchObject({ kind: "end", outcome: "internal_error" })
  })

  test("failed calls count against the rate", async () => {
    await addGrant(store, grant({ rate: 2 }))
    behavior = async () => {
      throw new ToolError("upstream_error", "down")
    }
    for (let index = 0; index < 2; index += 1) await thrown(invoke(noteTool(), ARGS, context()))
    expect(refusal(await thrown(invoke(noteTool(), ARGS, context())))).toEqual(["forbidden", "rate"])
    expect(runs).toBe(2)
  })

  test("a failure to log the end does not hide the call's result", async () => {
    await addGrant(store, grant())
    behavior = async () => {
      await writeFile(join(store.dir, "usage.jsonl"), "{}\n")
      return { ok: true }
    }
    expect(await invoke(noteTool(), ARGS, context())).toEqual({ ok: true })
    expect(await readFile(join(store.dir, "usage.jsonl"), "utf8")).toBe("{}\n")
  })

  test("a tampered grant refuses every call", async () => {
    await addGrant(store, grant())
    const path = join(store.dir, "grants.json")
    await writeFile(path, (await readFile(path, "utf8")).replace('"rate": 2', '"rate": 2000'))
    const error = await thrown(invoke(noteTool(), ARGS, context()))
    expect(isToolError(error) && error.details).toEqual({ reason: "tampered", tool: TOOL })
    expect(runs).toBe(0)
  })

  test("a spec exempt from grants runs without one", async () => {
    const tool = exemptFromGrants(noteTool({ bounds: undefined, measure: undefined }))
    expect(isExemptFromGrants(tool)).toBe(true)
    expect(isExemptFromGrants(noteTool())).toBe(false)
    expect(await invoke(tool, ARGS, context({ key: undefined }))).toEqual({ ok: true })
    expect(await exists(store.dir)).toBe(false)
  })
})

describe("measure", () => {
  test("a measure that throws refuses the call as a bound", async () => {
    await addGrant(store, grant())
    const tool = noteTool({
      measure: () => {
        throw new Error("cannot tell")
      },
    })
    const error = await thrown(invoke(tool, ARGS, context()))
    expect(isToolError(error) && error.details).toEqual({ reason: "bound", tool: TOOL, grant: "g1" })
    expect(runs).toBe(0)
  })

  test("a measure of another shape refuses the call as a bound", async () => {
    await addGrant(store, grant())
    const tool = noteTool({ measure: () => ({ text_length: -1 }) })
    expect(refusal(await thrown(invoke(tool, ARGS, context())))).toEqual(["forbidden", "bound"])
  })

  test("a cancellation while measuring is rethrown, not turned into a refusal", async () => {
    await addGrant(store, grant())
    const abort = new Error("stop")
    abort.name = "AbortError"
    const tool = noteTool({
      measure: () => {
        throw abort
      },
    })
    expect(await thrown(invoke(tool, ARGS, context()))).toBe(abort)
  })
})

describe("grantCheck", () => {
  test("check mode decides and records nothing, with seq 0", async () => {
    await addGrant(store, grant())
    const use = await grantCheck(noteTool(), ARGS, context(), "check")
    expect(use).toMatchObject({ grant: { id: "g1" }, seq: 0 })
    expect(await exists(join(store.dir, "usage.jsonl"))).toBe(false)
    expect(await exists(join(store.dir, "lock"))).toBe(false)
  })

  test("check mode refuses what record mode refuses", async () => {
    await addGrant(store, grant())
    const error = await thrown(grantCheck(noteTool(), { ...ARGS, path: "/x" }, context(), "check"))
    expect(refusal(error)).toEqual(["forbidden", "target"])
  })

  test("record mode returns the grant and the line of the start", async () => {
    await addGrant(store, grant())
    expect(await grantCheck(noteTool(), ARGS, context(), "record")).toMatchObject({ grant: { id: "g1" }, seq: 1 })
  })

  test("it has nothing to decide for a read, an exempt spec or grants that are off", async () => {
    const reader = { ...noteTool(), class: "read" as const }
    expect(await grantCheck(reader, ARGS, context(), "record")).toBeUndefined()
    expect(await grantCheck(exemptFromGrants(noteTool()), ARGS, context(), "record")).toBeUndefined()
    expect(await grantCheck(noteTool(), ARGS, context({ unattended: false }), "record")).toBeUndefined()
    expect(await grantCheck(noteTool(), ARGS, { cwd: base }, "record")).toBeUndefined()
  })
})
