import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { ToolError, isToolError } from "./errors"
import { StepErrors, confirmWrite, defineTool, invoke, type ToolContext, type ToolSpec } from "./tool"

const input = z.object({ count: z.number().int(), label: z.string().optional() })
const output = z.object({ total: z.number() })

const CTX: ToolContext = { cwd: process.cwd() }

async function thrown(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  )
}

describe("invoke", () => {
  const tool = (execute: ToolSpec<typeof input, typeof output>["execute"]) =>
    defineTool({
      id: "demo_thing_count",
      title: "Count",
      description: "d",
      toolset: "alpha",
      class: "add",
      input,
      output,
      execute,
    })

  test("validates, executes and returns the parsed output", async () => {
    const seen: unknown[] = []
    const result = await invoke(
      tool(async (args, ctx) => {
        seen.push(args, ctx)
        return { total: args.count * 2 }
      }),
      { count: 21 },
      CTX,
    )
    expect(result).toEqual({ total: 42 })
    expect(seen).toEqual([{ count: 21 }, CTX])
  })

  test("bad arguments are invalid_argument listing path: message", async () => {
    const error = await thrown(
      invoke(
        tool(async () => ({ total: 1 })),
        { count: "x", label: 3 },
        CTX,
      ),
    )
    expect(isToolError(error) && error.code).toBe("invalid_argument")
    expect((error as Error).message).toContain("demo_thing_count")
    expect((error as Error).message).toContain("count: ")
    expect((error as Error).message).toContain("label: ")
  })

  test("arguments that are not an object are invalid_argument", async () => {
    const error = await thrown(
      invoke(
        tool(async () => ({ total: 1 })),
        null,
        CTX,
      ),
    )
    expect(isToolError(error) && error.code).toBe("invalid_argument")
  })

  test("execute does not run when the arguments are bad", async () => {
    let ran = false
    await thrown(
      invoke(
        tool(async () => {
          ran = true
          return { total: 1 }
        }),
        {},
        CTX,
      ),
    )
    expect(ran).toBe(false)
  })

  test("unknown arguments are invalid_argument naming each unknown key", async () => {
    let ran = false
    const error = await thrown(
      invoke(
        tool(async () => {
          ran = true
          return { total: 1 }
        }),
        { count: 1, extra: true, other: 2 },
        CTX,
      ),
    )
    expect(isToolError(error) && error.code).toBe("invalid_argument")
    expect((error as Error).message).toContain("extra: unknown argument")
    expect((error as Error).message).toContain("other: unknown argument")
    expect(ran).toBe(false)
  })

  test("strict parsing does not change the spec's own schema", async () => {
    const spec = tool(async () => ({ total: 1 }))
    await thrown(invoke(spec, { count: 1, extra: true }, CTX))
    expect(spec.input.safeParse({ count: 1, extra: true }).success).toBe(true)
  })

  /** A tool whose `execute` returns whatever it is given, past the type checker. */
  const returning = (result: unknown) =>
    tool((async () => result) as unknown as ToolSpec<typeof input, typeof output>["execute"])

  test("a result that breaks the output schema is an internal_error carrying the raw result", async () => {
    const bad = returning({ total: "many", created: "https://example.com/things/7" })
    const error = await thrown(invoke(bad, { count: 1 }, CTX))
    expect(isToolError(error) && error.code).toBe("internal_error")
    const message = (error as Error).message
    expect(message).toContain("demo_thing_count returned a result that does not match its output schema")
    expect(message).toContain("total")
    expect(message).toContain('"created":"https://example.com/things/7"')
  })

  test("the raw result in that message is capped", async () => {
    const error = await thrown(invoke(returning({ total: "x".repeat(10_000) }), { count: 1 }, CTX))
    expect(isToolError(error) && error.code).toBe("internal_error")
    expect((error as Error).message.length).toBeLessThan(2600)
  })

  test("a result that cannot be serialized still reports internal_error", async () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const error = await thrown(invoke(returning(circular), { count: 1 }, CTX))
    expect(isToolError(error) && error.code).toBe("internal_error")
  })

  test("a ToolError from execute passes through unchanged", async () => {
    const failure = new ToolError("not_found", "no such thing")
    const error = await thrown(
      invoke(
        tool(async () => {
          throw failure
        }),
        { count: 1 },
        CTX,
      ),
    )
    expect(error).toBe(failure)
  })

  test("other errors, including aborts, pass through unchanged", async () => {
    const plain = new Error("boom")
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" })
    for (const failure of [plain, abort]) {
      const error = await thrown(
        invoke(
          tool(async () => {
            throw failure
          }),
          { count: 1 },
          CTX,
        ),
      )
      expect(error).toBe(failure)
    }
  })
})

