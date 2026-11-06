import { afterEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import { ToolError, defineTool } from "../core"
import {
  call,
  connect,
  failing,
  runCleanups,
  settings,
  textOf,
  tool,
  toolInput,
  toolOutput,
  type Call,
} from "./testing"

afterEach(runCleanups)

describe("calls", () => {
  test("a result is structuredContent and the same JSON as text", async () => {
    const calls: Call[] = []
    const { client } = await connect([tool("demo_thing_create", "alpha", "add", calls)], settings())
    const result = await call(client, "demo_thing_create", { count: 3 })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({ tool: "demo_thing_create", count: 3 })
    expect(textOf(result)).toBe(JSON.stringify(result.structuredContent))
    expect(calls.map((c) => c.args)).toEqual([{ count: 3 }])
  })

  test("a ToolError is an error result carrying its code and message", async () => {
    const { client } = await connect(
      [failing("demo_thing_missing_read", new ToolError("not_found", "No thing #9."))],
      settings(),
    )
    const result = await call(client, "demo_thing_missing_read")
    expect(result.isError).toBe(true)
    expect(JSON.parse(textOf(result))).toEqual({ error: { code: "not_found", message: "No thing #9." } })
    expect(result.structuredContent).toBeUndefined()
  })

  test("an unexpected error tells the client only to see the log, and the log gets the whole error", async () => {
    const failure = new Error("ENOENT: no such file '/Users/secret/project/.env'")
    const { client, logs } = await connect([failing("demo_thing_broken_read", failure)], settings())
    const result = await call(client, "demo_thing_broken_read")
    expect(result.isError).toBe(true)
    expect(JSON.parse(textOf(result))).toEqual({
      error: {
        code: "internal_error",
        message: "Unexpected error while running demo_thing_broken_read; see the server log.",
      },
    })
    expect(textOf(result)).not.toContain("/Users/secret")
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain("demo_thing_broken_read")
    expect(logs[0]).toContain("/Users/secret/project/.env")
    expect(logs[0]).toContain("    at ")
  })

  test("a thrown value that is not an Error is logged and hidden the same way", async () => {
    const { client, logs } = await connect(
      [
        defineTool({
          id: "demo_thing_odd_read",
          title: "t",
          description: "d",
          toolset: "alpha",
          class: "read",
          input: toolInput,
          output: toolOutput,
          async execute() {
            throw "/etc/passwd"
          },
        }),
      ],
      settings(),
    )
    const result = await call(client, "demo_thing_odd_read")
    expect(textOf(result)).not.toContain("/etc/passwd")
    expect(logs[0]).toContain("/etc/passwd")
  })

  test("an unknown tool is an invalid_argument error result", async () => {
    const calls: Call[] = []
    const { client } = await connect([tool("demo_thing_create", "alpha", "add", calls)], settings())
    const result = await call(client, "demo_nonexistent_read")
    expect(result.isError).toBe(true)
    const { error } = JSON.parse(textOf(result))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("demo_nonexistent_read")
  })

  test("a tool the settings left out is unknown", async () => {
    const calls: Call[] = []
    const { client } = await connect([tool("demo_other_read", "beta", "read", calls)], settings())
    const result = await call(client, "demo_other_read")
    expect(JSON.parse(textOf(result)).error.code).toBe("invalid_argument")
    expect(calls).toEqual([])
  })

  test("an unknown argument is invalid_argument in our shape and execute never runs", async () => {
    const calls: Call[] = []
    const { client } = await connect([tool("demo_thing_create", "alpha", "add", calls)], settings())
    const result = await call(client, "demo_thing_create", { count: 1, extra: true })
    expect(result.isError).toBe(true)
    const { error } = JSON.parse(textOf(result))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("demo_thing_create")
    expect(error.message).toContain("extra: unknown argument")
    expect(calls).toEqual([])
  })

  test("an argument of the wrong type is invalid_argument and execute never runs", async () => {
    const calls: Call[] = []
    const { client } = await connect([tool("demo_thing_create", "alpha", "add", calls)], settings())
    const result = await call(client, "demo_thing_create", { count: "x" })
    expect(result.isError).toBe(true)
    expect(JSON.parse(textOf(result)).error.code).toBe("invalid_argument")
    expect(calls).toEqual([])
  })

  test("a call without arguments runs with an empty object", async () => {
    const calls: Call[] = []
    const { client } = await connect([tool("demo_thing_create", "alpha", "add", calls)], settings())
    const result = await client.callTool({ name: "demo_thing_create" })
    expect(result.isError).toBeUndefined()
    expect(calls.map((c) => c.args)).toEqual([{}])
  })

  test("a transforming input schema is parsed once", async () => {
    const seen: unknown[] = []
    const { client } = await connect(
      [
        defineTool({
          id: "demo_thing_double_read",
          title: "t",
          description: "d",
          toolset: "alpha",
          class: "read",
          input: z.object({ n: z.string().transform((s) => Number(s) * 2) }),
          output: z.object({ n: z.number() }),
          async execute(args) {
            seen.push(args)
            return { n: args.n }
          },
        }),
      ],
      settings(),
    )
    const result = await call(client, "demo_thing_double_read", { n: "21" })
    expect(result.structuredContent).toEqual({ n: 42 })
    expect(seen).toEqual([{ n: 42 }])
  })

  test("the context carries an abort signal", async () => {
    const calls: Call[] = []
    const { client } = await connect([tool("demo_thing_create", "alpha", "add", calls)], settings())
    await call(client, "demo_thing_create")
    expect(calls[0]!.ctx.signal).toBeInstanceOf(AbortSignal)
  })
})
