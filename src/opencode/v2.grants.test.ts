import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ToolError } from "../core"
import { addGrant } from "../core/grant/store"
import { readUsage } from "../core/grant/usage"
import { BOUNDED_ID, GRANT_KEY, PERSON_ONLY_ID, PROFILE, READ_ID, boundedGrant, grantSpecs, tempDir } from "./testing"
import type { PermissionEffect, V2Context, V2PermissionRequest, V2Tool } from "./types"
import { createV2Setup } from "./v2"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

type Evaluate = Parameters<NonNullable<V2Context["permission"]["hook"]>>[1]

/** The plugin's `setup` over the grant fixtures, with the grants kept in a fresh directory; `withHook: false` is a host with no `evaluate` hook. */
async function setUp(options: Record<string, unknown> = { unattended: true }, withHook = true) {
  const dir = tempDir(cleanups)
  const events: string[] = []
  const asked: V2PermissionRequest[] = []
  const tools = new Map<string, V2Tool>()
  const hooks: Evaluate[] = []
  const ctx: V2Context = {
    options: { grants_dir: dir, ...options },
    session: { get: async () => ({ location: { directory: "/work/project" } }) },
    permission: {
      async assert(request) {
        asked.push(request)
      },
      ...(withHook && { hook: (_name: "evaluate", fn: Evaluate) => void hooks.push(fn) }),
    },
    tool: { transform: async (callback) => callback({ add: (tool) => tools.set(tool.name, tool) }) },
    skill: { transform: async () => {} },
  }
  await createV2Setup(grantSpecs(events), { env: { DEMO_GRANT_KEY: GRANT_KEY }, profile: PROFILE })(ctx)
  const store = { dir, key: Buffer.from(GRANT_KEY) }
  const call = async (id: string, input: unknown = { area: "north", count: 2 }) => {
    const error = await tools
      .get(id)!
      .execute(input, { sessionID: "ses_1", signal: new AbortController().signal })
      .then(
        () => undefined,
        (failure: Error) => failure,
      )
    return { error, reason: (error?.cause as ToolError | undefined)?.details?.reason }
  }
  const evaluate = async (action: string, effect: PermissionEffect) => {
    const event = { action, effect }
    for (const hook of hooks) await hook(event)
    return event.effect
  }
  return { hooks, events, asked, store, call, evaluate }
}

