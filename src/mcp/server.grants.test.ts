import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { defineTool, grantTools, type Grant, type GrantContext, type ToolSpec } from "../core"
import { addGrant, readGrants, type GrantStoreOptions } from "../core/grant/store"
import { readUsage } from "../core/grant/usage"
import { call, connect, runCleanups, settings, textOf, type Call, type ClientSetup } from "./testing"

const KEY = Buffer.alloc(32, 7)
const NOTE = "demo_note_create"
const READER = "demo_note_read"
const DAY_MS = 24 * 60 * 60 * 1000
const ARGS = { path: "/work/a.md", text: "hello" }
const input = z.object({ path: z.string(), text: z.string() })
const output = z.object({ ok: z.boolean() })
const form = { elicitation: { form: {} } }

let base: string
let store: GrantStoreOptions
let calls: Call[]

/** A bounded write that records its calls, and a read tool, as an unattended server would serve them. */
function noteSpecs(): ToolSpec[] {
  const write = defineTool({
    id: NOTE,
    title: "Create a note",
    description: "d",
    toolset: "alpha",
    class: "add",
    targets: (args) => [args.path],
    bounds: { text_length: { kind: "max", description: "The longest text" } },
    measure: (args) => ({ text_length: args.text.length }),
    input,
    output,
    async execute(args, ctx) {
      calls.push({ tool: NOTE, args, ctx })
      return { ok: true }
    },
  })
  const read = defineTool({
    id: READER,
    title: "Read a note",
    description: "d",
    toolset: "alpha",
    class: "read",
    input: z.object({}),
    output,
    execute: async () => ({ ok: true }),
  })
  return [write, read, ...grantTools([write], "demo")]
}

const CREATE = "demo_grant_create"
const GRANT_ARGS = {
  tool: NOTE,
  targets: ["/work/a.md"],
  bounds: { text_length: 10 },
  rate: 2,
  days: 3,
  reason: "daily notes",
}

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

const grantSettings = (overrides: Partial<GrantContext> = {}) =>
  settings({
    tools: [CREATE, "demo_grant_read", "demo_grant_revoke"],
    grants: { unattended: true, dir: store.dir, key: KEY, ...overrides },
  })

async function server(entry = grantSettings(), client: ClientSetup = {}) {
  return connect(noteSpecs(), entry, client)
}

const body = (result: Awaited<ReturnType<typeof call>>) => JSON.parse(textOf(result))

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "mcp-grants-"))
  store = { dir: join(base, "grants"), key: KEY }
  calls = []
})

afterEach(async () => {
  await runCleanups()
  await rm(base, { recursive: true, force: true })
})

