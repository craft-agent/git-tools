import { describe, expect, test } from "bun:test"
import { GATED_ADD_ID, GATED_READ_ID, GATE_REFUSAL, PROFILE, gatedSpecs } from "./testing"
import type { V1ToolContext } from "./types"
import { createV1Server } from "./v1"

/** Runs `id` through a V1 plugin of the gated fixtures and reports what the harness saw. */
async function call(id: string) {
  const events: string[] = []
  const context: V1ToolContext = {
    directory: "/work/project",
    worktree: "/work/project",
    abort: new AbortController().signal,
    async ask() {
      events.push("ask")
    },
  }
  const { tool } = await createV1Server(gatedSpecs(events), { env: {}, profile: PROFILE })({}, {})
  const error = await tool[id]!.execute({ area: "north" }, context).then(
    () => undefined,
    (failure: Error) => failure.message,
  )
  return { events, error }
}

describe("V1 gate", () => {
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
