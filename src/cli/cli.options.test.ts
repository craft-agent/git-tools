import { describe, expect, test } from "bun:test"
import { NOTE_ID, NOTE_OPTION, noteSpec } from "../entry/options.testing"
import { EXIT_OK, EXIT_USAGE } from "./cli"
import { cli, json } from "./testing"

describe("command-line tool options", () => {
  test("run passes flags to execution and target passes them to the description", async () => {
    const run = await cli(["run", NOTE_ID, "--cwd", "/work/project", "--note-text", "from flag"], "", {
      specs: [noteSpec],
    })
    expect(run.code).toBe(EXIT_OK)
    expect(json(run)).toEqual({ result: { options: { [NOTE_OPTION]: "from flag" } } })
    const target = await cli(["target", NOTE_ID, "--cwd", "/work/project", "--note-text", "from flag"], "", {
      specs: [noteSpec],
    })
    expect(target.code).toBe(EXIT_OK)
    expect(json(target).description.facts).toContainEqual({ label: "Note", value: "from flag" })
  })

  test("run and target use environment options, overridden by flags", async () => {
    for (const command of ["run", "target"]) {
      for (const flags of [[], ["--note-text", "override"]]) {
        const result = await cli([command, NOTE_ID, "--cwd", "/work/project", ...flags], "", {
          specs: [noteSpec],
          env: { DEMO_NOTE_TEXT: "from env" },
        })
        expect(result.code).toBe(EXIT_OK)
        const value = flags.length ? "override" : "from env"
        if (command === "run") expect(json(result).result.options).toEqual({ [NOTE_OPTION]: value })
        else expect(json(result).description.facts).toContainEqual({ label: "Note", value })
      }
    }
  })

  test("run without options gets an empty set", async () => {
    expect(json(await cli(["run", NOTE_ID, "--cwd", "/work/project"], "", { specs: [noteSpec] }))).toEqual({
      result: { options: {} },
    })
  })

  test("list accepts tool options and every command rejects unknown flags", async () => {
    expect((await cli(["list", "--note-text", "note"], "", { specs: [noteSpec] })).code).toBe(EXIT_OK)
    for (const args of [
      ["list"],
      ["run", NOTE_ID, "--cwd", "/work/project"],
      ["target", NOTE_ID, "--cwd", "/work/project"],
    ]) {
      expect((await cli([...args, "--unknown", "value"], "", { specs: [noteSpec] })).code).toBe(EXIT_USAGE)
    }
  })
})
