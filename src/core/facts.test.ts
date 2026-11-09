import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { callDescription } from "./describe"
import { FACT_TRANSLATIONS, sizeFact } from "./facts"
import type { CallValue, ToolSpec } from "./tool"
import { translator } from "./words"

/** The value template of `sizeFact`, which is never a plain string. */
const valueOf = (bytes: number) => sizeFact(bytes).value as CallValue

describe("sizeFact", () => {
  test("labels the fact Size", () => {
    expect(sizeFact(42).label).toBe("Size")
  })

  test("picks the singular template for 1 byte and the plural for every other count", () => {
    expect(valueOf(0)).toEqual({ text: "{bytes} bytes", values: { bytes: 0 } })
    expect(valueOf(1)).toEqual({ text: "{bytes} byte", values: { bytes: 1 } })
    expect(valueOf(2)).toEqual({ text: "{bytes} bytes", values: { bytes: 2 } })
    expect(sizeFact(42)).toEqual({ label: "Size", value: { text: "{bytes} bytes", values: { bytes: 42 } } })
  })

  test("keeps the count as a number, so it is shown without grouping", () => {
    expect(valueOf(1234).values).toEqual({ bytes: 1234 })
    expect(valueOf(1_234_567).values).toEqual({ bytes: 1_234_567 })
  })

  test("is a fact a description keeps", async () => {
    const spec = {
      input: z.object({}),
      describe: () => ({ facts: [sizeFact(1), sizeFact(42)] }),
    } as Pick<ToolSpec, "input" | "describe">
    expect(await callDescription(spec, {}, { cwd: "/work" })).toEqual({ facts: [sizeFact(1), sizeFact(42)] })
  })
})

describe("FACT_TRANSLATIONS", () => {
  const ja = translator(FACT_TRANSLATIONS, "ja")

  test("translates the label", () => {
    expect(ja.word("Size")).toBe("サイズ")
  })

  test("has a Japanese translation the translator takes for each value template of sizeFact", () => {
    for (const bytes of [0, 1, 2]) {
      const { text } = valueOf(bytes)
      expect(ja.template(text)).toBe(FACT_TRANSLATIONS.ja![text]!)
      expect(ja.template(text)).toBe("{bytes} バイト")
    }
  })
})
