import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { ToolError, abortError, isToolError, type ToolContext, type ToolSpec } from "../core"
import { gateRefusal } from "./gate"
import { approvalOf, checkPin } from "./pin"

const CTX: ToolContext = { cwd: "/work" }
const input = z.object({ name: z.string().default("todo") })

type Gate = NonNullable<ToolSpec["gate"]>

/** A fixture that counts how often its gate, targets and describer run. */
function fixture(gate?: Gate) {
  const calls = { gate: 0, targets: 0, describe: 0 }
  const spec: Pick<ToolSpec, "input" | "gate" | "targets" | "describe"> = {
    input,
    gate:
      gate &&
      ((args, ctx) => {
        calls.gate++
        return gate(args, ctx)
      }),
    targets: () => {
      calls.targets++
      return ["/work/todo.md"]
    },
    describe: () => {
      calls.describe++
      return { facts: [{ label: "Size", value: "1" }] }
    },
  }
  return { spec, calls }
}

const refuse = (error: unknown): Gate => {
  return () => {
    throw error
  }
}

describe("gateRefusal", () => {
  test("is undefined without a gate", async () => {
    expect(await gateRefusal({ input }, {}, CTX)).toBeUndefined()
  })

  test("is undefined when the gate returns, and the gate sees the parsed args and ctx", async () => {
    const seen: unknown[] = []
    const refusal = await gateRefusal({ input, gate: (args, ctx) => void seen.push(args, ctx) }, {}, CTX)
    expect(refusal).toBeUndefined()
    expect(seen).toEqual([{ name: "todo" }, CTX])
  })

  test("is the ToolError the gate throws", async () => {
    const failure = new ToolError("forbidden", "Out of reach.")
    expect(await gateRefusal({ input, gate: refuse(failure) }, {}, CTX)).toBe(failure)
  })

  test("is undefined for invalid arguments, without calling the gate", async () => {
    const { spec, calls } = fixture(refuse(new ToolError("forbidden", "no")))
    expect(await gateRefusal(spec, { name: 3 }, CTX)).toBeUndefined()
    expect(await gateRefusal(spec, { bogus: 1 }, CTX)).toBeUndefined()
    expect(calls.gate).toBe(0)
  })

  test("turns any other failure into internal_error, keeping it as the cause", async () => {
    const failure = new Error("disk gone")
    const refusal = await gateRefusal({ input, gate: refuse(failure) }, {}, CTX)
    expect(isToolError(refusal) && refusal.code).toBe("internal_error")
    expect(refusal?.message).toBe("Could not tell whether this call is allowed, so it did not run.")
    expect(refusal?.cause).toBe(failure)
  })

  test("rethrows an abort", async () => {
    const controller = new AbortController()
    controller.abort()
    const abort = abortError(controller.signal)
    const error = await gateRefusal({ input, gate: refuse(abort) }, {}, CTX).then(
      () => undefined,
      (failure: unknown) => failure,
    )
    expect(error).toBe(abort)
  })

  test("rethrows any failure once the signal is aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const failure = new Error("late")
    const error = await gateRefusal({ input, gate: refuse(failure) }, {}, { ...CTX, signal: controller.signal }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect(error).toBe(failure)
  })
})

describe("approvalOf with a gate", () => {
  test("a refusal resolves neither the targets nor the description", async () => {
    const failure = new ToolError("not_found", "No such note.")
    const { spec, calls } = fixture(refuse(failure))
    const approval = await approvalOf(spec, {}, CTX)
    expect(approval).toEqual({ refused: failure })
    expect(approval.refused).toBe(failure)
    expect(calls).toEqual({ gate: 1, targets: 0, describe: 0 })
  })

  test("a gate that fails is a refusal with internal_error", async () => {
    const { spec } = fixture(refuse(new Error("boom")))
    const approval = await approvalOf(spec, {}, CTX)
    expect(approval.refused?.code).toBe("internal_error")
  })

  test("a gate that returns leaves the approval as it was", async () => {
    const { spec, calls } = fixture(() => {})
    const approval = await approvalOf(spec, {}, CTX)
    expect(approval.refused).toBeUndefined()
    expect(approval).toMatchObject({
      resources: ["/work/todo.md"],
      description: { facts: [{ label: "Size", value: "1" }] },
    })
    expect(calls).toEqual({ gate: 1, targets: 1, describe: 1 })
  })

  test("without a gate the approval is as it was", async () => {
    const { spec, calls } = fixture()
    const approval = await approvalOf(spec, {}, CTX)
    expect(approval).toMatchObject({ resources: ["/work/todo.md"] })
    expect(calls).toEqual({ gate: 0, targets: 1, describe: 1 })
  })

  test("invalid arguments do not reach the gate, and the approval is as it was", async () => {
    const { spec, calls } = fixture(refuse(new ToolError("forbidden", "no")))
    const approval = await approvalOf(spec, { name: 3 }, CTX)
    expect(approval).toEqual({ resources: ["*"] })
    expect(calls.gate).toBe(0)
  })

  test("an abort in the gate is rethrown", async () => {
    const controller = new AbortController()
    controller.abort()
    const abort = abortError(controller.signal)
    const { spec } = fixture(refuse(abort))
    const error = await approvalOf(spec, {}, CTX).then(
      () => undefined,
      (failure: unknown) => failure,
    )
    expect(error).toBe(abort)
  })
})

describe("checkPin with a gate", () => {
  const failure = new ToolError("not_found", "No such note.")

  test("throws the refusal before resolving anything, pin or none", async () => {
    for (const pin of [undefined, "0".repeat(64)]) {
      const { spec, calls } = fixture(refuse(failure))
      const error = await checkPin({ id: "example_note_create", ...spec }, {}, CTX, pin).then(
        () => undefined,
        (caught: unknown) => caught,
      )
      expect(error).toBe(failure)
      expect(calls).toEqual({ gate: 1, targets: 0, describe: 0 })
    }
  })

  test("a gate that returns leaves the pin check as it was", async () => {
    const { spec, calls } = fixture(() => {})
    await expect(checkPin({ id: "example_note_create", ...spec }, {}, CTX, undefined)).resolves.toBeUndefined()
    expect(calls).toEqual({ gate: 1, targets: 0, describe: 0 })
  })
})
