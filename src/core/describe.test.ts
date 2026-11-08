import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { callDescription, MAX_FACTS, MAX_LABEL_LENGTH, MAX_TEXT_LENGTH, MAX_VALUE_LENGTH } from "./describe"
import type { ToolContext, ToolSpec } from "./tool"

const CTX: ToolContext = { cwd: "/work" }
const input = z.object({ name: z.string().default("item") })

type Describer = NonNullable<ToolSpec<typeof input>["describe"]>

function specWith(describe?: Describer) {
  return { input, describe } as Pick<ToolSpec, "input" | "describe">
}

const answering = (answer: unknown) => specWith((() => answer) as unknown as Describer)

describe("callDescription", () => {
  test("is undefined for a tool without a describer", async () => {
    expect(await callDescription(specWith(), {}, CTX)).toBeUndefined()
  })

  test("rejects invalid arguments without calling the describer", async () => {
    let called = false
    const spec = specWith(() => {
      called = true
      return { facts: [], text: "body" }
    })
    for (const args of [{ name: 1 }, { extra: 1 }, null, "text", []]) {
      expect(await callDescription(spec, args, CTX)).toBeUndefined()
    }
    expect(called).toBe(false)
  })

  test("gives facts and text from the parsed arguments and the context", async () => {
    const seen: unknown[] = []
    const spec = specWith((args, ctx) => {
      seen.push(args, ctx)
      return { facts: [{ label: "Name", value: args.name }], text: "body" }
    })
    expect(await callDescription(spec, {}, CTX)).toEqual({ facts: [{ label: "Name", value: "item" }], text: "body" })
    expect(seen).toEqual([{ name: "item" }, CTX])
  })

  test("copies facts, ignores extra keys and omits absent, undefined or empty text", async () => {
    const fact = { label: " Name ", value: "item", extra: true }
    for (const text of [undefined, ""]) {
      const answer = { facts: [fact], text, extra: true }
      const result = await callDescription(answering(answer), {}, CTX)
      expect(result).toEqual({ facts: [{ label: " Name ", value: "item" }] })
      expect(result).not.toBe(answer)
      expect(result?.facts).not.toBe(answer.facts)
      expect(result?.facts[0]).not.toBe(fact)
    }
    expect(await callDescription(answering({ facts: [fact] }), {}, CTX)).toEqual({
      facts: [{ label: " Name ", value: "item" }],
    })
  })

  test("keeps only the first eight facts", async () => {
    expect(MAX_FACTS).toBe(8)
    const facts = Array.from({ length: MAX_FACTS + 1 }, (_, index) => ({ label: "Name", value: String(index) }))
    expect(await callDescription(answering({ facts }), {}, CTX)).toEqual({ facts: facts.slice(0, MAX_FACTS) })
  })

  test("cuts labels, values and text by code points, keeping an emoji at the boundary whole", async () => {
    expect([MAX_LABEL_LENGTH, MAX_VALUE_LENGTH, MAX_TEXT_LENGTH]).toEqual([40, 200, 2000])
    const long = (limit: number) => `${"a".repeat(limit - 2)}😀bc`
    const expected = (limit: number) => `${"a".repeat(limit - 2)}😀…`
    const result = await callDescription(
      answering({
        facts: [{ label: long(MAX_LABEL_LENGTH), value: long(MAX_VALUE_LENGTH) }],
        text: long(MAX_TEXT_LENGTH),
      }),
      {},
      CTX,
    )
    expect(result).toEqual({
      facts: [{ label: expected(MAX_LABEL_LENGTH), value: expected(MAX_VALUE_LENGTH) }],
      text: expected(MAX_TEXT_LENGTH),
    })
    expect(Array.from(result!.facts[0].label)).toHaveLength(MAX_LABEL_LENGTH)
    expect(Array.from(result!.facts[0].value)).toHaveLength(MAX_VALUE_LENGTH)
    expect(Array.from(result!.text!)).toHaveLength(MAX_TEXT_LENGTH)
  })

  test("does not cut strings that exactly fit their budgets", async () => {
    const answer = {
      facts: [{ label: "😀".repeat(MAX_LABEL_LENGTH), value: "😀".repeat(MAX_VALUE_LENGTH) }],
      text: "😀".repeat(MAX_TEXT_LENGTH),
    }
    expect(await callDescription(answering(answer), {}, CTX)).toEqual(answer)
  })

  test("is undefined for an answer of another shape, including any invalid fact", async () => {
    const invalid = [
      "text",
      undefined,
      null,
      [],
      new Date(),
      {},
      { facts: "text" },
      { facts: null },
      { facts: [{ value: "item" }] },
      { facts: [{ label: " \t\n", value: "item" }] },
      { facts: [{ label: "Name", value: 1 }] },
      { facts: [null] },
      { facts: ["text"] },
      { facts: [], text: 1 },
      { facts: [], text: null },
      { facts: [...Array.from({ length: MAX_FACTS }, () => ({ label: "Name", value: "item" })), null] },
    ]
    for (const answer of invalid) {
      expect(await callDescription(answering(answer), {}, CTX)).toBeUndefined()
    }
  })

  test("is undefined with no facts or text, but keeps text without facts", async () => {
    expect(await callDescription(answering({ facts: [] }), {}, CTX)).toBeUndefined()
    expect(await callDescription(answering({ facts: [], text: "" }), {}, CTX)).toBeUndefined()
    expect(await callDescription(answering({ facts: [], text: "body" }), {}, CTX)).toEqual({ facts: [], text: "body" })
  })

  test("is undefined when the describer throws or rejects", async () => {
    const throwing = specWith(() => {
      throw new Error("boom")
    })
    const rejecting = specWith(async () => {
      throw new Error("boom")
    })
    expect(await callDescription(throwing, {}, CTX)).toBeUndefined()
    expect(await callDescription(rejecting, {}, CTX)).toBeUndefined()
  })

  test("rethrows a cancellation", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" })
    const spec = specWith(async () => {
      throw abort
    })
    await expect(callDescription(spec, {}, CTX)).rejects.toBe(abort)
  })

  test("rethrows any failure after the call's signal aborts", async () => {
    const controller = new AbortController()
    const failure = new Error("boom")
    const spec = specWith(async () => {
      controller.abort()
      throw failure
    })
    await expect(callDescription(spec, {}, { ...CTX, signal: controller.signal })).rejects.toBe(failure)
  })

  test("takes an asynchronous describer as well", async () => {
    const answer = { facts: [{ label: "Name", value: "item" }], text: "body" }
    expect(
      await callDescription(
        specWith(async () => answer),
        {},
        CTX,
      ),
    ).toEqual(answer)
  })
})
