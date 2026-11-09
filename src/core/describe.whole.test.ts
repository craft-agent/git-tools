import { describe, expect, test } from "bun:test"
import { z } from "zod"
import {
  callDescription,
  cutDescription,
  MAX_FACTS,
  MAX_HEADLINE_VALUE_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_VALUE_LENGTH,
  wholeCallDescription,
} from "./describe"
import type { ToolContext, ToolSpec } from "./tool"

const CTX: ToolContext = { cwd: "/work" }
const input = z.object({})

type Describer = NonNullable<ToolSpec<typeof input>["describe"]>

const answering = (answer: unknown) =>
  ({ input, describe: (() => answer) as unknown as Describer }) as Pick<ToolSpec, "input" | "describe">

const FACT = { label: "Kind", value: "note" }

const OVER_HEADLINE_VALUE = MAX_HEADLINE_VALUE_LENGTH + 20
const OVER_TEXT = MAX_TEXT_LENGTH + 500

/** An answer with every budget exceeded. */
const overBudget = () => ({
  headline: { text: "Write {name}", values: { name: "n".repeat(OVER_HEADLINE_VALUE) } },
  facts: Array.from({ length: MAX_FACTS + 2 }, (_, index) => ({
    label: index === 0 ? "l".repeat(MAX_LABEL_LENGTH + 20) : `Fact ${index}`,
    value: index === 0 ? "v".repeat(MAX_VALUE_LENGTH + 100) : `value ${index}`,
  })),
  text: { label: "Note text", body: "b".repeat(OVER_TEXT) },
  pins: { hash: "abc" },
})

describe("wholeCallDescription", () => {
  test("keeps every budget's excess", async () => {
    const answer = overBudget()
    const result = await wholeCallDescription(answering(answer), {}, CTX)
    expect(result).toEqual(answer)
    expect(result?.facts).toHaveLength(MAX_FACTS + 2)
    expect(Array.from(result?.text?.body ?? "")).toHaveLength(OVER_TEXT)
    expect(result?.headline?.values?.name).toHaveLength(OVER_HEADLINE_VALUE)
  })

  test("keeps a template value uncut, in a fresh object", async () => {
    const value = { text: "{a}", values: { a: "x".repeat(MAX_VALUE_LENGTH + 100) } }
    const result = await wholeCallDescription(answering({ facts: [{ label: "A", value }] }), {}, CTX)
    expect(result?.facts[0]?.value).toEqual(value)
    expect(result?.facts[0]?.value).not.toBe(value)
  })

  test("drops a bad headline and keeps the rest", async () => {
    const result = await wholeCallDescription(answering({ headline: { text: "Bad {x" }, facts: [FACT] }), {}, CTX)
    expect(result).toEqual({ facts: [FACT] })
    expect(result && "headline" in result).toBe(false)
  })

  const throwing = {
    input,
    describe: () => {
      throw new Error("gone")
    },
  } as Pick<ToolSpec, "input" | "describe">

  test.each<[string, Pick<ToolSpec, "input" | "describe">, unknown]>([
    ["no describer", { input }, {}],
    ["bad args", answering({ facts: [FACT] }), { extra: 1 }],
    ["a bad shape", answering({ facts: "nope" }), {}],
    ["a bad fact", answering({ facts: [{ label: "", value: "x" }] }), {}],
    ["a throwing describer", throwing, {}],
    ["nothing to show", answering({ facts: [], pins: { hash: "x" } }), {}],
  ])("gives undefined, as callDescription does, for %s", async (_name, spec, args) => {
    expect(await wholeCallDescription(spec, args, CTX)).toBeUndefined()
    expect(await callDescription(spec, args, CTX)).toBeUndefined()
  })
})

describe("cutDescription", () => {
  test("gives what callDescription gives for an over-budget answer", async () => {
    const spec = answering(overBudget())
    const whole = await wholeCallDescription(spec, {}, CTX)
    const cutOne = whole && cutDescription(whole)
    expect(cutOne).toEqual(await callDescription(spec, {}, CTX))
    expect(cutOne?.facts).toHaveLength(MAX_FACTS)
    expect(Array.from(cutOne?.facts[0]?.label ?? "")).toHaveLength(MAX_LABEL_LENGTH)
    expect(Array.from(String(cutOne?.facts[0]?.value))).toHaveLength(MAX_VALUE_LENGTH)
    expect(Array.from(cutOne?.text?.body ?? "")).toHaveLength(MAX_TEXT_LENGTH)
    expect(Array.from(cutOne?.headline?.values?.name ?? "")).toHaveLength(MAX_HEADLINE_VALUE_LENGTH)
  })

  test("is idempotent", async () => {
    const whole = await wholeCallDescription(answering(overBudget()), {}, CTX)
    const once = whole && cutDescription(whole)
    expect(once && cutDescription(once)).toEqual(once)
  })

  test("keeps the pins", async () => {
    const whole = await wholeCallDescription(answering(overBudget()), {}, CTX)
    expect(whole && cutDescription(whole).pins).toEqual({ hash: "abc" })
  })

  test("leaves an in-budget description equal to itself, without absent keys", () => {
    const description = { facts: [FACT] }
    const result = cutDescription(description)
    expect(result).toEqual(description)
    expect("headline" in result).toBe(false)
    expect("text" in result).toBe(false)
    expect("pins" in result).toBe(false)
  })
})
