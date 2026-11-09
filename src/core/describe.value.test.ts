import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { callDescription, MAX_HEADLINE_VALUES, MAX_VALUE_LENGTH, MAX_VALUE_TEMPLATE_LENGTH } from "./describe"
import type { ToolContext, ToolSpec } from "./tool"

const CTX: ToolContext = { cwd: "/work" }
const input = z.object({})

type Describer = NonNullable<ToolSpec<typeof input>["describe"]>

const answering = (answer: unknown) =>
  ({ input, describe: (() => answer) as unknown as Describer }) as Pick<ToolSpec, "input" | "describe">

const TEXT = { label: "Note text", body: "body" }

/** What a description with this fact value gives, beside a text that must stay when the fact is good. */
const withValue = (value: unknown) =>
  callDescription(answering({ facts: [{ label: "Size", value }], text: TEXT }), {}, CTX)

const valuesOf = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`v${index}`, "x"]))

describe("callDescription fact value template", () => {
  test("keeps a template with its values, cutting strings, keeping numbers and dropping foreign keys", async () => {
    const long = `${"a".repeat(MAX_VALUE_LENGTH - 2)}😀bc`
    const value = { text: "{bytes} bytes of {name}", values: { bytes: 42, name: long }, extra: 1 }
    const result = await withValue(value)
    expect(result).toEqual({
      facts: [
        {
          label: "Size",
          value: {
            text: "{bytes} bytes of {name}",
            values: { bytes: 42, name: `${"a".repeat(MAX_VALUE_LENGTH - 2)}😀…` },
          },
        },
      ],
      text: TEXT,
    })
    const kept = result!.facts[0]!.value
    expect(Object.keys(kept)).toEqual(["text", "values"])
    expect(kept).not.toBe(value)
  })

  test("keeps a template without placeholders, with or without values, and omits absent values", async () => {
    expect((await withValue({ text: "bytes" }))?.facts[0]?.value).toEqual({ text: "bytes" })
    expect((await withValue({ text: "bytes", values: {} }))?.facts[0]?.value).toEqual({ text: "bytes", values: {} })
    expect((await withValue({ text: "bytes", values: undefined }))?.facts[0]?.value).toEqual({ text: "bytes" })
  })

  test("accepts repeated placeholders, unused values and negative, zero and fractional numbers", async () => {
    const value = { text: "{a} to {a}", values: { a: -0.5, zero: 0, unused: "y" } }
    expect((await withValue(value))?.facts[0]?.value).toEqual(value)
  })

  test("keeps a value named like an object key as an own value", async () => {
    const values = JSON.parse('{"__proto__": "x", "constructor": 1}') as Record<string, string | number>
    const result = await withValue({ text: "{__proto__} {constructor}", values })
    expect(Object.keys((result!.facts[0]!.value as { values: object }).values)).toEqual(["__proto__", "constructor"])
  })

  test("keeps a template that exactly fits and as many values as allowed", async () => {
    expect([MAX_VALUE_TEMPLATE_LENGTH, MAX_HEADLINE_VALUES]).toEqual([200, 8])
    const fits = { text: "😀".repeat(MAX_VALUE_TEMPLATE_LENGTH) }
    expect((await withValue(fits))?.facts[0]?.value).toEqual(fits)
    const values = valuesOf(MAX_HEADLINE_VALUES)
    expect((await withValue({ text: "bytes", values }))?.facts[0]?.value).toEqual({ text: "bytes", values })
  })

  test("is undefined with any bad value template, as with any bad fact", async () => {
    const bad = [
      [],
      {},
      new Date(),
      null,
      { text: 1 },
      { text: "" },
      { text: " \t\n" },
      { text: "x".repeat(MAX_VALUE_TEMPLATE_LENGTH + 1) },
      { text: "{bytes bytes", values: { bytes: 1 } },
      { text: "bytes} bytes", values: { bytes: 1 } },
      { text: "{{bytes}}", values: { bytes: 1 } },
      { text: "{bytes}" },
      { text: "{bytes}", values: {} },
      { text: "{bytes}", values: { other: 1 } },
      { text: "{constructor}", values: {} },
      { text: "bytes", values: valuesOf(MAX_HEADLINE_VALUES + 1) },
      { text: "{bytes}", values: { bytes: Number.NaN } },
      { text: "{bytes}", values: { bytes: Number.POSITIVE_INFINITY } },
      { text: "{bytes}", values: { bytes: Number.NEGATIVE_INFINITY } },
      { text: "{bytes}", values: { bytes: 1n } },
      { text: "{bytes}", values: { bytes: true } },
      { text: "{bytes}", values: { bytes: null } },
      { text: "{bytes}", values: { bytes: undefined } },
      { text: "{bytes}", values: { bytes: { n: 1 } } },
      { text: "{bytes}", values: { bytes: [1] } },
      { text: "bytes", values: [1] },
      { text: "bytes", values: "x" },
      { text: "bytes", values: 1 },
      { text: "bytes", values: null },
      { text: "bytes", values: new Date() },
    ]
    for (const value of bad) {
      expect(await withValue(value)).toBeUndefined()
    }
  })

  test("voids the whole description when one of several facts is bad", async () => {
    const answer = {
      facts: [
        { label: "Kind", value: "note" },
        { label: "Size", value: { text: "{bytes}" } },
      ],
    }
    expect(await callDescription(answering(answer), {}, CTX)).toBeUndefined()
  })

  test("leaves a string value as it was", async () => {
    const long = `${"a".repeat(MAX_VALUE_LENGTH - 2)}😀bc`
    expect((await withValue("42 bytes"))?.facts[0]?.value).toBe("42 bytes")
    expect((await withValue(long))?.facts[0]?.value).toBe(`${"a".repeat(MAX_VALUE_LENGTH - 2)}😀…`)
  })
})