describe("a server with --unattended", () => {
  test("refuses a write no grant covers, with the reason, and never runs it", async () => {
    const { client } = await server()
    const result = await call(client, NOTE, ARGS)
    expect(result.isError).toBe(true)
    expect(body(result).error).toMatchObject({ code: "forbidden", details: { reason: "no_grant", tool: NOTE } })
    expect(calls).toEqual([])
  })

  test("runs a write a grant covers, and logs its start and its ok end", async () => {
    await addGrant(store, grant())
    const { client } = await server()
    const result = await call(client, NOTE, ARGS)
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    const [start, end] = await readUsage(store)
    expect(start).toMatchObject({ kind: "start", grant: "g1", tool: NOTE, targets: ["/work/a.md"] })
    expect(end).toMatchObject({ kind: "end", start: 1, outcome: "ok" })
  })

  test("refuses a write outside its grant, and a call past its rate", async () => {
    await addGrant(store, grant({ rate: 1 }))
    const { client } = await server()
    const wrongTarget = await call(client, NOTE, { ...ARGS, path: "/work/b.md" })
    expect(body(wrongTarget).error.details.reason).toBe("target")
    expect((await call(client, NOTE, ARGS)).isError).toBeUndefined()
    expect(body(await call(client, NOTE, ARGS)).error.details.reason).toBe("rate")
    expect(calls).toHaveLength(1)
  })

  test("refuses a write past its grant's expiry, and one over its bound", async () => {
    await addGrant(store, grant({ id: "old", expires_at: new Date(Date.now() - 1000).toISOString() }))
    const { client } = await server()
    expect(body(await call(client, NOTE, ARGS)).error.details.reason).toBe("expired")
    await addGrant(store, grant({ id: "live" }))
    const over = await call(client, NOTE, { ...ARGS, text: "x".repeat(11) })
    expect(body(over).error.details).toMatchObject({ reason: "bound", bound: "text_length" })
    expect(calls).toEqual([])
  })

  test("refuses every write as tampered when a grant was edited on disk", async () => {
    await addGrant(store, grant())
    const path = join(store.dir, "grants.json")
    await writeFile(path, (await readFile(path, "utf8")).replace('"rate": 2', '"rate": 2000'))
    const { client } = await server()
    expect(body(await call(client, NOTE, ARGS)).error).toMatchObject({
      code: "forbidden",
      details: { reason: "tampered" },
    })
    expect(calls).toEqual([])
  })

  test("refuses every write without a key", async () => {
    const { client } = await server(grantSettings({ key: undefined }))
    expect(body(await call(client, NOTE, ARGS)).error.details.reason).toBe("no_key")
  })

  test("still runs a read tool, with no grant and no key", async () => {
    const { client } = await server(grantSettings({ key: undefined }))
    const result = await call(client, READER)
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({ ok: true })
  })

  test("hands the grants' context to every call", async () => {
    await addGrant(store, grant())
    const entry = grantSettings()
    const { client } = await server(entry)
    await call(client, NOTE, ARGS)
    expect(calls[0]!.ctx.grants).toBe(entry.grants)
  })

  test("refuses grant_create without asking, whatever the client offers", async () => {
    const { client, elicited } = await server(grantSettings(), {
      capabilities: form,
      answer: { action: "accept", content: { confirm: true } },
    })
    const result = await call(client, CREATE, GRANT_ARGS)
    expect(body(result).error).toMatchObject({ code: "forbidden", details: { reason: "unattended" } })
    expect(elicited).toEqual([])
    expect((await readGrants(store)).grants).toEqual([])
  })
})

describe("a server that is not unattended", () => {
  test("runs a write with no grant and reads no grant file", async () => {
    const { client } = await server(grantSettings({ unattended: false }))
    expect((await call(client, NOTE, ARGS)).isError).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(await readUsage(store)).toEqual([])
  })
})

describe("grant_create", () => {
  const attended = () => grantSettings({ unattended: false })
  const accept: ClientSetup = { capabilities: form, answer: { action: "accept", content: { confirm: true } } }

  test("asks through its own form whatever confirm says, and an accept stores the grant", async () => {
    const { client, elicited } = await server(attended(), accept)
    const result = await call(client, CREATE, GRANT_ARGS)
    expect(result.isError).toBeUndefined()
    expect(elicited).toHaveLength(1)
    expect(elicited[0]).toMatchObject({
      mode: "form",
      message: expect.stringContaining(
        `Let ${NOTE} write to /work/a.md while no one is asked, 2 calls an hour, for 3 days, text_length up to 10: daily notes`,
      ),
    })
    const [stored] = (await readGrants(store)).grants
    expect(stored).toMatchObject({ id: result.structuredContent!.id, tool: NOTE, rate: 2 })
  })

  test("a decline is declined and stores nothing", async () => {
    const { client, elicited } = await server(attended(), { capabilities: form, answer: { action: "decline" } })
    const result = await call(client, CREATE, GRANT_ARGS)
    expect(body(result).error.code).toBe("declined")
    expect(elicited).toHaveLength(1)
    expect((await readGrants(store)).grants).toEqual([])
  })

  test("leaves another tool to the harness in harness mode: no hook", async () => {
    const { client, elicited } = await server(attended(), accept)
    expect((await call(client, NOTE, ARGS)).isError).toBeUndefined()
    expect(elicited).toEqual([])
    expect(calls[0]!.ctx.confirm).toBeUndefined()
  })

  test("without form elicitation the harness's own prompt stands: no hook, no question", async () => {
    const { client, elicited } = await server(attended(), {})
    const result = await call(client, CREATE, GRANT_ARGS)
    expect(result.isError).toBeUndefined()
    expect(elicited).toEqual([])
    expect((await readGrants(store)).grants).toHaveLength(1)
  })
})
