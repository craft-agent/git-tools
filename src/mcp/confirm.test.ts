import { afterEach, describe, expect, test } from "bun:test"
import type { ElicitResult } from "@modelcontextprotocol/sdk/types.js"
import type { EntrySettings } from "../entry/settings"
import { call, connect, runCleanups, settings, textOf, tool, type Call, type ClientSetup } from "./testing"

afterEach(runCleanups)

describe("confirmation", () => {
  const form = { elicitation: { form: {} } }

  async function setup(entry: EntrySettings, client: ClientSetup) {
    const calls: Call[] = []
    const connected = await connect([tool("demo_other_delete", "beta", "administrative", calls)], entry, client)
    return { ...connected, calls }
  }
  const elicitation = settings({ confirm: "elicitation", toolsets: ["beta"] })

  test("elicitation mode asks through a form, and an accept runs the tool", async () => {
    const { client, calls, elicited } = await setup(elicitation, {
      capabilities: form,
      answer: { action: "accept", content: { confirm: true } },
    })
    const result = await call(client, "demo_other_delete")
    expect(result.isError).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(elicited).toEqual([
      {
        mode: "form",
        message: "Delete the thing",
        requestedSchema: {
          type: "object",
          properties: { confirm: { type: "boolean", title: "Confirm" } },
          required: ["confirm"],
        },
      },
    ])
    expect(calls[0]!.ctx.confirm).toBeFunction()
  })

  test("a client that advertises a bare elicitation capability gets the form too", async () => {
    const { client, calls } = await setup(elicitation, {
      capabilities: { elicitation: {} },
      answer: { action: "accept", content: { confirm: true } },
    })
    expect((await call(client, "demo_other_delete")).isError).toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  test.each<[string, ElicitResult]>([
    ["a decline", { action: "decline" }],
    ["a cancel", { action: "cancel" }],
    ["an unchecked box", { action: "accept", content: { confirm: false } }],
  ])("%s is declined and the tool does not act", async (_name, answer) => {
    const { client, calls } = await setup(elicitation, { capabilities: form, answer })
    const result = await call(client, "demo_other_delete")
    expect(result.isError).toBe(true)
    expect(JSON.parse(textOf(result)).error.code).toBe("declined")
    expect(calls).toEqual([])
  })

  test("a form the client cannot answer is declined, not a failure of the server", async () => {
    const { client, calls, logs } = await setup(elicitation, { capabilities: form, failElicitation: true })
    const result = await call(client, "demo_other_delete")
    expect(result.isError).toBe(true)
    expect(JSON.parse(textOf(result)).error.code).toBe("declined")
    expect(calls).toEqual([])
    expect(logs).toEqual([])
  })

  test("harness mode never asks and gives the tool no hook", async () => {
    const { client, calls, elicited } = await setup(settings({ toolsets: ["beta"] }), {
      capabilities: form,
      answer: { action: "decline" },
    })
    expect((await call(client, "demo_other_delete")).isError).toBeUndefined()
    expect(elicited).toEqual([])
    expect(calls[0]!.ctx.confirm).toBeUndefined()
  })

  test("a client without elicitation in elicitation mode runs without asking", async () => {
    const { client, calls } = await setup(elicitation, {})
    expect((await call(client, "demo_other_delete")).isError).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.ctx.confirm).toBeUndefined()
  })

  test("a client that offers only URL elicitation is not asked through a form", async () => {
    const { client, calls } = await setup(elicitation, { capabilities: { elicitation: { url: {} } } })
    expect((await call(client, "demo_other_delete")).isError).toBeUndefined()
    expect(calls[0]!.ctx.confirm).toBeUndefined()
  })

  test("a tool that is not administrative is never asked about", async () => {
    const calls: Call[] = []
    const { client, elicited } = await connect(
      [tool("demo_thing_edit", "alpha", "overwrite", calls)],
      settings({ confirm: "elicitation" }),
      { capabilities: form, answer: { action: "decline" } },
    )
    expect((await call(client, "demo_thing_edit")).isError).toBeUndefined()
    expect(elicited).toEqual([])
  })
})
