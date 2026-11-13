import { describe, expect, test } from "bun:test"
import { isToolError } from "../errors"
import type { ToolBounds } from "../tool"
import { MAX_GRANT_DAYS, MAX_GRANT_RATE, RATE_WINDOW_MS, grantBounds, grantTargets } from "./model"

const TOOL = "demo_note_create"
const bounds: ToolBounds = {
  text_length: { kind: "max", description: "The longest text" },
  attach: { kind: "allow", description: "Whether it attaches a file" },
  type: { kind: "oneOf", values: ["A", "MX", "TXT"], description: "The record types" },
}
const valid = { text_length: 100, attach: false, type: ["MX", "A", "MX"] }

function refused(run: () => unknown): Error {
  try {
    run()
  } catch (error) {
    if (isToolError(error)) {
      expect(error.code).toBe("invalid_argument")
      return error
    }
    throw error
  }
  throw new Error("Expected a refusal")
}

describe("limits", () => {
  test("hold the contract's numbers", () => {
    expect(MAX_GRANT_DAYS).toBe(90)
    expect(MAX_GRANT_RATE).toBe(1000)
    expect(RATE_WINDOW_MS).toBe(3_600_000)
  })
})

describe("grantBounds", () => {
  test("returns a normalized copy, with a oneOf sorted without repeats", () => {
    const result = grantBounds(bounds, valid, TOOL)
    expect(result).toEqual({ text_length: 100, attach: false, type: ["A", "MX"] })
    expect(result).not.toBe(valid)
    expect(valid.type).toEqual(["MX", "A", "MX"])
  })

  test("accepts no bounds for a tool that declares none", () => {
    expect(grantBounds({}, {}, TOOL)).toEqual({})
  })

  test("accepts 0 and the largest whole number for a max", () => {
    expect(grantBounds({ n: bounds.text_length! }, { n: 0 }, TOOL)).toEqual({ n: 0 })
    expect(grantBounds({ n: bounds.text_length! }, { n: Number.MAX_SAFE_INTEGER }, TOOL)).toEqual({
      n: Number.MAX_SAFE_INTEGER,
    })
  })

  test.each([[undefined], [null], ["x"], [3], [[]], [[valid]], [new Map()]])("refuses %j as the values", (values) => {
    expect(refused(() => grantBounds(bounds, values, TOOL)).message).toContain("must be an object")
  })

  test("refuses a missing bound, naming it", () => {
    const { attach: _attach, ...rest } = valid
    expect(refused(() => grantBounds(bounds, rest, TOOL)).message).toBe(
      `The bound "attach" of ${TOOL} must be given, since an unset bound would be no bound.`,
    )
  })

  test("refuses an undeclared bound, naming it and the declared ones", () => {
    expect(refused(() => grantBounds(bounds, { ...valid, size: 1 }, TOOL)).message).toBe(
      `${TOOL} has no bound "size"; give only text_length, attach, type.`,
    )
    expect(refused(() => grantBounds({}, { size: 1 }, TOOL)).message).toBe(
      `${TOOL} has no bound "size"; it declares none.`,
    )
  })

  test("refuses an inherited name as undeclared", () => {
    expect(refused(() => grantBounds(bounds, { ...valid, toString: 1 }, TOOL)).message).toContain('no bound "toString"')
    expect(refused(() => grantBounds(bounds, JSON.parse('{"__proto__": 1}'), TOOL)).message).toContain("__proto__")
  })

  test.each([[-1], [1.5], [NaN], [Infinity], [Number.MAX_SAFE_INTEGER + 1], ["5"], [null], [true], [[5]]])(
    "refuses %j for a max",
    (value) => {
      expect(refused(() => grantBounds(bounds, { ...valid, text_length: value }, TOOL)).message).toBe(
        `The bound "text_length" of ${TOOL} must be a whole number of at least 0.`,
      )
    },
  )

  test.each([["true"], [1], [null], [[]]])("refuses %j for an allow", (value) => {
    expect(refused(() => grantBounds(bounds, { ...valid, attach: value }, TOOL)).message).toBe(
      `The bound "attach" of ${TOOL} must be true or false.`,
    )
  })

  test.each([[[]], ["A"], [["A", 1]], [["A", "AAAA"]], [[["A"]]], [null]])("refuses %j for a oneOf", (value) => {
    expect(refused(() => grantBounds(bounds, { ...valid, type: value }, TOOL)).message).toBe(
      `The bound "type" of ${TOOL} must be a non-empty list of values among A, MX, TXT.`,
    )
  })
})

describe("grantTargets", () => {
  test("returns the targets as given, sorted, without repeats", () => {
    expect(grantTargets(["/b", " /a ", "/b", "/a"])).toEqual([" /a ", "/a", "/b"])
  })

  test.each([[undefined], [null], ["/a"], [[]], [{}]])("refuses %j as the list", (targets) => {
    expect(refused(() => grantTargets(targets)).message).toContain("non-empty list")
  })

  test.each([[[""]], [["  "]], [[1]], [[null]], [["/a", "/b/*"]], [["/a?"]], [["*"]]])(
    "refuses the target in %j",
    (targets) => {
      expect(refused(() => grantTargets(targets)).message).toContain("Every target of a grant")
    },
  )
})
