import { describe, expect, test } from "bun:test"
import { GATED_ADD_ID, GATED_READ_ID, GATE_REFUSAL, PROFILE, gatedSpecs } from "./testing"
import type { V2Context, V2Tool } from "./types"
import { createV2Setup } from "./v2"

/** Runs `id` through a V2 plugin of the gated fixtures and reports what the harness saw. */
async function call(id: string) {
  const events: string[] = []
  const tools = new Map<string, V2Tool>()
  const ctx: V2Context = {
    options: {},
    session: { get: async () => ({ location: { directory: "/work/project" } }) },
    permission: {
      async assert() {
        events.push("assert")
      },
    },
    tool: { transform: async (callback) => callback({ add: (tool) => tools.set(tool.name, tool) }) },
    skill: { transform: async () => {} },
  }
  await createV2Setup(gatedSpecs(events), { env: {}, profile: PROFILE })(ctx)
  const error = await tools
    .get(id)!
    .execute({ area: "north" }, { sessionID: "ses_1", signal: new AbortController().signal })
    .then(
      () => undefined,
      (failure: Error) => failure.message,
    )
  return { events, error }
}

describe("V2 gate", () => {
  test("a refused write call fails with the gate's error and never asks", async () => {
    const run = await call(GATED_ADD_ID)
    expect(run.error).toBe(GATE_REFUSAL)
    expect(run.events).toEqual([])
  })

  test("a refused read call fails with the same error and never asks", async () => {
    const run = await call(GATED_READ_ID)
    expect(run.error).toBe(GATE_REFUSAL)
    expect(run.events).toEqual([])
  })
})
