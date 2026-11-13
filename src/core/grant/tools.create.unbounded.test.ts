import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { defineTool, invoke, type CallDescription, type ToolContext } from "../tool"
import { askPersonOnly, exemptFromGrants } from "./guard"
import { readGrants } from "./store"
import { grantTools } from "./tools"

const KEY = Buffer.alloc(32, 7)
const NOW = new Date("2026-06-01T12:00:00Z")
const bounded = defineTool({
  id: "demo_note_create",
  title: "Create",
  description: "d",
  toolset: "notes",
  class: "add",
  bounds: {
    size: { kind: "max", description: "The longest text" },
    attach: { kind: "allow", description: "Whether files may be attached" },
    types: { kind: "oneOf", description: "The kinds of note", values: ["daily", "weekly"] },
  },
  measure: () => ({ size: 0, attach: false, types: "daily" }),
  input: z.object({}),
  output: z.object({}),
  execute: async () => ({}),
})
const unbounded = defineTool({ ...bounded, id: "demo_note_delete", bounds: undefined, measure: undefined })
const personOnly = askPersonOnly(defineTool({ ...unbounded, id: "demo_note_approve" }))
const exempt = exemptFromGrants(defineTool({ ...unbounded, id: "demo_note_revoke" }))
const reader = defineTool({ ...unbounded, id: "demo_note_read", class: "read" })
const [create, read] = grantTools([bounded, unbounded, personOnly, exempt, reader], "demo")
const ARGS = { tool: bounded.id, targets: ["*"], bounds: { size: 20 }, days: 3, reason: "daily notes" }
let dir: string
let ctx: ToolContext

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grant-tools-unbounded-"))
  ctx = { cwd: dir, grants: { unattended: false, dir, key: KEY, now: () => NOW } }
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test("a tool without bounds is grantable and listed; a person-only or exempt one is neither", async () => {
  expect(create!.input.shape.tool.options).toEqual([bounded.id, unbounded.id])
  expect(create!.description).toContain(`${unbounded.id}: no bounds: a grant limits its targets, rate and expiry.`)
  expect(create!.description).not.toContain(personOnly.id)
  expect(create!.description).not.toContain(exempt.id)
  for (const tool of [personOnly.id, exempt.id, reader.id]) {
    await expect(Promise.resolve().then(() => create!.gate!({ ...ARGS, tool }, ctx))).rejects.toMatchObject({
      code: "invalid_argument",
      message: `Only these tools can be granted: ${bounded.id}, ${unbounded.id}.`,
    })
  }
  const [empty] = grantTools([personOnly, exempt, reader], "demo")
  expect(empty!.description).toContain("No tool can be granted.")
})

test("the description says what the person chooses", () => {
  expect(create!.description).toContain('with targets ["*"] to any target')
  expect(create!.description).toContain("a bound left out is no limit")
  expect(create!.description).toContain("or any number when rate is left out")
  expect(create!.description).toContain("(at most 90)")
  expect(create!.input.shape.rate.isOptional()).toBe(true)
})

test("the description for any target, no rate and unset bounds is exact and deterministic", async () => {
  const expected: CallDescription = {
    headline: { text: "About to let {tool} write anywhere while no one is asked", values: { tool: bounded.id } },
    facts: [
      { label: "Rate", value: { text: "No limit" } },
      { label: "Lasts", value: { text: "{days} days", values: { days: 3 } } },
      { label: "Bound", value: { text: "{name} no limit", values: { name: "attach" } } },
      { label: "Bound", value: { text: "{name} up to {limit}", values: { name: "size", limit: 20 } } },
      { label: "Bound", value: { text: "{name} no limit", values: { name: "types" } } },
    ],
    text: { label: "Reason", body: ARGS.reason },
  }
  expect(await create!.describe!(ARGS, ctx)).toEqual(expected)
  expect(await create!.describe!(ARGS, { ...ctx, grants: { ...ctx.grants!, now: () => new Date(0) } })).toEqual(
    expected,
  )
  expect(await create!.targets!(ARGS, ctx)).toEqual(["*"])
})

test("named targets keep the plain headline, and a tool without bounds shows no bound fact", async () => {
  const named = await create!.describe!({ ...ARGS, targets: ["/work/a"], rate: 1 }, ctx)
  expect(named.headline).toEqual({
    text: "About to let {tool} write while no one is asked",
    values: { tool: bounded.id },
  })
  expect(named.facts[0]).toEqual({ label: "Rate", value: { text: "{rate} call an hour", values: { rate: 1 } } })
  const none = await create!.describe!({ ...ARGS, tool: unbounded.id, bounds: {} }, ctx)
  expect(none.facts.map((fact) => fact.label)).toEqual(["Rate", "Lasts"])
})

test("execute confirms with every declared bound, and stores rate null and ['*'] as given", async () => {
  const requests: unknown[] = []
  ctx.confirm = async (request) => {
    requests.push(request)
    return true
  }
  const result = await invoke(create!, ARGS, ctx)
  const expected = {
    id: String(result.id),
    tool: bounded.id,
    targets: ["*"],
    bounds: { size: 20 },
    rate: null,
    expires_at: "2026-06-04T12:00:00.000Z",
  }
  expect(result).toEqual(expected)
  expect(await readGrants(ctx.grants!)).toEqual({
    grants: [{ ...expected, created_at: NOW.toISOString(), reason: ARGS.reason }],
    failed: [],
  })
  expect(requests).toEqual([
    {
      tool: create!.id,
      message: `Let ${bounded.id} write to any target while no one is asked, any number of calls, for 3 days, attach no limit; size up to 20; types no limit: daily notes`,
    },
  ])
})

test("a grant of a tool without bounds is confirmed and stored with no bound text", async () => {
  const requests: { message: string }[] = []
  ctx.confirm = async (request) => {
    requests.push(request)
    return true
  }
  const args = { tool: unbounded.id, targets: ["/b", "/a"], rate: 4, days: 1, reason: "tidy" }
  const result = await invoke(create!, args, ctx)
  expect(result).toMatchObject({ targets: ["/a", "/b"], bounds: {}, rate: 4 })
  expect(requests.map((request) => request.message)).toEqual([
    `Let ${unbounded.id} write to /a, /b while no one is asked, 4 calls an hour, for 1 days: tidy`,
  ])
})

test("grant_read lists a grant with no rate as null", async () => {
  ctx.confirm = async () => true
  await invoke(create!, ARGS, ctx)
  const listed = await invoke(read!, { method: "list" }, ctx)
  expect(listed.grants).toMatchObject([{ tool: bounded.id, targets: ["*"], rate: null, used_last_hour: 0 }])
})
