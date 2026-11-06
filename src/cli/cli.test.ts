import { describe, expect, test } from "bun:test"
import { annotations, selectTools } from "../core"
import { PROJECT } from "../project"
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type CliIo } from "./cli"
import { ADD_ID, ADMIN_ID, BROKEN_ID, MISSING_ID, PROFILE, READ_ID, SLOW_ID, cli, json, specs } from "./testing"

describe("list", () => {
  test("describes the tools the settings select, in order", async () => {
    const run = await cli(["list"])
    expect(run.code).toBe(EXIT_OK)
    expect(run.stderr).toBe("")
    const listed = json(run)
    expect(listed.map((entry: { id: string }) => entry.id)).toEqual(
      selectTools(specs, {}, PROFILE.toolsets).map((spec) => spec.id),
    )
    expect(listed[0]).toEqual({
      id: READ_ID,
      title: `Title of ${READ_ID}`,
      description: `Description of ${READ_ID}`,
      toolset: "alpha",
      class: "read",
      annotations: annotations(specs[0]!),
      input_schema: expect.objectContaining({
        type: "object",
        additionalProperties: false,
        properties: expect.objectContaining({ area: expect.objectContaining({ description: expect.any(String) }) }),
      }),
      output_schema: expect.objectContaining({ type: "object" }),
    })
  })

  test("follows the settings flags", async () => {
    const ids = async (...flags: string[]) =>
      json(await cli(["list", ...flags])).map((entry: { id: string }) => entry.id)
    expect(await ids("--toolsets", "all")).toContain(ADMIN_ID)
    expect(await ids("--toolsets=beta")).toEqual([ADMIN_ID])
    expect(await ids("--toolsets", "all", "--read-only")).toEqual([READ_ID])
    expect(await ids("--tools", ADMIN_ID, "--exclude-tools", READ_ID)).toEqual([
      ADD_ID,
      ADMIN_ID,
      MISSING_ID,
      BROKEN_ID,
      SLOW_ID,
    ])
    expect(await ids("--exclude-tools", `${READ_ID},${ADD_ID}`)).toEqual([MISSING_ID, BROKEN_ID, SLOW_ID])
  })

  test("reads the environment behind the flags", async () => {
    const run = await cli(["list"], "", { env: { DEMO_TOOLSETS: "beta" } })
    expect(json(run).map((entry: { id: string }) => entry.id)).toEqual([ADMIN_ID])
  })

  test("lists nothing as an empty array", async () => {
    expect(json(await cli(["list", "--toolsets", "beta", "--exclude-tools", ADMIN_ID]))).toEqual([])
    expect(json(await cli(["list"], "", { specs: [] }))).toEqual([])
  })

  test("knows the package's own toolsets and variables unless given a profile", async () => {
    const own: Partial<CliIo> = { profile: undefined, specs: [] }
    expect(json(await cli(["list", "--toolsets", "all"], "", own))).toEqual([])
    const variable = `${PROJECT.envPrefix}_READ_ONLY`
    const badVariable = await cli(["list"], "", { ...own, env: { [variable]: "yes" } })
    expect(badVariable.code).toBe(EXIT_USAGE)
    expect(badVariable.stderr).toContain(variable)
    expect((await cli(["list", "--toolsets", "unknown-toolset"], "", own)).code).toBe(EXIT_USAGE)
  })
})

