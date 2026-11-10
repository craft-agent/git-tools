import { describe, expect, test } from "bun:test"
import { NOTE_ID, NOTE_OPTION, noteSpec } from "../entry/options.testing"
import { EXIT_OK, EXIT_USAGE } from "./cli"
import { cli, json } from "./testing"

const FLAG = "--note-text"
const specs = { specs: [noteSpec] }

describe("run with tool options", () => {
  const run = (flags: string[], env: Record<string, string> = {}) =>
    cli(["run", NOTE_ID, "--cwd", "/x", ...flags], "{}", { ...specs, env })

  test("the tool's context carries the flag's value", async () => {
    const result = await run([FLAG, "from flag"])
    expect(result.code).toBe(EXIT_OK)
    expect(json(result)).toEqual({ result: { options: { [NOTE_OPTION]: "from flag" } } })
  })

  test("the variable stands in, and the flag wins over it", async () => {
    expect(json(await run([], { DEMO_NOTE_TEXT: "from env" })).result.options).toEqual({ [NOTE_OPTION]: "from env" })
    expect(json(await run([FLAG, "flag"], { DEMO_NOTE_TEXT: "env" })).result.options).toEqual({ [NOTE_OPTION]: "flag" })
  })

  test("without the option the context carries none", async () => {
    expect(json(await run([])).result.options).toEqual({})
  })
})

describe("target with tool options", () => {
  const target = (flags: string[], env: Record<string, string> = {}) =>
    cli(["target", NOTE_ID, "--cwd", "/x", ...flags], "{}", { ...specs, env })

  test("describe reads the flag's value, beside the language flags", async () => {
    const result = await target([FLAG, "from flag", "--language", "ja"])
    expect(result.code).toBe(EXIT_OK)
    expect(json(result).description.facts).toEqual([{ label: "Note", value: "from flag" }])
  })

  test("describe reads the variable when no flag is given", async () => {
    expect(json(await target([], { DEMO_NOTE_TEXT: "from env" })).description.facts).toEqual([
      { label: "Note", value: "from env" },
    ])
    expect(json(await target([])).description.facts).toEqual([{ label: "Note", value: "none" }])
  })

  test("another setting's flag is still an unknown option", async () => {
    const result = await target(["--toolsets", "alpha"])
    expect(result.code).toBe(EXIT_USAGE)
    expect(result.stderr).toContain("--toolsets")
  })
})

describe("list with tool options", () => {
  test("takes the flag", async () => {
    const result = await cli(["list", FLAG, "a"], "", specs)
    expect(result.code).toBe(EXIT_OK)
    expect(json(result).map((tool: { id: string }) => tool.id)).toEqual([NOTE_ID])
  })
})
