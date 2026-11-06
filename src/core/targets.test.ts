import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { abortError } from "./exec"
import { ANY_TARGET, writeTargets } from "./targets"
import type { ToolContext, ToolSpec } from "./tool"

const CTX: ToolContext = { cwd: "/work" }
const input = z.object({ names: z.array(z.string()).default([]), count: z.number().optional() })

type Resolver = NonNullable<ToolSpec<typeof input>["targets"]>

function specWith(targets?: Resolver) {
  return { input, targets } as Pick<ToolSpec, "input" | "targets">
}

const answering = (answer: unknown) => specWith((async () => answer) as unknown as Resolver)

describe("writeTargets", () => {
  test("is * for a tool without a resolver", async () => {
    expect(ANY_TARGET).toBe("*")
    expect(await writeTargets(specWith(), {}, CTX)).toEqual(["*"])
  })

  test("gives what the resolver answers, from the parsed arguments and the context", async () => {
    const seen: unknown[] = []
    const spec = specWith((args, ctx) => {
      seen.push(args, ctx)
      return args.names
    })
    expect(await writeTargets(spec, { names: ["a"] }, CTX)).toEqual(["a"])
    expect(await writeTargets(spec, {}, CTX)).toEqual(["*"])
    expect(seen).toEqual([{ names: ["a"] }, CTX, { names: [] }, CTX])
  })

  test("takes an asynchronous resolver as well", async () => {
    expect(await writeTargets(answering(["a"]), {}, CTX)).toEqual(["a"])
  })

  test("is * for arguments the input schema rejects, without calling the resolver", async () => {
    let called = false
    const spec = specWith(() => {
      called = true
      return ["a"]
    })
    for (const args of [{ names: "a" }, { extra: 1 }, null, "text", []]) {
      expect(await writeTargets(spec, args, CTX)).toEqual(["*"])
    }
    expect(called).toBe(false)
  })

  test("sorts and deduplicates, keeping the case", async () => {
    expect(await writeTargets(answering(["b", "A", "b", "a"]), {}, CTX)).toEqual(["A", "a", "b"])
  })

  test("puts * last beside the others, once", async () => {
    expect(await writeTargets(answering(["z", "*", "a", "*"]), {}, CTX)).toEqual(["a", "z", "*"])
  })

  test("turns a blank or non-text entry into *", async () => {
    expect(await writeTargets(answering(["a", "", "  ", 3, null, undefined]), {}, CTX)).toEqual(["a", "*"])
    expect(await writeTargets(answering([""]), {}, CTX)).toEqual(["*"])
  })

  test("turns an entry holding a wildcard into *, so an always answer stores no pattern", async () => {
    expect(await writeTargets(answering(["a", "notes/*.md", "b?"]), {}, CTX)).toEqual(["a", "*"])
  })

  test("is * for an empty answer and for one that is not a list", async () => {
    expect(await writeTargets(answering([]), {}, CTX)).toEqual(["*"])
    expect(await writeTargets(answering("a"), {}, CTX)).toEqual(["*"])
    expect(await writeTargets(answering(undefined), {}, CTX)).toEqual(["*"])
  })

  test("is * when the resolver fails, whether it throws or rejects", async () => {
    const throwing = specWith(() => {
      throw new Error("boom")
    })
    const rejecting = specWith(async () => {
      throw new Error("boom")
    })
    expect(await writeTargets(throwing, {}, CTX)).toEqual(["*"])
    expect(await writeTargets(rejecting, {}, CTX)).toEqual(["*"])
  })

  test("rethrows a cancellation", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" })
    const spec = specWith(async () => {
      throw abort
    })
    await expect(writeTargets(spec, {}, CTX)).rejects.toBe(abort)
  })

  test("rethrows any failure of a call whose signal is aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const failure = new Error("boom")
    const spec = specWith(async () => {
      throw failure
    })
    await expect(writeTargets(spec, {}, { ...CTX, signal: controller.signal })).rejects.toBe(failure)
    const cancelled = specWith(async () => {
      throw abortError(controller.signal)
    })
    await expect(writeTargets(cancelled, {}, { ...CTX, signal: controller.signal })).rejects.toThrow("aborted")
  })

  test("a signal that has not aborted does not change a failure into a rethrow", async () => {
    const spec = specWith(async () => {
      throw new Error("boom")
    })
    expect(await writeTargets(spec, {}, { ...CTX, signal: new AbortController().signal })).toEqual(["*"])
  })
})
