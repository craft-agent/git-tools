import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { defineTool, MAX_BOUNDS, type BoundSpec, type ToolBounds } from "./tool"

const base = {
  id: "demo_thing_create",
  title: "T",
  description: "d",
  toolset: "alpha",
  class: "add",
  input: z.object({ count: z.number().int() }),
  output: z.object({ total: z.number() }),
  execute: async () => ({ total: 1 }),
} as const

const measure = () => ({})
const max: BoundSpec = { kind: "max", description: "The most" }

function define(bounds: ToolBounds | undefined, extra: Record<string, unknown> = { measure }) {
  return defineTool({ ...base, bounds, ...extra } as unknown as Parameters<typeof defineTool>[0])
}

describe("defineTool: bounds", () => {
  test("accepts empty bounds without a measure, and returns the spec as given", () => {
    const given = { ...base, bounds: {} }
    expect(defineTool(given)).toBe(given)
  })

  test("accepts one bound of each kind and returns it as given", () => {
    const bounds = {
      length: max,
      attach: { kind: "allow", description: "Whether it attaches a file" },
      type: { kind: "oneOf", values: ["A", "MX"], description: "The record types" },
    } satisfies ToolBounds
    const given = defineTool({ ...base, bounds, measure: () => ({ length: 1, attach: false, type: "A" }) })
    expect(given.bounds).toBe(bounds)
  })

  test("accepts a spec without bounds", () => {
    expect(() => defineTool({ ...base, id: "demo_thing_read", class: "read" })).not.toThrow()
  })

  test("rejects a measure without bounds", () => {
    expect(() => define(undefined)).toThrow(/demo_thing_create.*measure without bounds/)
  })

  test("rejects bounds on a read tool, even none", () => {
    expect(() => define({}, { id: "demo_thing_read", class: "read" })).toThrow(/demo_thing_read.*read tool/)
  })

  test("rejects bounds on a tool that does not measure them", () => {
    expect(() => define({ length: max }, {})).toThrow(/demo_thing_create.*must give a measure/)
  })

  test.each(["Length", "1length", "_length", "text-length", "", "längd"])("rejects the bound name %j", (name) => {
    expect(() => define({ [name]: max })).toThrow(/demo_thing_create.*bound name/)
  })

  test("rejects a bound name over 40 characters", () => {
    expect(() => define({ [`a${"b".repeat(40)}`]: max })).toThrow(/40 characters/)
    expect(() => define({ [`a${"b".repeat(39)}`]: max })).not.toThrow()
  })

  test.each(["text_length", "a", "a1_b2"])("accepts the bound name %j", (name) => {
    expect(() => define({ [name]: max })).not.toThrow()
  })

  test("rejects a bound of an unknown kind", () => {
    const bound = { kind: "min", description: "The least" } as unknown as BoundSpec
    expect(() => define({ length: bound })).toThrow(/"length".*"demo_thing_create".*"min"/)
  })

  test.each(["", "   "])("rejects the blank description %j", (description) => {
    expect(() => define({ length: { kind: "max", description } })).toThrow(/description that is not blank/)
    expect(() => define({ attach: { kind: "allow", description } })).toThrow(/description that is not blank/)
  })

  test("rejects a bound without a description", () => {
    const bound = { kind: "max" } as unknown as BoundSpec
    expect(() => define({ length: bound })).toThrow(/description that is not blank/)
  })

  test("rejects a oneOf with no values", () => {
    expect(() => define({ type: { kind: "oneOf", values: [], description: "d" } })).toThrow(/list the values/)
  })

  test.each([[[""]], [["A", "  "]]])("rejects a oneOf with the blank value in %j", (values) => {
    expect(() => define({ type: { kind: "oneOf", values, description: "d" } })).toThrow(/values that are not blank/)
  })

  test("rejects a oneOf that repeats a value", () => {
    expect(() => define({ type: { kind: "oneOf", values: ["A", "MX", "A"], description: "d" } })).toThrow(
      /more than once/,
    )
  })

  test("rejects more than MAX_BOUNDS bounds, naming the prompt", () => {
    const names = Array.from({ length: MAX_BOUNDS + 1 }, (_, index) => `bound${String.fromCharCode(97 + index)}`)
    const many = (count: number) => Object.fromEntries(names.slice(0, count).map((name) => [name, max]))
    expect(MAX_BOUNDS).toBe(6)
    expect(() => define(many(MAX_BOUNDS))).not.toThrow()
    expect(() => define(many(MAX_BOUNDS + 1))).toThrow(/demo_thing_create.*at most 6.*prompt must show every bound/)
  })

  test("throws a plain Error naming the tool", () => {
    expect(() => define(undefined)).toThrow(Error)
  })
})
