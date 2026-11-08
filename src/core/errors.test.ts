import { describe, expect, test } from "bun:test"
import { ToolError, type ErrorDetails } from "./errors"

describe("ToolError", () => {
  test("without details there is no details property", () => {
    const error = new ToolError("not_found", "No such thing.")
    expect("details" in error).toBe(false)
    expect(error.details).toBeUndefined()
  })

  test("details is a copy, unaffected by later mutation of the original, and deeply frozen", () => {
    const original = {
      nested: { key: "initial" },
      items: ["first", { name: "item" }],
    } satisfies ErrorDetails
    const error = new ToolError("invalid_argument", "Invalid thing.", { details: original })

    expect("details" in error).toBe(true)
    expect(error.details).toEqual({
      nested: { key: "initial" },
      items: ["first", { name: "item" }],
    })

    original.nested.key = "mutated"
    original.items[0] = "mutated"
    expect(error.details).toEqual({
      nested: { key: "initial" },
      items: ["first", { name: "item" }],
    })

    expect(Object.isFrozen(error.details)).toBe(true)
    expect(Object.isFrozen(error.details?.nested)).toBe(true)
    expect(Object.isFrozen(error.details?.items)).toBe(true)
    expect(Object.isFrozen((error.details?.items as unknown[])[1])).toBe(true)
  })

  test("undefined-valued nested keys are dropped by the copy", () => {
    const original = { nested: { key: "value", dropped: undefined } } as unknown as ErrorDetails
    const error = new ToolError("invalid_argument", "Invalid thing.", { details: original })
    expect(error.details).toEqual({ nested: { key: "value" } })
    expect("dropped" in (error.details?.nested as ErrorDetails)).toBe(false)
  })

  test("a cyclic object throws TypeError from the constructor", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => {
      new ToolError("invalid_argument", "Cyclic.", { details: cyclic as unknown as ErrorDetails })
    }).toThrow(TypeError)
  })

  test("cause still works as before", () => {
    const cause = new Error("inner failure")
    const withCause = new ToolError("internal_error", "Outer failure.", { cause })
    expect(withCause.cause).toBe(cause)

    const withoutCause = new ToolError("internal_error", "Outer failure.")
    expect(withoutCause.cause).toBeUndefined()
  })
})
