import { describe, expect, test } from "bun:test"
import { NOTE_ID, NOTE_OPTION, noteSpec } from "../entry/options.testing"
import { PROFILE } from "./testing"
import type { V2Context, V2PermissionRequest, V2Tool } from "./types"
import { createV2Setup } from "./v2"

async function run(options: Record<string, unknown>, env: Record<string, string> = {}) {
  const asserts: V2PermissionRequest[] = []
  const tools = new Map<string, V2Tool>()
  const ctx: V2Context = {
    options,
    session: { get: async () => ({ location: { directory: "/work/project" } }) },
    permission: {
      async assert(input) {
        asserts.push(input)
      },
    },
    tool: { transform: async (callback) => callback({ add: (tool) => tools.set(tool.name, tool) }) },
    skill: { transform: async () => {} },
  }
  await createV2Setup([noteSpec], { env, profile: PROFILE })(ctx)
  const result = await tools.get(NOTE_ID)!.execute({}, { sessionID: "ses_1", signal: new AbortController().signal })
  return { result: result.output, message: String(asserts[0]?.metadata?.message) }
}

describe("V2 tool options", () => {
  test("the approval and the run both see the plugin option", async () => {
    const { result, message } = await run({ [NOTE_OPTION]: "from option" })
    expect(result).toEqual({ options: { [NOTE_OPTION]: "from option" } })
    expect(message).toContain("Note: from option")
  })

  test("the variable stands in, and the option wins over it", async () => {
    expect((await run({}, { DEMO_NOTE_TEXT: "from env" })).result).toEqual({
      options: { [NOTE_OPTION]: "from env" },
    })
    const both = await run({ [NOTE_OPTION]: "option" }, { DEMO_NOTE_TEXT: "env" })
    expect(both.result).toEqual({ options: { [NOTE_OPTION]: "option" } })
  })

  test("without the option the context carries none", async () => {
    const { result, message } = await run({})
    expect(result).toEqual({ options: {} })
    expect(message).toContain("Note: none")
  })
})
