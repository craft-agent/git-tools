import { describe, expect, test } from "bun:test"
import { ADD_ID, PIN_ID, PIN_STALE, PROFILE, fixtureSpecs, pinSpecs, type PinState } from "./testing"
import type { V1ToolContext } from "./types"
import { createV1Server } from "./v1"

/** Runs `id` through a V1 plugin; `answer` runs where the harness asks, and may change the state the describer reads. */
async function call(id: string, state: PinState, answer: () => void = () => {}) {
  const events: string[] = []
  const context: V1ToolContext = {
    directory: "/work/project",
    worktree: "/work/project",
    abort: new AbortController().signal,
    async ask() {
      events.push("ask")
      answer()
    },
  }
  const { tool } = await createV1Server([...fixtureSpecs(events), ...pinSpecs(events, state)], {
    env: {},
    profile: PROFILE,
  })({}, {})
  const error = await tool[id]!.execute({ area: "north" }, context).then(
    () => undefined,
    (failure: Error) => failure.message,
  )
  return { events, error }
}

describe("V1 pin", () => {
  test("runs the tool when what the prompt showed is unchanged", async () => {
    const run = await call(PIN_ID, { value: "a" })
    expect(run.events).toEqual(["ask", `execute:${PIN_ID}`])
    expect(run.error).toBeUndefined()
  })

  test("fails with stale, without running, when the described state changed while asking", async () => {
    const state = { value: "a" }
    const run = await call(PIN_ID, state, () => (state.value = "b"))
    expect(run.error).toBe(PIN_STALE)
    expect(run.events).toEqual(["ask"])
  })

  test("fails with stale when the describer fails after the prompt", async () => {
    const state: PinState = { value: "a" }
    const run = await call(PIN_ID, state, () => (state.failing = true))
    expect(run.error).toBe(PIN_STALE)
    expect(run.events).toEqual(["ask"])
  })

  test("a tool without a describer runs as before", async () => {
    const run = await call(ADD_ID, { value: "a" })
    expect(run.events).toEqual(["ask", `execute:${ADD_ID}`])
  })

  test("a describer that failed at prompt time pins nothing, so the call runs even if it recovers", async () => {
    const state: PinState = { value: "a", failing: true }
    const run = await call(PIN_ID, state, () => {
      state.failing = false
      state.value = "b"
    })
    expect(run.events).toEqual(["ask", `execute:${PIN_ID}`])
    expect(run.error).toBeUndefined()
  })
})
