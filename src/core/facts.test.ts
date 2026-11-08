import { describe, expect, test } from "bun:test"
import { sizeFact } from "./facts"

describe("sizeFact", () => {
  test("labels the fact Size", () => {
    expect(sizeFact(42).label).toBe("Size")
  })

  test("reads 1 byte in the singular and every other count in the plural", () => {
    expect(sizeFact(0).value).toBe("0 bytes")
    expect(sizeFact(1).value).toBe("1 byte")
    expect(sizeFact(2).value).toBe("2 bytes")
    expect(sizeFact(42)).toEqual({ label: "Size", value: "42 bytes" })
  })

  test("does not group the thousands", () => {
    expect(sizeFact(1234).value).toBe("1234 bytes")
    expect(sizeFact(1_234_567).value).toBe("1234567 bytes")
  })
})
