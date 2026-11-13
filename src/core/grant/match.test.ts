import { describe, expect, test } from "bun:test"
import type { CallMeasure, ToolBounds } from "../tool"
import { grantRefusal, matchGrant, type GrantCall } from "./match"
import type { Grant } from "./model"

const TOOL = "demo_note_create"
const NOW = new Date("2026-06-01T12:00:00Z")
const bounds: ToolBounds = {
  text_length: { kind: "max", description: "The longest text" },
  attach: { kind: "allow", description: "Whether it attaches a file" },
  type: { kind: "oneOf", values: ["A", "MX", "TXT"], description: "The record types" },
}

function grant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: "g1",
    tool: TOOL,
    targets: ["/work/a.md", "/work/b.md"],
    bounds: { text_length: 100, attach: false, type: ["A", "MX"] },
    rate: 5,
    created_at: "2026-05-31T12:00:00Z",
    expires_at: "2026-06-30T12:00:00Z",
    reason: "daily notes",
    ...overrides,
  }
}

function call(overrides: Partial<GrantCall> = {}): GrantCall {
  const measure: CallMeasure = { text_length: 10, attach: false, type: "A" }
  return { tool: TOOL, targets: ["/work/a.md"], measure, ...overrides }
}

function match(grants: Grant[], theCall: GrantCall = call(), used: Record<string, number> = {}) {
  return matchGrant({ call: theCall, bounds, grants, now: NOW, used: (id) => used[id] ?? 0 })
}

function refusal(grants: Grant[], theCall?: GrantCall, used?: Record<string, number>) {
  const result = match(grants, theCall, used)
  if (result.covered) throw new Error("Expected a refusal")
  return result.error
}

describe("matchGrant: refusals", () => {
  test("a tool without bounds is not_bounded, whatever the grants", () => {
    const result = matchGrant({ call: call(), bounds: undefined, grants: [grant()], now: NOW, used: () => 0 })
    expect(result.covered).toBe(false)
    if (result.covered) return
    expect(result.error.code).toBe("forbidden")
    expect(result.error.details).toEqual({ reason: "not_bounded", tool: TOOL })
    expect(result.error.message).toBe(
      `${TOOL} cannot run while no one can be asked: it declares no bounds a grant could hold.`,
    )
  })

  test("no grant for the tool is no_grant, also when grants name other tools", () => {
    for (const grants of [[], [grant({ tool: "demo_other_create" })]]) {
      const error = refusal(grants)
      expect(error.details).toEqual({ reason: "no_grant", tool: TOOL })
      expect(error.message).toBe(
        `No grant lets ${TOOL} run while no one can be asked; a person can delegate it with a grant.`,
      )
    }
  })

  test("an expired grant names when it expired", () => {
    const error = refusal([grant({ expires_at: "2026-06-01T11:59:59Z" })])
    expect(error.details).toEqual({ reason: "expired", tool: TOOL, grant: "g1" })
    expect(error.message).toBe(`The grant for ${TOOL} expired at 2026-06-01T11:59:59Z; a person can delegate it again.`)
  })

  test("a grant is expired at its expiry instant, and an unparsable date counts as expired", () => {
    expect(refusal([grant({ expires_at: NOW.toISOString() })]).details?.reason).toBe("expired")
    expect(refusal([grant({ expires_at: "soon" })]).details?.reason).toBe("expired")
    expect(match([grant({ expires_at: "2026-06-01T12:00:01Z" })]).covered).toBe(true)
  })

  test.each([
    ["a target outside the grant", ["/work/c.md"]],
    ["one target of several outside the grant", ["/work/a.md", "/work/c.md"]],
    ["a target that cannot be told", ["*"]],
    ["a known target beside one that cannot be told", ["/work/a.md", "*"]],
    ["no target", []],
  ])("%s is target", (_name, targets) => {
    const error = refusal([grant()], call({ targets }))
    expect(error.details).toEqual({ reason: "target", tool: TOOL, grant: "g1" })
    expect(error.message).toBe(
      `No grant for ${TOOL} covers every target of this call; a person can delegate one that names them.`,
    )
  })

  test("a call may name every target of the grant", () => {
    expect(match([grant()], call({ targets: ["/work/a.md", "/work/b.md"] })).covered).toBe(true)
  })

  test("a rate that is used up names the rate", () => {
    const error = refusal([grant()], call(), { g1: 5 })
    expect(error.details).toEqual({ reason: "rate", tool: TOOL, grant: "g1" })
    expect(error.message).toBe(
      `The grant for ${TOOL} allows 5 calls an hour, and they are used; wait, or a person can delegate a higher rate.`,
    )
    expect(match([grant()], call(), { g1: 4 }).covered).toBe(true)
  })

  test("a refusal is a forbidden ToolError", () => {
    const error = refusal([])
    expect(error.name).toBe("ToolError")
    expect(error.code).toBe("forbidden")
  })
})

