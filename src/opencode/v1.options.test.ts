import { describe, expect, test } from "bun:test"
import { NOTE_ID, NOTE_OPTION, noteSpec } from "../entry/options.testing"
import { PROFILE } from "./testing"
import type { PluginOptions, V1AskRequest, V1ToolContext } from "./types"
import { createV1Server } from "./v1"

async function call(options?: PluginOptions, env: Record<string, string | undefined> = {}) {
  const asks: V1AskRequest[] = []
  const context: V1ToolContext = {
    directory: "/work/project",
    worktree: "/work/project",
    abort: new AbortController().signal,
    async ask(request) {
      asks.push(request)
    },
  }
  const { tool } = await createV1Server([noteSpec], { profile: PROFILE, env })({}, options)
  const result = JSON.parse(await tool[NOTE_ID]!.execute({}, context))
  return { result, asks }
}

describe("V1 tool options", () => {
  test("options reach execution and the approval description", async () => {
    const { result, asks } = await call({ [NOTE_OPTION]: "from options" })
    expect(result).toEqual({ options: { [NOTE_OPTION]: "from options" } })
    expect(asks[0]!.metadata.message).toContain("Note: from options")
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