describe("run", () => {
  test("passes the arguments from stdin and the directory, and answers with the result", async () => {
    const run = await cli(["run", ADD_ID, "--cwd", "/work/tree"], JSON.stringify({ count: 3 }))
    expect(run).toEqual({
      code: EXIT_OK,
      stdout: `${JSON.stringify({ result: { tool: ADD_ID, cwd: "/work/tree", count: 3 } })}\n`,
      stderr: "",
    })
  })

  test("hands the install directory to the tool", async () => {
    const run = await cli(["run", ADD_ID, "--cwd", "/work/tree"], "", { ownDir: "/opt/install" })
    expect(json(run).result).toEqual({ tool: ADD_ID, cwd: "/work/tree", own_dir: "/opt/install" })
  })

  test("takes --cwd after the settings flags and in its --cwd=dir form", async () => {
    const run = await cli(["run", ADMIN_ID, "--toolsets", "all", "--cwd=/x"])
    expect(json(run)).toEqual({ result: { tool: ADMIN_ID, cwd: "/x" } })
  })

  test("empty stdin is an empty object", async () => {
    expect(json(await cli(["run", READ_ID, "--cwd", "/x"], "  \n")).result.tool).toBe(READ_ID)
  })

  test("maps a tool failure to its code and message", async () => {
    const run = await cli(["run", MISSING_ID, "--cwd", "/x"])
    expect(run.code).toBe(EXIT_FAILED)
    expect(json(run)).toEqual({ error: { code: "not_found", message: "No such thing." } })
  })

  test("rejects arguments the schema does not accept", async () => {
    const run = await cli(["run", READ_ID, "--cwd", "/x"], JSON.stringify({ bogus: 1 }))
    expect(run.code).toBe(EXIT_FAILED)
    expect(json(run).error.code).toBe("invalid_argument")
    expect(json(run).error.message).toContain("bogus")
  })

  test("rejects stdin that is not JSON", async () => {
    const run = await cli(["run", READ_ID, "--cwd", "/x"], "{nope")
    expect(run.code).toBe(EXIT_FAILED)
    expect(json(run).error.code).toBe("invalid_argument")
  })

  test("an unknown tool, and one the settings leave out, are invalid_argument", async () => {
    for (const argv of [
      ["run", "demo_nonexistent_read", "--cwd", "/x"],
      ["run", ADMIN_ID, "--cwd", "/x"],
      ["run", ADD_ID, "--cwd", "/x", "--read-only"],
    ]) {
      const run = await cli(argv)
      expect(run.code).toBe(EXIT_FAILED)
      expect(json(run).error.code).toBe("invalid_argument")
      expect(json(run).error.message).toContain(argv[1]!)
    }
  })

  test("an unexpected error is generic on stdout and detailed on stderr", async () => {
    const run = await cli(["run", BROKEN_ID, "--cwd", "/x"])
    expect(run.code).toBe(EXIT_FAILED)
    expect(json(run).error.code).toBe("internal_error")
    expect(json(run).error.message).not.toContain("boom")
    expect(run.stderr).toContain("boom")
    expect(run.stderr).toStartWith(`${PROJECT.cli}: `)
  })

  test("stops a running tool when the signal aborts", async () => {
    const controller = new AbortController()
    const pending = cli(["run", SLOW_ID, "--cwd", "/x"], "", { signal: controller.signal })
    controller.abort()
    const run = await pending
    expect(run.code).toBe(EXIT_FAILED)
    expect(json(run).error.code).toBe("internal_error")
    expect(json(run).error.message).toContain("cancelled")
  })
})

describe("usage", () => {
  test.each([
    [[], "No command given"],
    [["bogus"], 'Unknown command "bogus"'],
    [["list", "--confirm", "harness"], "--confirm"],
    [["list", "--confirm=elicitation"], "--confirm"],
    [["list", "--nope"], "--nope"],
    [["list", "--toolsets", "bogus"], "bogus"],
    [["list", "--tools", "demo_nonexistent_read"], "demo_nonexistent_read"],
    [["list", ADD_ID], ADD_ID],
    [["run"], "needs a tool id"],
    [["run", "--cwd", "/x"], "needs a tool id"],
    [["run", ADD_ID], "--cwd"],
    [["run", ADD_ID, "--cwd"], "--cwd"],
    [["run", ADD_ID, "--cwd", "--read-only"], "--cwd"],
    [["run", ADD_ID, "--cwd="], "--cwd"],
    [["run", ADD_ID, "--cwd", "/x", "--confirm", "harness"], "--confirm"],
    [["target", ADD_ID], "--cwd"],
    [["target", ADD_ID, "--cwd", "/x", "--read-only"], "--read-only"],
  ])("%j is one line on stderr, exit 2 and nothing on stdout", async (argv, message) => {
    const run = await cli(argv as string[])
    expect(run.code).toBe(EXIT_USAGE)
    expect(run.stdout).toBe("")
    expect(run.stderr.trimEnd().split("\n")).toHaveLength(1)
    expect(run.stderr).toContain(message)
    expect(run.stderr).toStartWith(`${PROJECT.cli}: `)
  })

  test("ignores DEMO_CONFIRM", async () => {
    expect((await cli(["list"], "", { env: { DEMO_CONFIRM: "ask" } })).code).toBe(EXIT_OK)
  })
})