describe("V2 grants while unattended", () => {
  test("refuses a write no grant covers, without asking", async () => {
    const { events, asked, call } = await setUp()
    const run = await call(BOUNDED_ID)
    expect(run.error?.message).toStartWith("forbidden: ")
    expect(run.reason).toBe("no_grant")
    expect(asked).toEqual([])
    expect(events).toEqual([])
  })

  test("asks the host about a covered write as usual, runs it and logs it", async () => {
    const { events, asked, store, call } = await setUp()
    await addGrant(store, boundedGrant())
    const run = await call(BOUNDED_ID)
    expect(run.error).toBeUndefined()
    expect(asked.map((request) => request.action)).toEqual([BOUNDED_ID])
    expect(events).toEqual([`execute:${BOUNDED_ID}`])
    const log = await readUsage(store)
    expect(log.map((entry) => entry.kind)).toEqual(["start", "end"])
    expect(log[0]).toMatchObject({ grant: "g1", tool: BOUNDED_ID, targets: ["north"], measure: { count: 2 } })
    expect(log[1]).toMatchObject({ outcome: "ok" })
  })

  test("refuses a write over its grant's bound, naming the bound", async () => {
    const { asked, store, call } = await setUp()
    await addGrant(store, boundedGrant())
    const run = await call(BOUNDED_ID, { area: "north", count: 6 })
    expect(run.reason).toBe("bound")
    expect(asked).toEqual([])
  })

  test("refuses a write outside its grant's targets, without asking", async () => {
    const { events, asked, store, call } = await setUp()
    await addGrant(store, boundedGrant())
    const run = await call(BOUNDED_ID, { area: "south", count: 2 })
    expect(run.reason).toBe("target")
    expect(asked).toEqual([])
    expect(events).toEqual([])
  })

  test("refuses a write past its grant's expiry, without asking", async () => {
    const { events, asked, store, call } = await setUp()
    await addGrant(store, { ...boundedGrant(), expires_at: new Date(Date.now() - 1000).toISOString() })
    const run = await call(BOUNDED_ID)
    expect(run.reason).toBe("expired")
    expect(asked).toEqual([])
    expect(events).toEqual([])
  })

  test("refuses a call once its grant's rate is spent", async () => {
    const { events, store, call } = await setUp()
    await addGrant(store, { ...boundedGrant(), rate: 1 })
    expect((await call(BOUNDED_ID)).error).toBeUndefined()
    expect((await call(BOUNDED_ID)).reason).toBe("rate")
    expect(events).toEqual([`execute:${BOUNDED_ID}`])
  })

  test("refuses every call when a grant was changed, without asking", async () => {
    const { events, asked, store, call } = await setUp()
    await addGrant(store, boundedGrant())
    const file = join(store.dir, "grants.json")
    writeFileSync(file, readFileSync(file, "utf8").replace('"rate": 3', '"rate": 99'))
    const run = await call(BOUNDED_ID)
    expect(run.reason).toBe("tampered")
    expect(asked).toEqual([])
    expect(events).toEqual([])
  })

  test("runs a read tool with no grant, and without asking", async () => {
    const { events, asked, call } = await setUp()
    expect((await call(READ_ID)).error).toBeUndefined()
    expect(events).toEqual([`execute:${READ_ID}`])
    expect(asked).toEqual([])
  })

  test("refuses a person-only tool as person_only, without asking", async () => {
    const { asked, call } = await setUp()
    expect((await call(PERSON_ONLY_ID)).reason).toBe("person_only")
    expect(asked).toEqual([])
  })
})

describe("V2 grants while someone can be asked", () => {
  test("changes nothing for a write: it asks, runs and logs nothing", async () => {
    const { events, asked, store, call } = await setUp({})
    expect((await call(BOUNDED_ID)).error).toBeUndefined()
    expect(asked).toHaveLength(1)
    expect(asked[0]!.save).toEqual(["north"])
    expect(events).toEqual([`execute:${BOUNDED_ID}`])
    expect(await readUsage(store)).toEqual([])
  })

  test("asks for a person-only tool with nothing to save", async () => {
    const { events, asked, call } = await setUp({})
    expect((await call(PERSON_ONLY_ID)).error).toBeUndefined()
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ action: PERSON_ONLY_ID, resources: ["north"], save: [] })
    expect(events).toEqual([`execute:${PERSON_ONLY_ID}`])
  })
})

describe("V2 evaluate hook", () => {
  test("turns an allow of a person-only tool into an ask", async () => {
    const { evaluate } = await setUp()
    expect(await evaluate(PERSON_ONLY_ID, "allow")).toBe("ask")
    expect(await evaluate(PERSON_ONLY_ID, "ask")).toBe("ask")
  })

  test("leaves a deny, and every other tool, as the rules gave it", async () => {
    const { evaluate } = await setUp()
    expect(await evaluate(PERSON_ONLY_ID, "deny")).toBe("deny")
    expect(await evaluate(BOUNDED_ID, "allow")).toBe("allow")
    expect(await evaluate("bash", "allow")).toBe("allow")
  })

  test("is not registered when no person-only tool is selected", async () => {
    const { hooks } = await setUp({ exclude_tools: [PERSON_ONLY_ID] })
    expect(hooks).toEqual([])
  })

  test("is skipped, without failing, by a host that offers no hook", async () => {
    const { hooks, call } = await setUp({}, false)
    expect(hooks).toEqual([])
    expect((await call(PERSON_ONLY_ID)).error).toBeUndefined()
  })
})
