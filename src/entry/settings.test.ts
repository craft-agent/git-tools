import { describe, expect, test } from "bun:test"
import { PROJECT } from "../project"
import type { EntryProfile } from "./profile"
import { parseSettings, parseToolSettings } from "./settings"
import { failure, profile } from "./settings.testing"

const parse = (argv: string[], env: Record<string, string | undefined> = {}) => parseSettings(argv, env, profile)
const parseTool = (argv: string[], env: Record<string, string | undefined> = {}) =>
  parseToolSettings(argv, env, profile)

describe("parseSettings", () => {
  test("defaults to the harness confirming and no other setting", () => {
    expect(parse([])).toEqual({ confirm: "harness" })
  })

  test("reads each flag", () => {
    expect(
      parse([
        "--toolsets",
        "alpha,beta",
        "--read-only",
        "--tools",
        "demo_thing_read",
        "--exclude-tools",
        "demo_thing_merge",
        "--confirm",
        "elicitation",
      ]),
    ).toEqual({
      toolsets: ["alpha", "beta"],
      read_only: true,
      tools: ["demo_thing_read"],
      exclude_tools: ["demo_thing_merge"],
      confirm: "elicitation",
    })
  })

  test("reads the --flag=value form", () => {
    expect(
      parse(["--toolsets=gamma", "--tools=a,b", "--exclude-tools=c", "--confirm=elicitation", "--read-only"]),
    ).toEqual({
      toolsets: ["gamma"],
      tools: ["a", "b"],
      exclude_tools: ["c"],
      read_only: true,
      confirm: "elicitation",
    })
  })

  test("falls back to the environment", () => {
    expect(
      parse([], {
        DEMO_TOOLSETS: "beta,gamma",
        DEMO_READ_ONLY: "true",
        DEMO_TOOLS: "x",
        DEMO_EXCLUDE_TOOLS: "y,z",
        DEMO_CONFIRM: "elicitation",
      }),
    ).toEqual({
      toolsets: ["beta", "gamma"],
      read_only: true,
      tools: ["x"],
      exclude_tools: ["y", "z"],
      confirm: "elicitation",
    })
  })

  test("names its environment variables after the package's prefix unless given a profile", () => {
    const variable = `${PROJECT.envPrefix}_READ_ONLY`
    expect(parseSettings([], { [variable]: "true" }).read_only).toBe(true)
    expect(parseSettings([], { DEMO_READ_ONLY: "true" }).read_only).toBeUndefined()
    expect(parse([], { [variable]: "true" }).read_only).toBeUndefined()
    expect(failure(() => parseSettings([], { [variable]: "yes" })).message).toContain(variable)
  })

  test.each([
    ["1", true],
    ["true", true],
    ["TRUE", true],
    ["0", false],
    ["False", false],
  ])("DEMO_READ_ONLY=%s is %p", (value, expected) => {
    expect(parse([], { DEMO_READ_ONLY: value }).read_only).toBe(expected)
  })

  test.each(["yes", "on", "2", "enabled"])("DEMO_READ_ONLY=%s is rejected, naming the variable", (value) => {
    const message = failure(() => parse([], { DEMO_READ_ONLY: value })).message
    expect(message).toContain("DEMO_READ_ONLY")
    expect(message).toContain(`"${value}"`)
  })

  test("a flag-given --read-only is not blocked by a bad environment variable it overrides", () => {
    expect(parse(["--read-only"], { DEMO_READ_ONLY: "yes" }).read_only).toBe(true)
  })

  test("a flag wins over its environment variable", () => {
    const env = {
      DEMO_TOOLSETS: "gamma",
      DEMO_TOOLS: "x",
      DEMO_EXCLUDE_TOOLS: "y",
      DEMO_CONFIRM: "elicitation",
      DEMO_READ_ONLY: "0",
    }
    expect(
      parse(
        ["--toolsets", "alpha", "--tools", "a", "--exclude-tools", "b", "--confirm", "harness", "--read-only"],
        env,
      ),
    ).toEqual({ toolsets: ["alpha"], tools: ["a"], exclude_tools: ["b"], confirm: "harness", read_only: true })
  })

  test("an empty environment variable counts as unset", () => {
    expect(parse([], { DEMO_TOOLSETS: "", DEMO_CONFIRM: " " })).toEqual({ confirm: "harness" })
  })

  test("drops empty list items", () => {
    const settings = parse(["--toolsets", "alpha,,beta,", "--tools", ",a, ,b"])
    expect(settings.toolsets).toEqual(["alpha", "beta"])
    expect(settings.tools).toEqual(["a", "b"])
    expect(parse(["--toolsets", ","]).toolsets).toBeUndefined()
  })

  test('"all" turns on every toolset', () => {
    expect(parse(["--toolsets", "all"]).toolsets).toBe("all")
    expect(parse([], { DEMO_TOOLSETS: "all" }).toolsets).toBe("all")
  })

  test("the last of a repeated flag wins", () => {
    expect(parse(["--confirm", "elicitation", "--confirm=harness"]).confirm).toBe("harness")
  })

  test("an unknown flag or a stray argument is rejected, naming it", () => {
    expect(failure(() => parse(["--nope"])).message).toContain("--nope")
    expect(failure(() => parse(["--nope=1"])).message).toContain("--nope=1")
    expect(failure(() => parse(["alpha"])).message).toContain("alpha")
  })

  test("a flag without a value is rejected, naming it", () => {
    expect(failure(() => parse(["--toolsets"])).message).toContain("--toolsets")
    expect(failure(() => parse(["--tools", "--read-only"])).message).toContain("--tools")
    expect(failure(() => parse(["--read-only=1"])).message).toContain("--read-only")
  })

  test("a bad confirm mode is rejected, naming it", () => {
    expect(failure(() => parse(["--confirm", "ask"])).message).toContain('"ask"')
    expect(failure(() => parse([], { DEMO_CONFIRM: "ask" })).message).toContain("DEMO_CONFIRM")
  })

  test("an unknown toolset is rejected, naming it, where it came from and the toolsets there are", () => {
    const fromFlag = failure(() => parse(["--toolsets", "alpha,bogus"])).message
    expect(fromFlag).toContain('"bogus"')
    expect(fromFlag).toContain("--toolsets")
    for (const name of profile.toolsets.names) expect(fromFlag).toContain(name)
    expect(failure(() => parse([], { DEMO_TOOLSETS: "bogus" })).message).toContain("DEMO_TOOLSETS")
  })

  test("with no toolsets defined, a named toolset is rejected and the message says so", () => {
    const none: EntryProfile = { envPrefix: "DEMO", toolsets: { names: [], defaults: [] } }
    expect(failure(() => parseSettings(["--toolsets", "alpha"], {}, none)).message).toContain("no toolsets are defined")
    expect(parseSettings(["--toolsets", "all"], {}, none).toolsets).toBe("all")
  })
})

describe("parseToolSettings", () => {
  test("reads the tool settings and gives no confirm setting", () => {
    expect(parseTool([])).toEqual({})
    expect(parseTool(["--toolsets=gamma", "--read-only", "--tools", "a"], { DEMO_EXCLUDE_TOOLS: "b" })).toEqual({
      toolsets: ["gamma"],
      read_only: true,
      tools: ["a"],
      exclude_tools: ["b"],
    })
  })

  test("rejects --confirm in both forms, naming it", () => {
    expect(failure(() => parseTool(["--confirm", "harness"])).message).toContain("--confirm")
    expect(failure(() => parseTool(["--confirm=elicitation"])).message).toContain("--confirm")
  })

  test("ignores DEMO_CONFIRM, even a bad one", () => {
    expect(parseTool([], { DEMO_CONFIRM: "ask" })).toEqual({})
  })
})
