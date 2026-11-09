import { describe, expect, test } from "bun:test"
import { ADD_ID, PIN_ID, PIN_STALE, PROFILE, fixtureSpecs, pinSpecs, type PinState } from "./testing"
import type { V2Context, V2Tool } from "./types"
import { createV2Setup } from "./v2"

/** Runs `id` through a V2 plugin; `answer` runs where the harness asks, and may change the state the describer reads. */
async function call(id: string, state: PinState, answer: () => void = () => {}) {
  const events: string[] = []
  const tools = new Map<string, V2Tool>()
  const ctx: V2Context = {
    options: {},
    session: { get: async () => ({ location: { directory: "/work/project" } }) },
    permission: {
      async assert() {
        events.push("assert")
        answer()
      },
    },
    tool: { transform: async (callback) => callback({ add: (tool) => tools.set(tool.name, tool) }) },
    skill: { transform: async () => {} },
  }
  await createV2Setup([...fixtureSpecs(events), ...pinSpecs(events, state)], { env: {}, profile: PROFILE })(ctx)
  const error = await tools
    .get(id)!
    .execute({ area: "north" }, { sessionID: "ses_1", signal: new AbortController().signal })
    .then(
      () => undefined,
      (failure: Error) => failure.message,
    )
  return { events, error }
}

describe("V2 pin", () => {
  test("runs the tool when what the prompt showed is unchanged", async () => {
    const run = await call(PIN_ID, { value: "a" })
    expect(run.events).toEqual(["assert", `execute:${PIN_ID}`])
    expect(run.error).toBeUndefined()
  })

  test("fails with stale, without running, when the described state changed while asking", async () => {
    const state = { value: "a" }
    const run = await call(PIN_ID, state, () => (state.value = "b"))
    expect(run.error).toBe(PIN_STALE)
    expect(run.events).toEqual(["assert"])
  })

  test("fails with stale when the describer fails after the prompt", async () => {
    const state: PinState = { value: "a" }
    const run = await call(PIN_ID, state, () => (state.failing = true))
    expect(run.error).toBe(PIN_STALE)
    expect(run.events).toEqual(["assert"])
  })

  test("a tool without a describer runs as before", async () => {
    const run = await call(ADD_ID, { value: "a" })
    expect(run.events).toEqual(["assert", `execute:${ADD_ID}`])
  })

  test("a describer that failed at prompt time pins nothing, so the call runs even if it recovers", async () => {
    const state: PinState = { value: "a", failing: true }
    const run = await call(PIN_ID, state, () => {
      state.failing = false
      state.value = "b"
    })
    expect(run.events).toEqual(["assert", `execute:${PIN_ID}`])
    expect(run.error).toBeUndefined()
  })
})
