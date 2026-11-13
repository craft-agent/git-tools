import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { defineTool, invoke, type CallDescription, type ToolContext } from "../tool"
import { MAX_GRANT_DAYS, MAX_GRANT_RATE } from "./model"
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
const reader = defineTool({ ...unbounded, id: "demo_note_read", class: "read" })
const [create] = grantTools([bounded, unbounded, reader], "demo")
const ARGS = {
  tool: bounded.id,
  targets: ["/work/b", "/work/a", "/work/a"],
  bounds: { size: 20, attach: false, types: ["weekly", "daily"] },
  rate: 2,
  days: 3,
  reason: "daily notes",
}
let dir: string
let ctx: ToolContext

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grant-tools-create-"))
  ctx = { cwd: dir, grants: { unattended: false, dir, key: KEY, now: () => NOW } }
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test("only non-read tools with bounds are grantable, with declarations in the description", () => {
  expect(create!.input.shape.tool.options).toEqual([bounded.id])
  expect(create!.description).toContain("size (max): The longest text")
  expect(create!.description).toContain("attach (allow): Whether files may be attached")
  expect(create!.description).toContain("types (oneOf): The kinds of note; values: daily, weekly")
  expect(create!.bounds).toBeUndefined()
})

test("unattended creation is refused before confirmation", async () => {
  let asked = false
  ctx.confirm = async () => {
    asked = true
    return true
  }
  ctx.grants!.unattended = true
  await expect(invoke(create!, ARGS, ctx)).rejects.toMatchObject({
    code: "forbidden",
    details: { reason: "unattended" },
  })
  expect(asked).toBe(false)
})

test("the gate refuses ungrantable tools, even without schema validation", async () => {
  for (const tool of [unbounded.id, reader.id, "demo_unknown_create"]) {
    await expect(Promise.resolve().then(() => create!.gate!({ ...ARGS, tool }, ctx))).rejects.toMatchObject({
      code: "invalid_argument",
      message: expect.stringContaining(bounded.id),
    })
  }
  const [empty] = grantTools([], "demo")
  await expect(invoke(empty!, ARGS, ctx)).rejects.toMatchObject({
    code: "invalid_argument",
    message: "No tool can be granted.",
  })
})

test("invalid targets and bounds are refused", async () => {
  for (const targets of [[], ["*"], ["a?"], [" "]]) {
    await expect(invoke(create!, { ...ARGS, targets }, ctx)).rejects.toMatchObject({ code: "invalid_argument" })
  }
  for (const bounds of [
    {},
    { ...ARGS.bounds, extra: 1 },
    { ...ARGS.bounds, size: 1.5 },
    { ...ARGS.bounds, attach: 1 },
    { ...ARGS.bounds, types: ["unknown"] },
  ]) {
    await expect(invoke(create!, { ...ARGS, bounds }, ctx)).rejects.toMatchObject({ code: "invalid_argument" })
  }
})

test("strict input enforces rate, duration and reason limits", async () => {
  for (const change of [
    { rate: 0 },
    { rate: MAX_GRANT_RATE + 1 },
    { days: 0 },
    { days: MAX_GRANT_DAYS + 1 },
    { days: 1.5 },
    { reason: " " },
    { reason: "x".repeat(501) },
    { extra: true },
  ]) {
    await expect(invoke(create!, { ...ARGS, ...change }, ctx)).rejects.toMatchObject({ code: "invalid_argument" })
  }
})

