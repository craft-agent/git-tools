import { beforeEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import { PIN_PATTERN, defineTool, type ToolSpec } from "../core"
import { PROJECT } from "../project"
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "./cli"
import { ADD_ID, DESCRIBED_ID, TRANSLATIONS, cli, json, specs } from "./testing"

const STAMP_ID = "demo_thing_stamp"
const OTHER_PIN = "0".repeat(64)

/** What the stamp fixture describes now, and how often it ran. */
const state = { value: "a", runs: 0 }

const stamp: ToolSpec = defineTool({
  id: STAMP_ID,
  title: STAMP_ID,
  description: STAMP_ID,
  toolset: "alpha",
  class: "add",
  input: z.object({}),
  output: z.object({ runs: z.number() }),
  targets: () => ["north"],
  describe: () => ({ facts: [{ label: "Value", value: state.value }] }),
  async execute() {
    return { runs: ++state.runs }
  },
})

beforeEach(() => {
  state.value = "a"
  state.runs = 0
})

/** The command line over the fixture specs and the stamp fixture. */
const run = (argv: string[], stdin = "") => cli(argv, stdin, { specs: [...specs, stamp] })

/** `target` for the stamp fixture, then `change`, then `run` with the pin it gave and `extra` flags. */
async function targetThenRun(change: () => void, extra: string[] = []) {
  const pin = json(await run(["target", STAMP_ID, "--cwd", "/x"])).pin as string
  change()
  return run(["run", STAMP_ID, "--cwd", "/x", "--pin", pin, ...extra])
}

describe("target pin", () => {
  test("gives a pin of 64 hex digits for a described call", async () => {
    const answer = json(await run(["target", STAMP_ID, "--cwd", "/x"]))
    expect(answer.pin).toMatch(PIN_PATTERN)
  })

  test("gives none for a tool without a describer", async () => {
    const answer = json(await run(["target", ADD_ID, "--cwd", "/x"], '{"area":"north"}'))
    expect("pin" in answer).toBe(false)
  })

  test("gives the same pin in another language, and another pin for another state", async () => {
    const argv = ["target", DESCRIBED_ID, "--cwd", "/x"]
    const english = json(await cli(argv, '{"area":"north"}', { translations: TRANSLATIONS }))
    const japanese = json(await cli([...argv, "--language", "ja"], '{"area":"north"}', { translations: TRANSLATIONS }))
    const south = json(await cli(argv, '{"area":"south"}', { translations: TRANSLATIONS }))
    expect(japanese.pin).toBe(english.pin)
    expect(south.pin).not.toBe(english.pin)
  })
})

describe("run --pin", () => {
  test("runs the call when what the pin covered is unchanged", async () => {
    const result = await targetThenRun(() => {})
    expect(result).toEqual({ code: EXIT_OK, stdout: '{"result":{"runs":1}}\n', stderr: "" })
  })

  test("takes the --pin=<hex> form", async () => {
    const pin = json(await run(["target", STAMP_ID, "--cwd", "/x"])).pin as string
    const result = await run(["run", STAMP_ID, "--cwd", "/x", `--pin=${pin}`])
    expect(result.code).toBe(EXIT_OK)
  })

  test("writes stale and does not run when the described state changed", async () => {
    const result = await targetThenRun(() => (state.value = "b"))
    expect(result.code).toBe(EXIT_FAILED)
    expect(result.stderr).toBe("")
    expect(json(result).error.code).toBe("stale")
    expect(state.runs).toBe(0)
  })

  test("writes stale for a pin of another call", async () => {
    const result = await run(["run", STAMP_ID, "--cwd", "/x", "--pin", OTHER_PIN])
    expect(result.code).toBe(EXIT_FAILED)
    expect(json(result).error.code).toBe("stale")
    expect(state.runs).toBe(0)
  })

  test("writes stale for a pin on a tool that does not describe", async () => {
    const result = await cli(["run", ADD_ID, "--cwd", "/x", "--pin", OTHER_PIN], '{"area":"north"}')
    expect(result.code).toBe(EXIT_FAILED)
    expect(json(result).error.code).toBe("stale")
  })

  test("takes the pin before the selection flags", async () => {
    const result = await targetThenRun(() => {}, ["--tools", ADD_ID])
    expect(result.code).toBe(EXIT_OK)
  })

  test.each([["abc"], ["A".repeat(64)], ["g".repeat(64)], [OTHER_PIN + "0"]])("rejects the pin %j", async (pin) => {
    for (const flags of [["--pin", pin], [`--pin=${pin}`]]) {
      const result = await run(["run", STAMP_ID, "--cwd", "/x", ...flags])
      expect(result.code).toBe(EXIT_USAGE)
      expect(result.stdout).toBe("")
      expect(result.stderr).toStartWith(`${PROJECT.cli}: Option --pin needs`)
    }
    expect(state.runs).toBe(0)
  })

  test("rejects --pin without a value", async () => {
    for (const flags of [["--pin"], ["--pin="]]) {
      const result = await run(["run", STAMP_ID, "--cwd", "/x", ...flags])
      expect(result).toEqual({ code: EXIT_USAGE, stdout: "", stderr: `${PROJECT.cli}: Option --pin needs a value.\n` })
    }
  })

  test("without --pin runs as before, even after the state changed", async () => {
    state.value = "b"
    const result = await run(["run", STAMP_ID, "--cwd", "/x"])
    expect(result.code).toBe(EXIT_OK)
    expect(json(result)).toEqual({ result: { runs: 1 } })
  })

  test("target does not take --pin", async () => {
    const result = await run(["target", STAMP_ID, "--cwd", "/x", "--pin", OTHER_PIN])
    expect(result.code).toBe(EXIT_USAGE)
    expect(result.stderr).toContain('Unknown option "--pin".')
  })
})