describe("matchGrant: bounds", () => {
  test("a measure that failed is a bound refusal with no bound named", () => {
    const error = refusal([grant()], call({ measure: undefined }))
    expect(error.details).toEqual({ reason: "bound", tool: TOOL, grant: "g1" })
    expect(error.message).toBe(
      `This call to ${TOOL} could not be measured against the grant's bounds; a person can delegate a grant for a tool that can measure it.`,
    )
  })

  test.each([
    ["a max over its ceiling", { text_length: 101, attach: false, type: "A" }, "text_length"],
    ["an allow the grant does not give", { text_length: 10, attach: true, type: "A" }, "attach"],
    ["a oneOf value outside the grant", { text_length: 10, attach: false, type: "TXT" }, "type"],
    ["one of several oneOf values outside the grant", { text_length: 10, attach: false, type: ["A", "TXT"] }, "type"],
  ])("%s names the bound", (_name, measure, bound) => {
    const error = refusal([grant()], call({ measure }))
    expect(error.details).toEqual({ reason: "bound", tool: TOOL, grant: "g1", bound })
    expect(error.message).toBe(
      `This call to ${TOOL} goes past the grant's ${bound} bound; a person can delegate a wider grant.`,
    )
  })

  test("a value at a max, a false allow and listed oneOf values are covered", () => {
    expect(match([grant()], call({ measure: { text_length: 100, attach: false, type: ["MX", "A"] } })).covered).toBe(
      true,
    )
    expect(
      match(
        [grant({ bounds: { text_length: 0, attach: true, type: ["TXT"] } })],
        call({ measure: { text_length: 0, attach: true, type: "TXT" } }),
      ).covered,
    ).toBe(true)
  })

  test("a bound the grant leaves out covers nothing, even for a false allow", () => {
    const { attach: _attach, ...rest } = grant().bounds
    const error = refusal([grant({ bounds: rest })])
    expect(error.details).toEqual({ reason: "bound", tool: TOOL, grant: "g1", bound: "attach" })
  })

  test("the first failing bound in name order is the one named", () => {
    const error = refusal([grant()], call({ measure: { text_length: 999, attach: true, type: "TXT" } }))
    expect(error.details?.bound).toBe("attach")
  })

  test("a tool with no bounds is covered by a grant with none", () => {
    const result = matchGrant({
      call: call({ measure: {} }),
      bounds: {},
      grants: [grant({ bounds: {} })],
      now: NOW,
      used: () => 0,
    })
    expect(result.covered).toBe(true)
  })
})

describe("grantRefusal", () => {
  test("no_key and tampered refuse with their own words", () => {
    const noKey = grantRefusal("no_key", TOOL)
    expect(noKey.code).toBe("forbidden")
    expect(noKey.details).toEqual({ reason: "no_key", tool: TOOL })
    expect(noKey.message).toBe(`${TOOL} cannot run while no one can be asked: no grant key is set.`)

    const tampered = grantRefusal("tampered", TOOL, { grant: "g2" })
    expect(tampered.details).toEqual({ reason: "tampered", tool: TOOL, grant: "g2" })
    expect(tampered.message).toBe(
      "The grants were changed outside the package, so nothing runs under them; a person can revoke the grant that fails, or clear the grants.",
    )
  })

  test("a given message replaces the default and details carry only what applies", () => {
    const error = grantRefusal("bound", TOOL, { bound: "type", message: "Custom." })
    expect(error.message).toBe("Custom.")
    expect(error.details).toEqual({ reason: "bound", tool: TOOL, bound: "type" })
  })
})