describe("confirmWrite", () => {
  const admin = { id: "demo_thing_delete", class: "administrative" } as const

  test("with no hook, the harness approved", async () => {
    await confirmWrite(admin, {}, "Delete the thing")
  })

  test("an accept lets the call go on, and the hook sees the tool and message", async () => {
    const requests: unknown[] = []
    await confirmWrite(
      admin,
      {
        confirm: async (request) => {
          requests.push(request)
          return true
        },
      },
      "Delete the thing",
    )
    expect(requests).toEqual([{ tool: "demo_thing_delete", message: "Delete the thing" }])
  })

  test.each([false, undefined, "yes", 1])("anything but true (%p) is declined", async (answer) => {
    const error = await thrown(confirmWrite(admin, { confirm: async () => answer as boolean }, "Delete the thing"))
    expect(isToolError(error) && error.code).toBe("declined")
    expect((error as Error).message).toContain("Delete the thing")
  })

  test("a failing hook's error passes through", async () => {
    const failure = new Error("elicitation broke")
    const error = await thrown(
      confirmWrite(
        admin,
        {
          confirm: async () => {
            throw failure
          },
        },
        "m",
      ),
    )
    expect(error).toBe(failure)
  })

  test("other classes never ask", async () => {
    let asked = false
    const confirm = async () => {
      asked = true
      return false
    }
    for (const writeClass of ["read", "add", "idempotent", "overwrite"] as const) {
      await confirmWrite({ id: "demo_thing_edit", class: writeClass }, { confirm }, "m")
    }
    expect(asked).toBe(false)
  })
})

describe("StepErrors", () => {
  test("returns a step's value and records nothing", async () => {
    const steps = new StepErrors()
    expect(await steps.record("label", async () => 5)).toBe(5)
    expect(steps.any).toBe(false)
    expect(steps.errors).toEqual({})
  })

  test("a failing step yields undefined and is recorded, with the code of a ToolError", async () => {
    const steps = new StepErrors()
    expect(
      await steps.record("label", async () => {
        throw new ToolError("forbidden", "no access")
      }),
    ).toBeUndefined()
    expect(
      await steps.record("relation", async () => {
        throw new Error("plain failure")
      }),
    ).toBeUndefined()
    expect(steps.any).toBe(true)
    expect(steps.errors).toEqual({ label: "forbidden: no access", relation: "plain failure" })
  })

  test("later steps still run after a failure", async () => {
    const steps = new StepErrors()
    await steps.record("a", async () => {
      throw new Error("x")
    })
    expect(await steps.record("b", async () => "ok")).toBe("ok")
  })

  test("an AbortError is rethrown, never recorded", async () => {
    const steps = new StepErrors()
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" })
    const error = await thrown(
      steps.record("a", async () => {
        throw abort
      }),
    )
    expect(error).toBe(abort)
    expect(steps.any).toBe(false)
  })

  test("errors returns a copy", async () => {
    const steps = new StepErrors()
    await steps.record("a", async () => {
      throw new Error("x")
    })
    steps.errors.a = "changed"
    expect(steps.errors).toEqual({ a: "x" })
  })
})
