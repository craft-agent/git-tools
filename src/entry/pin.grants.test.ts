import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import {
  PIN_PATTERN,
  ToolError,
  abortError,
  defineTool,
  type Grant,
  type GrantContext,
  type ToolContext,
  type ToolSpec,
} from "../core"
import { exemptFromGrants } from "../core/grant/guard"
import { addGrant } from "../core/grant/store"
import { approvalOf } from "./pin"

const KEY = Buffer.alloc(32, 7)
const NOW = new Date("2026-06-01T12:00:00Z")
const TOOL = "demo_note_create"
const ARGS = { path: "/work/a.md", text: "hello" }
const input = z.object({ path: z.string(), text: z.string() })

type Calls = { gate: number; targets: number; describe: number }

/** A bounded write that counts how often its gate, targets and describer run. */
function fixture(overrides: Partial<ToolSpec<typeof input>> = {}) {
  const calls: Calls = { gate: 0, targets: 0, describe: 0 }
  const spec = defineTool({
    id: TOOL,
    title: "Create a note",
    description: "d",
    toolset: "notes",
    class: "add",
    bounds: { text_length: { kind: "max", description: "The longest text" } },
    measure: (args) => ({ text_length: args.text.length }),
    gate() {
      calls.gate++
    },
    targets(args) {
      calls.targets++
      return [args.path]
    },
    describe() {
      calls.describe++
      return { facts: [{ label: "Size", value: "5" }] }
    },
    input,
    output: z.object({}),
    execute: async () => ({}),
    ...overrides,
  })
  return { spec, calls }
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
let grants: GrantContext

const context = (overrides: Partial<GrantContext> = {}): ToolContext => ({
  cwd: base,
  grants: { ...grants, ...overrides },
})

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "pin-grants-"))
  grants = { unattended: true, dir: join(base, "grants"), key: KEY, now: () => NOW }
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

const exists = async (path: string) => (await stat(path).catch(() => undefined)) !== undefined

describe("approvalOf while no one can be asked", () => {
  test("refuses a write no grant covers, and never describes it", async () => {
    const { spec, calls } = fixture()
    const approval = await approvalOf(spec, ARGS, context())
    expect(approval.refused).toMatchObject({ code: "forbidden", details: { reason: "no_grant", tool: TOOL } })
    expect(approval.resources).toBeUndefined()
    expect(approval.description).toBeUndefined()
    expect(approval.pin).toBeUndefined()
    expect(calls).toEqual({ gate: 1, targets: 1, describe: 0 })
  })

  test("refuses a write outside its grant with the reason", async () => {
    await addGrant(grants, grant())
    const { spec } = fixture()
    const wrongTarget = await approvalOf(spec, { ...ARGS, path: "/work/b.md" }, context())
    const tooLong = await approvalOf(spec, { ...ARGS, text: "x".repeat(11) }, context())
    expect(wrongTarget.refused?.details).toMatchObject({ reason: "target" })
    expect(tooLong.refused?.details).toMatchObject({ reason: "bound", bound: "text_length" })
  })

  test("refuses with no_key when there is no key", async () => {
    const { spec } = fixture()
    const approval = await approvalOf(spec, ARGS, context({ key: undefined }))
    expect(approval.refused?.details).toMatchObject({ reason: "no_key" })
  })

  test("gives the normal approval to a covered write, and records nothing", async () => {
    await addGrant(grants, grant())
    const { spec, calls } = fixture()
    const approval = await approvalOf(spec, ARGS, context())
    expect(approval.refused).toBeUndefined()
    expect(approval.resources).toEqual(["/work/a.md"])
    expect(approval.description).toEqual({ facts: [{ label: "Size", value: "5" }] })
    expect(approval.pin).toMatch(PIN_PATTERN)
    expect(calls).toEqual({ gate: 1, targets: 2, describe: 1 })
    expect(await exists(join(grants.dir, "usage.jsonl"))).toBe(false)
  })

  test("lets the gate refuse first", async () => {
    const failure = new ToolError("not_found", "No such note.")
    const { spec, calls } = fixture({
      gate() {
        throw failure
      },
    })
    const approval = await approvalOf(spec, ARGS, context())
    expect(approval.refused).toBe(failure)
    expect(calls.targets).toBe(0)
  })

  test("leaves a read tool, an exempt tool and a call with invalid arguments to go on", async () => {
    const read = {
      ...fixture().spec,
      id: "demo_note_read",
      class: "read" as const,
      bounds: undefined,
      measure: undefined,
    }
    expect((await approvalOf(read, ARGS, context())).refused).toBeUndefined()
    const exempt = exemptFromGrants(fixture({ bounds: undefined, measure: undefined }).spec)
    expect((await approvalOf(exempt, ARGS, context())).refused).toBeUndefined()
    const { spec, calls } = fixture()
    expect(await approvalOf(spec, { path: 1 }, context())).toEqual({ resources: ["*"] })
    expect(calls).toEqual({ gate: 0, targets: 0, describe: 0 })
    expect(await exists(grants.dir)).toBe(false)
  })

  test("refuses a tool that declares no bounds as not_bounded", async () => {
    const { spec } = fixture({ bounds: undefined, measure: undefined })
    expect((await approvalOf(spec, ARGS, context())).refused?.details).toMatchObject({ reason: "not_bounded" })
  })

  test("turns a failure it cannot explain into an internal_error refusal, keeping the cause", async () => {
    const cause = new Error("clock broke")
    const { spec } = fixture()
    const approval = await approvalOf(
      spec,
      ARGS,
      context({
        now: () => {
          throw cause
        },
      }),
    )
    expect(approval.refused).toMatchObject({ code: "internal_error", cause })
  })

  test("rethrows a cancellation", async () => {
    const controller = new AbortController()
    controller.abort()
    const abort = abortError(controller.signal)
    const { spec } = fixture()
    const error = await approvalOf(
      spec,
      ARGS,
      context({
        now: () => {
          throw abort
        },
      }),
    ).then(
      () => undefined,
      (failure: unknown) => failure,
    )
    expect(error).toBe(abort)
  })
})

describe("approvalOf while someone can be asked", () => {
  test("is unchanged, with grants off or absent, and reads no grant file", async () => {
    for (const ctx of [context({ unattended: false }), { cwd: base }]) {
      const { spec, calls } = fixture()
      const approval = await approvalOf(spec, ARGS, ctx)
      expect(approval).toMatchObject({ resources: ["/work/a.md"], description: { facts: [{ label: "Size" }] } })
      expect(approval.pin).toMatch(PIN_PATTERN)
      expect(calls).toEqual({ gate: 1, targets: 1, describe: 1 })
    }
    expect(await exists(grants.dir)).toBe(false)
  })
})
