import { describe, expect, test } from "bun:test"
import { NOTE_ID, NOTE_OPTION, noteSpec } from "../entry/options.testing"
import { PROFILE } from "./testing"
import type { PluginOptions, V2Context, V2PermissionRequest, V2Tool } from "./types"
import { createV2Setup } from "./v2"

async function call(options?: PluginOptions, env: Record<string, string | undefined> = {}) {
  const tools = new Map<string, V2Tool>()
  const asserts: V2PermissionRequest[] = []
  const ctx: V2Context = {
    options,
    session: { get: async () => ({ location: { directory: "/work/project" } }) },
    permission: {
      async assert(request) {
        asserts.push(request)
      },
    },
    tool: { transform: async (callback) => callback({ add: (tool) => tools.set(tool.name, tool) }) },
    skill: { transform: async () => {} },
  }
  await createV2Setup([noteSpec], { profile: PROFILE, env })(ctx)
  const result = await tools.get(NOTE_ID)!.execute({}, { sessionID: "ses_1", signal: new AbortController().signal })
  return { result: result.output, asserts }
}

describe("V2 tool options", () => {
  test("options reach execution and the approval description", async () => {
    const { result, asserts } = await call({ [NOTE_OPTION]: "from options" })
    expect(result).toEqual({ options: { [NOTE_OPTION]: "from options" } })
    expect(asserts[0]!.metadata!.message).toContain("Note: from options")
  })

  test("the environment supplies options and plugin options win", async () => {
    expect((await call(undefined, { DEMO_NOTE_TEXT: "from env" })).result).toEqual({
      options: { [NOTE_OPTION]: "from env" },
    })
    expect((await call({ [NOTE_OPTION]: "override" }, { DEMO_NOTE_TEXT: "from env" })).result).toEqual({
      options: { [NOTE_OPTION]: "override" },
    })
  })

  test("absent options give an empty set", async () => {
    expect((await call()).result).toEqual({ options: {} })
  })
})
