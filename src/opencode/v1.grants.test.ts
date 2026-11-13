import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ToolError } from "../core"
import { addGrant } from "../core/grant/store"
import { readUsage } from "../core/grant/usage"
import {
  ADD_ID,
  BOUNDED_ID,
  GRANT_KEY,
  PERSON_ONLY_ID,
  PROFILE,
  READ_ID,
  boundedGrant,
  grantSpecs,
  tempDir,
} from "./testing"
import type { V1AskRequest, V1Config, V1ToolContext } from "./types"
import { createV1Server } from "./v1"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/** The plugin's `server` over the grant fixtures, with the grants kept in a fresh directory. */
async function setUp(options: Record<string, unknown> = { unattended: true }) {
  const dir = tempDir(cleanups)
  const events: string[] = []
  const asked: V1AskRequest[] = []
  const context: V1ToolContext = {
    directory: "/work/project",
    worktree: "/work/project",
    abort: new AbortController().signal,
    async ask(request) {
      asked.push(request)
    },
  }
  const hooks = await createV1Server(grantSpecs(events), { env: { DEMO_GRANT_KEY: GRANT_KEY }, profile: PROFILE })(
    {},
    { grants_dir: dir, ...options },
  )
  const store = { dir, key: Buffer.from(GRANT_KEY) }
  const call = async (id: string, args: unknown = { area: "north", count: 2 }) => {
    const error = await hooks.tool[id]!.execute(args, context).then(
      () => undefined,
      (failure: Error) => failure,
    )
    return { error, reason: (error?.cause as ToolError | undefined)?.details?.reason }
  }
  return { hooks, events, asked, store, call }
}

describe("V1 grants while unattended", () => {
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
    expect(asked.map((request) => request.permission)).toEqual([BOUNDED_ID])
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

  test("refuses a write with no key, without asking", async () => {
    const dir = tempDir(cleanups)
    const events: string[] = []
    const { tool } = await createV1Server(grantSpecs(events), { env: {}, profile: PROFILE })(
      {},
      { unattended: true, grants_dir: dir },
    )
    const context = { directory: "/work", worktree: "/work", abort: new AbortController().signal, ask: async () => {} }
    const error = await tool[BOUNDED_ID]!.execute({ area: "north" }, context).catch((failure: Error) => failure)
    expect(((error as Error).cause as ToolError).details).toMatchObject({ reason: "no_key" })
    expect(events).toEqual([])
  })

  test("runs a read tool with no grant, and without asking", async () => {
    const { events, asked, call } = await setUp()
    expect((await call(READ_ID)).error).toBeUndefined()
    expect(events).toEqual([`execute:${READ_ID}`])
    expect(asked).toEqual([])
  })

  test("refuses a person-only tool as not bounded, without asking", async () => {
    const { asked, call } = await setUp()
    expect((await call(PERSON_ONLY_ID)).reason).toBe("not_bounded")
    expect(asked).toEqual([])
  })
})

describe("V1 grants while someone can be asked", () => {
  test("changes nothing for a write: it asks, runs and reads no grant", async () => {
    const { events, asked, store, call } = await setUp({})
    expect((await call(BOUNDED_ID)).error).toBeUndefined()
    expect(asked).toHaveLength(1)
    expect(asked[0]!.always).toEqual(["north"])
    expect(events).toEqual([`execute:${BOUNDED_ID}`])
    expect(existsSync(join(store.dir, "usage.jsonl"))).toBe(false)
  })

  test("asks for a person-only tool with nothing to save", async () => {
    const { events, asked, call } = await setUp({})
    expect((await call(PERSON_ONLY_ID)).error).toBeUndefined()
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ permission: PERSON_ONLY_ID, patterns: ["north"], always: [] })
    expect(events).toEqual([`execute:${PERSON_ONLY_ID}`])
  })
})

describe("V1 config hook", () => {
  const configured = async (permission: V1Config["permission"], options: Record<string, unknown> = {}) => {
    const { hooks } = await setUp(options)
    const config: V1Config = permission === undefined ? {} : { permission }
    await hooks.config?.(config)
    return config.permission
  }

  test("sets a person-only tool to ask, and creates the permission when there is none", async () => {
    expect(await configured(undefined)).toEqual({ [PERSON_ONLY_ID]: "ask" })
  })

  test("turns an allow into an ask and leaves the other tools' rules alone", async () => {
    expect(await configured({ [PERSON_ONLY_ID]: "allow", [ADD_ID]: "allow" })).toEqual({
      [PERSON_ONLY_ID]: "ask",
      [ADD_ID]: "allow",
    })
  })

  test("keeps a configured deny", async () => {
    expect(await configured({ [PERSON_ONLY_ID]: "deny" })).toEqual({ [PERSON_ONLY_ID]: "deny" })
  })

  test("asks for every resource of a pattern rule, and keeps its denies", async () => {
    const rule = { "*": "allow", north: "deny", south: "allow" }
    expect(await configured({ [PERSON_ONLY_ID]: rule })).toEqual({ [PERSON_ONLY_ID]: { "*": "ask", north: "deny" } })
  })

  test("leaves a permission given as one action for every tool as it is", async () => {
    expect(await configured("allow")).toBe("allow")
  })

  test("is not offered when no person-only tool is selected", async () => {
    const { hooks } = await setUp({ exclude_tools: [PERSON_ONLY_ID] })
    expect(hooks.config).toBeUndefined()
  })
})
