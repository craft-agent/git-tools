import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { PIN_PATTERN, translator, type CallDescription, type ToolContext, type ToolSpec } from "../core"
import { shownDescription } from "./description"
import { approvalOf, checkPin } from "./pin"

const CTX: ToolContext = { cwd: "/work" }
const ID = "demo_note_write"
const input = z.object({ name: z.string().default("todo") })

/** What a fixture's describer and targets answer now; a test changes it between the approval and the check. */
type State = {
  size: number
  hash: string
  area: string
  describe: "answer" | "throw" | "hang" | "bad" | "none"
}

function fixture(state: State) {
  const describeNow = (): CallDescription | Promise<CallDescription> => {
    if (state.describe === "throw") throw new Error("gone")
    if (state.describe === "hang") return new Promise<CallDescription>(() => {})
    if (state.describe === "bad") return { facts: "nope" } as unknown as CallDescription
    return {
      headline: { text: "Write {name}", values: { name: "todo" } },
      facts: [{ label: "Size", value: { text: "{bytes} bytes", values: { bytes: state.size } } }],
      pins: { hash: state.hash },
    }
  }
  return {
    id: ID,
    input,
    targets: () => [state.area],
    describe: state.describe === "none" ? undefined : describeNow,
  } as Pick<ToolSpec, "id" | "input" | "targets" | "describe">
}

const fresh = (): State => ({ size: 42, hash: "abc", area: "/work/todo.md", describe: "answer" })

/** The pin of a call as it stands, then the state changed by `change`, then the check against that pin. */
async function checkAfter(change: (state: State) => void, timeoutMs = 50) {
  const state = fresh()
  const { pin } = await approvalOf(fixture(state), {}, CTX, timeoutMs)
  change(state)
  return checkPin(fixture(state), {}, CTX, pin, timeoutMs)
}

describe("approvalOf", () => {
  test("gives the resources, the shown description and a pin", async () => {
    const approval = await approvalOf(fixture(fresh()), {}, CTX)
    expect(approval.resources).toEqual(["/work/todo.md"])
    expect(approval.description).toEqual({ headline: 'Write "todo"', facts: [{ label: "Size", value: "42 bytes" }] })
    expect(approval.pin).toMatch(PIN_PATTERN)
  })

  test("never shows the pins", async () => {
    const raw: CallDescription = { facts: [{ label: "A", value: "b" }], pins: { hash: "abc" } }
    expect(shownDescription(raw, translator({}, undefined))).toEqual({ facts: [{ label: "A", value: "b" }] })
    const approval = await approvalOf(fixture(fresh()), {}, CTX)
    expect(JSON.stringify(approval.description)).not.toContain("abc")
  })

  test("gives no pin and no description for a tool without a describer, but the resources", async () => {
    const approval = await approvalOf(fixture({ ...fresh(), describe: "none" }), {}, CTX)
    expect(approval).toEqual({ resources: ["/work/todo.md"] })
  })

  test.each<State["describe"]>(["throw", "bad", "hang"])("gives no pin when describing %s", async (mode) => {
    const approval = await approvalOf(fixture({ ...fresh(), describe: mode }), {}, CTX, 20)
    expect(approval).toEqual({ resources: ["/work/todo.md"] })
  })

  test("gives the same pin whatever the prompt language", async () => {
    const japanese = translator(
      { ja: { "Write {name}": "{name} を書く", Size: "サイズ", "{bytes} bytes": "{bytes} バイト" } },
      "ja",
    )
    const english = await approvalOf(fixture(fresh()), {}, CTX)
    const translated = await approvalOf(fixture(fresh()), {}, CTX, 50, japanese)
    expect(translated.description?.headline).toBe('"todo" を書く')
    expect(translated.pin).toBe(english.pin)
  })

  test("gives another pin for another state", async () => {
    const before = await approvalOf(fixture(fresh()), {}, CTX)
    const after = await approvalOf(fixture({ ...fresh(), hash: "abd" }), {}, CTX)
    expect(after.pin).not.toBe(before.pin)
  })
})

describe("checkPin", () => {
  test("passes when nothing changed", async () => {
    await expect(checkAfter(() => {})).resolves.toBeUndefined()
  })

  test.each<[string, (state: State) => void]>([
    ["a fact", (state) => (state.size = 43)],
    ["a hidden pin", (state) => (state.hash = "abd")],
    ["a resource", (state) => (state.area = "/work/other.md")],
    ["a describer that now throws", (state) => (state.describe = "throw")],
    ["a describer that now answers a bad shape", (state) => (state.describe = "bad")],
    ["a describer that now takes too long", (state) => (state.describe = "hang")],
    ["a tool that no longer describes", (state) => (state.describe = "none")],
  ])("throws stale for %s", async (_name, change) => {
    const error = await checkAfter(change, 20).catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      name: "ToolError",
      code: "stale",
      message: `${ID} did not run: what its approval showed changed before it could run. Call it again to be asked again.`,
    })
  })

  test("without a pin returns at once and resolves nothing", async () => {
    let called = false
    const spec = {
      ...fixture(fresh()),
      targets: () => {
        called = true
        return []
      },
      describe: () => {
        called = true
        return { facts: [] }
      },
    }
    await expect(checkPin(spec, {}, CTX, undefined)).resolves.toBeUndefined()
    expect(called).toBe(false)
  })

  test("rethrows the cancellation instead of turning it into stale", async () => {
    const state = fresh()
    const { pin } = await approvalOf(fixture(state), {}, CTX)
    const controller = new AbortController()
    const reason = new Error("stop")
    state.describe = "hang"
    const pending = checkPin(fixture(state), {}, { ...CTX, signal: controller.signal }, pin)
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
  })
})
