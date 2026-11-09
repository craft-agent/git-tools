import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { callDescription, MAX_PINS } from "./describe"
import type { ToolContext, ToolSpec } from "./tool"

const CTX: ToolContext = { cwd: "/work" }
const input = z.object({})

type Describer = NonNullable<ToolSpec<typeof input>["describe"]>

const answering = (answer: unknown) =>
  ({ input, describe: (() => answer) as unknown as Describer }) as Pick<ToolSpec, "input" | "describe">

const FACTS = [{ label: "Kind", value: "note" }]

/** What a description with these pins gives, beside a fact that must stay when the pins are good. */
const withPins = (pins: unknown) => callDescription(answering({ facts: FACTS, pins }), {}, CTX)

const pinsOf = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`p${index}`, "x"]))

describe("callDescription pins", () => {
  test("keeps the pins as given, uncut, in a fresh object", async () => {
    const long = "a".repeat(5000)
    const pins = { " hash ": long, mtime: "" }
    const result = await withPins(pins)
    expect(result).toEqual({ facts: FACTS, pins })
    expect(result?.pins).not.toBe(pins)
  })

  test("keeps exactly MAX_PINS pins", async () => {
    expect(MAX_PINS).toBe(16)
    expect((await withPins(pinsOf(MAX_PINS)))?.pins).toEqual(pinsOf(MAX_PINS))
  })

  test("drops an empty record and leaves the rest as it was", async () => {
    const result = await withPins({})
    expect(result).toEqual({ facts: FACTS })
    expect(result && "pins" in result).toBe(false)
  })

  test("has no pins key without pins", async () => {
    const result = await callDescription(answering({ facts: FACTS }), {}, CTX)
    expect(result && "pins" in result).toBe(false)
  })

  test.each<[string, unknown]>([
    ["more than MAX_PINS", pinsOf(MAX_PINS + 1)],
    ["a blank name", { " ": "x" }],
    ["an empty name", { "": "x" }],
    ["a number value", { hash: 1 }],
    ["a null value", { hash: null }],
    ["an object value", { hash: { text: "x" } }],
    ["an array", ["x"]],
    ["a string", "hash"],
    ["null", null],
    ["a class instance", new Map([["hash", "x"]])],
  ])("gives no description for pins that are %s", async (_name, pins) => {
    expect(await withPins(pins)).toBeUndefined()
  })

  test("gives no description for pins alone, since nothing is shown", async () => {
    expect(await callDescription(answering({ facts: [], pins: { hash: "x" } }), {}, CTX)).toBeUndefined()
  })

  test("keeps pins beside a headline or a text with no facts", async () => {
    const text = { label: "Body", body: "body" }
    const result = await callDescription(answering({ facts: [], text, pins: { hash: "x" } }), {}, CTX)
    expect(result).toEqual({ facts: [], text, pins: { hash: "x" } })
  })
})
