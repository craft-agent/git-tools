import { describe, expect, test } from "bun:test"
import { MAX_VALUE_LENGTH, cut, omittedBy } from "./describe"

describe("omittedBy", () => {
  test("is zero under and at the limit", () => {
    expect(omittedBy("", 10)).toBe(0)
    expect(omittedBy("a".repeat(9), 10)).toBe(0)
    expect(omittedBy("a".repeat(10), 10)).toBe(0)
  })

  test("counts the ellipsis's slot: one over the limit leaves out two", () => {
    expect(omittedBy("a".repeat(11), 10)).toBe(2)
  })

  test("counts far over the limit", () => {
    expect(omittedBy("a".repeat(100), 10)).toBe(91)
  })

  test("counts code points, not UTF-16 units", () => {
    expect(omittedBy("😀", 1)).toBe(0)
    expect(omittedBy("😀".repeat(11), 10)).toBe(2)
    expect(omittedBy("😀".repeat(30), 10)).toBe(21)
  })

  test("agrees with what cut keeps", () => {
    for (const length of [0, 1, MAX_VALUE_LENGTH - 1, MAX_VALUE_LENGTH, MAX_VALUE_LENGTH + 1, 1000]) {
      const text = "😀".repeat(length)
      const kept = Array.from(cut(text, MAX_VALUE_LENGTH)).length
      const wasCut = omittedBy(text, MAX_VALUE_LENGTH) > 0
      expect(Array.from(text).length - omittedBy(text, MAX_VALUE_LENGTH) + (wasCut ? 1 : 0)).toBe(kept)
    }
  })
})
