import { describe, expect, test } from "bun:test"
import { NOTE_ID, NOTE_OPTION, noteSpec } from "../entry/options.testing"
import { PROFILE } from "./testing"
import type { V1AskRequest, V1ToolContext } from "./types"
import { createV1Server } from "./v1"

async function run(options: Record<string, unknown>, env: Record<string, string> = {}) {
  const asks: V1AskRequest[] = []
  const context: V1ToolContext = {
    directory: "/work/project",
    worktree: "/work/project",
    abort: new AbortController().signal,
    async ask(request) {
      asks.push(request)
    },
  }
  const { tool } = await createV1Server([noteSpec], { env, profile: PROFILE })({}, options)
  const result = JSON.parse(await tool[NOTE_ID]!.execute({}, context))
  return { result, message: String(asks[0]?.metadata.message) }
}

describe("V1 tool options", () => {
  test("the approval and the run both see the plugin option", async () => {
    const { result, message } = await run({ [NOTE_OPTION]: "from option" })
    expect(result).toEqual({ options: { [NOTE_OPTION]: "from option" } })
    expect(message).toContain("Note: from option")
  })

  test("the variable stands in, and the option wins over it", async () => {
    expect((await run({}, { DEMO_NOTE_TEXT: "from env" })).result.options).toEqual({ [NOTE_OPTION]: "from env" })
    const both = await run({ [NOTE_OPTION]: "option" }, { DEMO_NOTE_TEXT: "env" })
    expect(both.result.options).toEqual({ [NOTE_OPTION]: "option" })
  })

  test("without the option the context carries none", async () => {
    const { result, message } = await run({})
    expect(result).toEqual({ options: {} })
    expect(message).toContain("Note: none")
  })
})