test("the description is deterministic, sorted and made of value templates", async () => {
  const expected: CallDescription = {
    headline: { text: "About to let {tool} write while no one is asked", values: { tool: bounded.id } },
    facts: [
      { label: "Rate", value: { text: "{rate} calls an hour", values: { rate: 2 } } },
      { label: "Lasts", value: { text: "{days} days", values: { days: 3 } } },
      { label: "Bound", value: { text: "{name} not allowed", values: { name: "attach" } } },
      { label: "Bound", value: { text: "{name} up to {limit}", values: { name: "size", limit: 20 } } },
      { label: "Bound", value: { text: "{name} one of {values}", values: { name: "types", values: "daily, weekly" } } },
    ],
    text: { label: "Reason", body: ARGS.reason },
  }
  expect(await create!.describe!(ARGS, ctx)).toEqual(expected)
  expect(await create!.describe!(ARGS, { ...ctx, grants: { ...ctx.grants!, now: () => new Date(0) } })).toEqual(
    expected,
  )
  expect(await create!.targets!(ARGS, ctx)).toEqual(["/work/a", "/work/b"])
  const singular = await create!.describe!({ ...ARGS, rate: 1, days: 1, bounds: { ...ARGS.bounds, attach: true } }, ctx)
  expect(singular.facts.slice(0, 3)).toEqual([
    { label: "Rate", value: { text: "{rate} call an hour", values: { rate: 1 } } },
    { label: "Lasts", value: { text: "{days} day", values: { days: 1 } } },
    { label: "Bound", value: { text: "{name} allowed", values: { name: "attach" } } },
  ])
})

test("execute confirms and stores a normalized signed grant with the supplied clock", async () => {
  const requests: unknown[] = []
  ctx.confirm = async (request) => {
    requests.push(request)
    return true
  }
  const result = await invoke(create!, { ...ARGS, reason: " daily notes " }, ctx)
  expect(result.id).toMatch(/^grant_[0-9a-f]{12}$/)
  const expected = {
    id: String(result.id),
    tool: bounded.id,
    targets: ["/work/a", "/work/b"],
    bounds: { attach: false, size: 20, types: ["daily", "weekly"] },
    rate: 2,
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
      message: `Let ${bounded.id} write to /work/a, /work/b while no one is asked, 2 calls an hour, for 3 days, attach not allowed; size up to 20; types one of daily, weekly: daily notes`,
    },
  ])
})

test("a grant whose filled bound value is over 200 characters is refused", async () => {
  const values = Array.from({ length: 30 }, (_, index) => `value${String(index).padStart(2, "0")}`)
  const tool = defineTool({
    ...bounded,
    bounds: { kinds: { kind: "oneOf", description: "The kinds", values } },
    measure: () => ({ kinds: "value00" }),
  })
  const [many] = grantTools([tool], "demo")
  const args = { ...ARGS, bounds: { kinds: values } }
  await expect(invoke(many!, args, ctx)).rejects.toMatchObject({
    code: "invalid_argument",
    message: expect.stringContaining("grant fewer values"),
  })
  expect(await readGrants(ctx.grants!)).toEqual({ grants: [], failed: [] })
  ctx.confirm = async () => true
  expect((await invoke(many!, { ...args, bounds: { kinds: values.slice(0, 10) } }, ctx)).bounds).toEqual({
    kinds: values.slice(0, 10),
  })
})

test("a declined confirmation creates nothing", async () => {
  ctx.confirm = async () => false
  await expect(invoke(create!, ARGS, ctx)).rejects.toMatchObject({ code: "declined" })
  expect(await readGrants(ctx.grants!)).toEqual({ grants: [], failed: [] })
})

test("creation needs a key and a grant context", async () => {
  await expect(invoke(create!, ARGS, { ...ctx, grants: { ...ctx.grants!, key: undefined } })).rejects.toMatchObject({
    code: "forbidden",
    details: { reason: "no_key" },
  })
  await expect(invoke(create!, ARGS, { cwd: dir })).rejects.toMatchObject({
    code: "forbidden",
    message: "Grants are not set up where this tool runs.",
    details: { reason: "not_set_up" },
  })
})

test("a tool with empty bounds can be granted with the default bounds", async () => {
  const tool = defineTool({ ...bounded, bounds: {}, measure: undefined })
  const [empty] = grantTools([tool], "demo")
  const { bounds: _bounds, ...args } = ARGS
  expect((await invoke(empty!, args, ctx)).bounds).toEqual({})
})
