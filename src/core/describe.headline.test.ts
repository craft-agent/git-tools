import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { callDescription, MAX_HEADLINE_LENGTH, MAX_HEADLINE_VALUE_LENGTH, MAX_HEADLINE_VALUES } from "./describe"
import type { ToolContext, ToolSpec } from "./tool"

const CTX: ToolContext = { cwd: "/work" }
const input = z.object({})

type Describer = NonNullable<ToolSpec<typeof input>["describe"]>

const answering = (answer: unknown) =>
  ({ input, describe: (() => answer) as unknown as Describer }) as Pick<ToolSpec, "input" | "describe">

const FACT = { label: "Name", value: "item" }
const TEXT = { label: "Note text", body: "body" }

/** What a description with this headline gives, beside facts and a text that must stay. */
const withHeadline = (headline: unknown) => callDescription(answering({ headline, facts: [FACT], text: TEXT }), {}, CTX)

describe("callDescription headline", () => {
  test("keeps a valid headline with its values, ignoring extra keys", async () => {
    const headline = { text: "Create the note {name} in {area}", values: { name: "todo", area: "work" }, extra: 1 }
    const result = await withHeadline(headline)
    expect(result).toEqual({
      headline: { text: "Create the note {name} in {area}", values: { name: "todo", area: "work" } },
      facts: [FACT],
      text: TEXT,
    })
    expect(result?.headline).not.toBe(headline)
  })

  test("keeps a template without placeholders, with or without values", async () => {
    expect((await withHeadline({ text: "Create a note" }))?.headline).toEqual({ text: "Create a note" })
    expect((await withHeadline({ text: "Create a note", values: {} }))?.headline).toEqual({
      text: "Create a note",
      values: {},
    })
  })

  test("accepts underscore and digit names, repeated placeholders and unused values", async () => {
    const headline = { text: "Move {_a1} to {_a1}", values: { _a1: "x", unused: "y" } }
    expect((await withHeadline(headline))?.headline).toEqual(headline)
  })

  test("treats an absent or undefined headline as none", async () => {
    expect(await callDescription(answering({ facts: [FACT] }), {}, CTX)).toEqual({ facts: [FACT] })
    expect(await withHeadline(undefined)).toEqual({ facts: [FACT], text: TEXT })
  })

  test("keeps a description that is only a headline", async () => {
    const headline = { text: "Create the note {name}", values: { name: "todo" } }
    expect(await callDescription(answering({ headline, facts: [] }), {}, CTX)).toEqual({ headline, facts: [] })
  })

  test("drops a bad headline alone, keeping the facts and the text", async () => {
    const bad = [
      null,
      "Create the note",
      [],
      {},
      new Date(),
      { text: 1 },
      { text: "" },
      { text: " \t\n" },
      { text: "Create {name", values: { name: "x" } },
      { text: "Create name}", values: { name: "x" } },
      { text: "Create {", values: {} },
      { text: "}", values: {} },
      { text: "Create {{name}}", values: { name: "x" } },
      { text: "Create {a b}", values: { "a b": "x" } },
      { text: "Create {}", values: { "": "x" } },
      { text: "Create {1a}", values: { "1a": "x" } },
      { text: "Create {name}" },
      { text: "Create {name}", values: {} },
      { text: "Create {name}", values: { other: "x" } },
      { text: "Create {name}", values: { name: 1 } },
      { text: "Create {name}", values: { name: null } },
      { text: "Create {name}", values: null },
      { text: "Create {name}", values: "x" },
      { text: "Create {name}", values: ["x"] },
      { text: "x".repeat(MAX_HEADLINE_LENGTH + 1) },
      {
        text: "Create",
        values: Object.fromEntries(Array.from({ length: MAX_HEADLINE_VALUES + 1 }, (_, index) => [`v${index}`, "x"])),
      },
    ]
    for (const headline of bad) {
      expect(await withHeadline(headline)).toEqual({ facts: [FACT], text: TEXT })
    }
  })

  test("keeps a template that exactly fits and as many values as allowed", async () => {
    expect([MAX_HEADLINE_LENGTH, MAX_HEADLINE_VALUES, MAX_HEADLINE_VALUE_LENGTH]).toEqual([120, 8, 80])
    const fits = { text: "😀".repeat(MAX_HEADLINE_LENGTH) }
    expect((await withHeadline(fits))?.headline).toEqual(fits)
    const values = Object.fromEntries(Array.from({ length: MAX_HEADLINE_VALUES }, (_, index) => [`v${index}`, "x"]))
    expect((await withHeadline({ text: "Create", values }))?.headline).toEqual({ text: "Create", values })
  })

  test("cuts a value by code points, keeping an emoji at the boundary whole", async () => {
    const long = `${"a".repeat(MAX_HEADLINE_VALUE_LENGTH - 2)}😀bc`
    const result = await withHeadline({ text: "Create {name}", values: { name: long } })
    expect(result?.headline?.values?.name).toBe(`${"a".repeat(MAX_HEADLINE_VALUE_LENGTH - 2)}😀…`)
    expect(Array.from(result!.headline!.values!.name!)).toHaveLength(MAX_HEADLINE_VALUE_LENGTH)
    const fits = "😀".repeat(MAX_HEADLINE_VALUE_LENGTH)
    expect((await withHeadline({ text: "Create {name}", values: { name: fits } }))?.headline?.values?.name).toBe(fits)
  })

  test("keeps a value named like an object key as an own value", async () => {
    const values = JSON.parse('{"__proto__": "x", "constructor": "y"}') as Record<string, string>
    const result = await withHeadline({ text: "{__proto__} {constructor}", values })
    expect(Object.keys(result!.headline!.values!)).toEqual(["__proto__", "constructor"])
  })

  test("does not take an inherited name as a value", async () => {
    expect((await withHeadline({ text: "Create {constructor}", values: {} }))?.headline).toBeUndefined()
    expect((await withHeadline({ text: "Create {toString}", values: {} }))?.headline).toBeUndefined()
  })

  test("is undefined with no headline, facts or text", async () => {
    expect(await callDescription(answering({ headline: { text: "Bad {x" }, facts: [] }), {}, CTX)).toBeUndefined()
  })
})
