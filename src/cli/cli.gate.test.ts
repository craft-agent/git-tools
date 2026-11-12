import { describe, expect, test } from "bun:test"
import { EXIT_FAILED, EXIT_OK } from "./cli"
import { GATED_ID, cli, gatedSpecs, json, specs } from "./testing"

const ARGS = '{"area":"north"}'
const all = [...specs, ...gatedSpecs]
const REFUSAL = { code: "forbidden", message: "Out of reach." }

describe("a call the gate refuses", () => {
  test("target answers refused alone with exit code 0", async () => {
    const run = await cli(["target", GATED_ID, "--cwd", "/x"], ARGS, { specs: all })
    expect(run.code).toBe(EXIT_OK)
    expect(run.stderr).toBe("")
    expect(json(run)).toEqual({ refused: REFUSAL })
  })

  test("run fails with the gate's code", async () => {
    const run = await cli(["run", GATED_ID, "--cwd", "/x", "--tools", GATED_ID], ARGS, { specs: all })
    expect(run.code).toBe(EXIT_FAILED)
    expect(json(run)).toEqual({ error: REFUSAL })
  })
})
