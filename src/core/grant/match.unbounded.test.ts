import { describe, expect, test } from "bun:test"
import type { CallMeasure, ToolBounds } from "../tool"
import { matchGrant, type GrantCall } from "./match"
import type { Grant } from "./model"

const TOOL = "demo_note_create"
const NOW = new Date("2026-06-01T12:00:00Z")
const bounds: ToolBounds = {
  text_length: { kind: "max", description: "The longest text" },
  attach: { kind: "allow", description: "Whether it attaches a file" },
}

function grant(id: string, overrides: Partial<Grant> = {}): Grant {
  return {
    id,
    tool: TOOL,
    targets: ["/work/a.md"],
    bounds: {},
    rate: null,
    created_at: "2026-05-31T12:00:00Z",
    expires_at: "2026-06-30T12:00:00Z",
    reason: "notes",
    ...overrides,
  }
}

function call(overrides: Partial<GrantCall> = {}): GrantCall {
  const measure: CallMeasure = { text_length: 10, attach: true }
  return { tool: TOOL, targets: ["/work/a.md"], measure, ...overrides }
}

function match(
  grants: Grant[],
  theCall: GrantCall = call(),
  options: { bounds?: ToolBounds; used?: Record<string, number> } = {},
) {
  return matchGrant({
    call: theCall,
    bounds: "bounds" in options ? options.bounds : bounds,
    grants,
    now: NOW,
    used: (id) => options.used?.[id] ?? 0,
  })
}

function coveredBy(grants: Grant[], theCall?: GrantCall): string | undefined {
  const result = match(grants, theCall)
  return result.covered ? result.grant.id : undefined
}

function reasonOf(grants: Grant[], theCall?: GrantCall, options?: Parameters<typeof match>[2]) {
  const result = match(grants, theCall, options)
  return result.covered ? undefined : result.error.details
}

describe("matchGrant: a tool that declares no bounds", () => {
  test("is covered by a grant naming its targets, which is checked for expiry, target and rate", () => {
    const options = { bounds: undefined }
    expect(match([grant("a")], call({ measure: {} }), options).covered).toBe(true)
    expect(reasonOf([grant("a")], call({ measure: {}, targets: ["/work/z.md"] }), options)?.reason).toBe("target")
    expect(reasonOf([grant("a", { expires_at: "2026-06-01T12:00:00Z" })], call({ measure: {} }), options)?.reason).toBe(
      "expired",
    )
    expect(reasonOf([grant("a", { rate: 1 })], call({ measure: {} }), { ...options, used: { a: 1 } })?.reason).toBe(
      "rate",
    )
  })
})

describe("matchGrant: bounds a grant sets", () => {
  test("a grant that sets none passes without a measure", () => {
    expect(coveredBy([grant("a")], call({ measure: undefined }))).toBe("a")
  })

  test("a bound left out is no limit for any value, while one that is set still limits", () => {
    const grants = [grant("a", { bounds: { text_length: 5 } })]
    expect(coveredBy(grants, call({ measure: { text_length: 5, attach: true } }))).toBe("a")
    expect(reasonOf(grants, call({ measure: { text_length: 6, attach: true } }))).toEqual({
      reason: "bound",
      tool: TOOL,
      grant: "a",
      bound: "text_length",
    })
  })

  test("a measure that failed refuses only under a grant that sets a bound", () => {
    const failed = call({ measure: undefined })
    expect(reasonOf([grant("a", { bounds: { attach: true } })], failed)).toEqual({
      reason: "bound",
      tool: TOOL,
      grant: "a",
    })
    expect(coveredBy([grant("a", { bounds: { attach: true } }), grant("b")], failed)).toBe("b")
  })

  test("only the set bounds are checked, in name order", () => {
    const measure = { text_length: 99, attach: true }
    const grants = [grant("a", { bounds: { text_length: 5, attach: false } })]
    expect(reasonOf(grants, call({ measure }))?.bound).toBe("attach")
  })

  test("a set bound the tool no longer declares is a bound refusal naming it", () => {
    const grants = [grant("a", { bounds: { gone: 1 } })]
    expect(reasonOf(grants, call())).toEqual({ reason: "bound", tool: TOOL, grant: "a", bound: "gone" })
    expect(reasonOf(grants, call(), { bounds: undefined })?.bound).toBe("gone")
    expect(reasonOf([grant("a", { bounds: { constructor: 1 } })], call())?.bound).toBe("constructor")
  })
})

describe("matchGrant: any target", () => {
  const any = grant("a", { targets: ["*"] })

  test.each([
    ["a named target", ["/work/z.md"]],
    ["several targets", ["/work/y.md", "/work/z.md"]],
    ["a target that cannot be told", ["*"]],
    ["a known target beside one that cannot be told", ["/work/a.md", "*"]],
    ["no target", []],
  ])("covers a call with %s", (_name, targets) => {
    expect(coveredBy([any], call({ targets }))).toBe("a")
  })

  test("means * alone: a stored * beside a name covers only that name", () => {
    const mixed = grant("a", { targets: ["*", "/work/a.md"] })
    expect(coveredBy([mixed])).toBe("a")
    expect(reasonOf([mixed], call({ targets: ["/work/z.md"] }))?.reason).toBe("target")
    expect(reasonOf([mixed], call({ targets: ["*"] }))?.reason).toBe("target")
  })

  test("is still checked for expiry, bounds and rate", () => {
    expect(reasonOf([{ ...any, expires_at: "2026-06-01T12:00:00Z" }])?.reason).toBe("expired")
    expect(reasonOf([{ ...any, bounds: { text_length: 1 } }])?.reason).toBe("bound")
    expect(reasonOf([{ ...any, rate: 1 }], call(), { used: { a: 1 } })?.reason).toBe("rate")
  })

  test("a grant naming its targets is used before it, however many targets it names", () => {
    const named = grant("z", { targets: ["/work/a.md", "/work/b.md", "/work/c.md"] })
    expect(coveredBy([any, named])).toBe("z")
    expect(coveredBy([named, any])).toBe("z")
  })

  test("a call outside the named grant still falls to the any-target grant", () => {
    expect(coveredBy([grant("z"), any], call({ targets: ["/work/q.md"] }))).toBe("a")
  })
})

describe("matchGrant: rate", () => {
  test("a grant with no rate is never refused for it, however many calls ran", () => {
    expect(match([grant("a")], call(), { used: { a: 1_000_000 } }).covered).toBe(true)
  })
})

describe("matchGrant: more bounds set wins a tie", () => {
  test("on equal targets, the grant that sets more bounds is used before the one that expires first", () => {
    const loose = grant("a", { expires_at: "2026-06-10T12:00:00Z" })
    const tight = grant("b", { bounds: { text_length: 50 }, expires_at: "2026-06-20T12:00:00Z" })
    expect(coveredBy([loose, tight])).toBe("b")
    expect(coveredBy([tight, loose])).toBe("b")
  })

  test("fewer targets still win over more bounds", () => {
    const narrow = grant("a")
    const bounded = grant("b", { targets: ["/work/a.md", "/work/b.md"], bounds: { text_length: 50, attach: true } })
    expect(coveredBy([bounded, narrow])).toBe("a")
  })

  test("among any-target grants, more bounds set wins too", () => {
    const loose = grant("a", { targets: ["*"] })
    const tight = grant("b", { targets: ["*"], bounds: { attach: true } })
    expect(coveredBy([loose, tight])).toBe("b")
  })
})
