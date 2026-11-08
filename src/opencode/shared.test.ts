import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { ToolError, defineTool, type ToolContext } from "../core"
import { permissionMetadata, runTool } from "./shared"

const CTX: ToolContext = { cwd: "/work", signal: new AbortController().signal }

describe("permissionMetadata", () => {
  const spec = { title: "Title", class: "add" } as const
  const args = { area: "north" }

  test("without a description the message is the title and the targets", () => {
    expect(permissionMetadata(spec, args, ["north"])).toEqual({
      arguments: args,
      class: "add",
      message: "Title\n\n--- Details ---\n\nTarget: north",
    })
  })

  test("takes the facts and text from the description", () => {
    expect(
      permissionMetadata(spec, args, ["north"], {
        facts: [{ label: "Area", value: "north" }],
        text: { label: "Body", body: "Body<U+202E>" },
      }),
    ).toEqual({
      arguments: args,
      class: "add",
      message: "Title\n\n--- Details ---\n\nTarget: north\nArea: north\n\n--- Body ---\n\nBody<U+202E>",
    })
  })
})

/** Runs a read tool that throws `error`, and resolves to what `runTool` threw. */
async function failure(error: Error): Promise<unknown> {
  const spec = defineTool({
    id: "demo_thing_fail_read",
    title: "demo_thing_fail_read",
    description: "demo_thing_fail_read",
    toolset: "alpha",
    class: "read",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    async execute() {
      throw error
    },
  })
  return runTool(spec, {}, CTX).then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
}

describe("runTool", () => {
  test("a ToolError without details reads <code>: <message>, with the ToolError as its cause", async () => {
    const error = new ToolError("not_found", "No such thing.")
    const thrown = await failure(error)
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe("not_found: No such thing.")
    expect((thrown as Error).cause).toBe(error)
  })

  test("a ToolError with details carries them as JSON on a line of their own", async () => {
    const details = { problems: [{ field: "name", reason: "empty" }] }
    const error = new ToolError("invalid_argument", "The thing has problems.", { details })
    const thrown = await failure(error)
    const [first, second, ...rest] = (thrown as Error).message.split("\n")
    expect(first).toBe("invalid_argument: The thing has problems.")
    expect(JSON.parse(second!)).toEqual(details)
    expect(rest).toEqual([])
    expect((thrown as Error).cause).toBe(error)
  })

  test("any other error passes through as it is", async () => {
    const original = new TypeError("boom")
    expect(await failure(original)).toBe(original)
  })
})
