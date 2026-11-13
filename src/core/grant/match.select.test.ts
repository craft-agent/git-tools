import { describe, expect, test } from "bun:test"
import type { ToolBounds } from "../tool"
import { matchGrant, measureOf } from "./match"
import type { Grant } from "./model"

const TOOL = "demo_note_create"
const NOW = new Date("2026-06-01T12:00:00Z")
const bounds: ToolBounds = { text_length: { kind: "max", description: "The longest text" } }

function grant(id: string, overrides: Partial<Grant> = {}): Grant {
  return {
    id,
    tool: TOOL,
    targets: ["/work/a.md"],
    bounds: { text_length: 100 },
    rate: 5,
    created_at: "2026-05-31T12:00:00Z",
    expires_at: "2026-06-30T12:00:00Z",
    reason: "daily notes",
    ...overrides,
  }
}

function match(grants: Grant[], used: Record<string, number> = {}, text_length = 10) {
  return matchGrant({
    call: { tool: TOOL, targets: ["/work/a.md"], measure: { text_length } },
    bounds,
    grants,
    now: NOW,
    used: (id) => used[id] ?? 0,
  })
}

function coveredBy(grants: Grant[], used?: Record<string, number>): string | undefined {
  const result = match(grants, used)
  return result.covered ? result.grant.id : undefined
}

function reasonOf(grants: Grant[], used?: Record<string, number>, text_length?: number) {
  const result = match(grants, used, text_length)
  return result.covered ? undefined : result.error.details
}

describe("matchGrant: which grant covers", () => {
  test("the grant with the fewest targets wins", () => {
    const wide = grant("a", { targets: ["/work/a.md", "/work/b.md"] })
    const narrow = grant("b")
    expect(coveredBy([wide, narrow])).toBe("b")
    expect(coveredBy([narrow, wide])).toBe("b")
  })

  test("then the one that expires first", () => {
    const late = grant("a", { expires_at: "2026-07-30T12:00:00Z" })
    const early = grant("b", { expires_at: "2026-06-10T12:00:00Z" })
    expect(coveredBy([late, early])).toBe("b")
  })

  test("then the smallest id", () => {
    expect(coveredBy([grant("c"), grant("a"), grant("b")])).toBe("a")
  })

  test("expires_at is compared as a time, not as text", () => {
    const earlier = grant("a", { expires_at: "2026-06-10T14:00:00+02:00" })
    const later = grant("b", { expires_at: "2026-06-10T13:00:00Z" })
    expect(coveredBy([later, earlier])).toBe("a")
  })

  test("a grant that fails a check is passed over for one that covers", () => {
    const spent = grant("a")
    const open = grant("b", { targets: ["/work/a.md", "/work/b.md"] })
    expect(coveredBy([spent, open], { a: 5 })).toBe("b")
  })

  test("a grant of another tool never covers", () => {
    expect(coveredBy([grant("a", { tool: "demo_other_create" })])).toBeUndefined()
  })
})

describe("matchGrant: the closest grant", () => {
  test("the refusal is the reason of the grant that passed the most checks", () => {
    const expired = grant("a", { expires_at: "2026-05-01T12:00:00Z" })
    const wrongTarget = grant("b", { targets: ["/work/z.md"] })
    const tooLong = grant("c", { bounds: { text_length: 5 } })
    const spent = grant("d")
    expect(reasonOf([expired, wrongTarget, tooLong, spent], { d: 5 })).toEqual({
      reason: "rate",
      tool: TOOL,
      grant: "d",
    })
    expect(reasonOf([expired, wrongTarget, tooLong])).toEqual({
      reason: "bound",
      tool: TOOL,
      grant: "c",
      bound: "text_length",
    })
    expect(reasonOf([expired, wrongTarget])).toEqual({ reason: "target", tool: TOOL, grant: "b" })
    expect(reasonOf([expired])).toEqual({ reason: "expired", tool: TOOL, grant: "a" })
  })

  test("on a tie the earlier grant in the list gives the reason", () => {
    const first = grant("z", { targets: ["/work/x.md"] })
    const second = grant("a", { targets: ["/work/y.md"] })
    expect(reasonOf([first, second])?.grant).toBe("z")
    expect(reasonOf([second, first])?.grant).toBe("a")
  })

  test("a grant that fails a later check beats one that fails an earlier check", () => {
    const wrongTarget = grant("a", { targets: ["/work/z.md"] })
    const tooLong = grant("b", { bounds: { text_length: 5 } })
    expect(reasonOf([wrongTarget, tooLong])).toEqual({ reason: "bound", tool: TOOL, grant: "b", bound: "text_length" })
  })

  test("the checks run in the order expiry, target, bound, rate", () => {
    const all = grant("a", {
      expires_at: "2026-05-01T12:00:00Z",
      targets: ["/work/z.md"],
      bounds: { text_length: 5 },
    })
    expect(reasonOf([all], { a: 5 })?.reason).toBe("expired")
    expect(reasonOf([{ ...all, expires_at: "2026-06-30T12:00:00Z" }], { a: 5 })?.reason).toBe("target")
    expect(reasonOf([{ ...all, expires_at: "2026-06-30T12:00:00Z", targets: ["/work/a.md"] }], { a: 5 })?.reason).toBe(
      "bound",
    )
    expect(reasonOf([grant("a", { bounds: { text_length: 5 } })], { a: 5 })?.reason).toBe("bound")
    expect(reasonOf([grant("a")], { a: 5 })?.reason).toBe("rate")
  })
})

describe("measureOf", () => {
  const declared: ToolBounds = {
    length: { kind: "max", description: "d" },
    attach: { kind: "allow", description: "d" },
    type: { kind: "oneOf", values: ["A", "MX"], description: "d" },
  }

  test("returns the values when the shape is right", () => {
    expect(measureOf(declared, { length: 3, attach: false, type: "A" })).toEqual({
      length: 3,
      attach: false,
      type: "A",
    })
    expect(measureOf(declared, { length: 0.5, attach: true, type: ["A", "MX"] })).toEqual({
      length: 0.5,
      attach: true,
      type: ["A", "MX"],
    })
    expect(measureOf({}, {})).toEqual({})
  })

  test.each([
    ["not an object", [1]],
    ["null", null],
    ["a class instance", new Map()],
    ["a missing bound", { length: 3, attach: false }],
    ["an extra key", { length: 3, attach: false, type: "A", more: 1 }],
    ["a negative max", { length: -1, attach: false, type: "A" }],
    ["an infinite max", { length: Infinity, attach: false, type: "A" }],
    ["a NaN max", { length: NaN, attach: false, type: "A" }],
    ["a numeric string for a max", { length: "3", attach: false, type: "A" }],
    ["a non-boolean allow", { length: 3, attach: 0, type: "A" }],
    ["an empty oneOf list", { length: 3, attach: false, type: [] }],
    ["a oneOf list with a non-string", { length: 3, attach: false, type: ["A", 1] }],
    ["a oneOf number", { length: 3, attach: false, type: 1 }],
  ])("returns undefined for %s", (_name, value) => {
    expect(measureOf(declared, value)).toBeUndefined()
  })

  test("returns undefined for keys other than the declared ones, even in equal number", () => {
    expect(measureOf({ length: declared.length! }, { size: 3 })).toBeUndefined()
  })

  test("returns undefined for values on a tool that declares none but measures some", () => {
    expect(measureOf({}, { length: 3 })).toBeUndefined()
  })
})
