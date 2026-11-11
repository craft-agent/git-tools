import { describe, expect, test } from "bun:test"
import type { EntryProfile } from "./profile"
import {
  forwardedVariables,
  parseSettings,
  parseToolOptions,
  parseToolSettings,
  settingsFromOptions,
  settingVariables,
} from "./settings"
import { failure, profile } from "./settings.testing"

const typedProfile: EntryProfile = {
  ...profile,
  options: { a_b: "text", enabled: "boolean", count: "number", labels: "list" },
}
const env = { DEMO_A_B: " env ", DEMO_ENABLED: "false", DEMO_COUNT: " 2.5 ", DEMO_LABELS: " x, , y," }
const envOptions = { a_b: "env", enabled: false, count: 2.5, labels: ["x", "y"] }
const flags = ["--a-b", " flag ", "--enabled", "--count=3", "--labels", " a, ,b, "]
const flagOptions = { a_b: "flag", enabled: true, count: 3, labels: ["a", "b"] }
const parse = (argv: string[], variables: Record<string, string | undefined> = {}) =>
  parseSettings(argv, variables, typedProfile)
const fromOptions = (
  options: Record<string, unknown> | undefined,
  variables: Record<string, string | undefined> = {},
) => settingsFromOptions(options, variables, typedProfile)

describe("command-line tool options", () => {
  test("reads all four kinds and passes them through the tool-settings parser", () => {
    expect(parse(flags).options).toEqual(flagOptions)
    expect(parseToolSettings(flags, {}, typedProfile).options).toEqual(flagOptions)
    expect(parse(["--a-b=value"]).options).toEqual({ a_b: "value" })
  })

  test("falls back to the environment and lets flags win", () => {
    expect(parse([], env).options).toEqual(envOptions)
    expect(parse(flags, env).options).toEqual(flagOptions)
    expect(parse(flags, { DEMO_COUNT: "bad", DEMO_ENABLED: "bad" }).options).toEqual(flagOptions)
  })

  test("blank text and empty lists are absent and suppress environment fallback", () => {
    expect(parse(["--a-b= ", "--labels=, ,"], env).options).toEqual({ enabled: false, count: 2.5 })
    expect(parse([], { DEMO_A_B: " ", DEMO_ENABLED: " ", DEMO_COUNT: "", DEMO_LABELS: ", ," }).options).toEqual({})
  })

  test.each(["0", "-12", "1.25", " 3.5 "])("parses finite number %s", (value) => {
    expect(parse([`--count=${value}`]).options.count).toBe(Number(value))
  })

  test.each(["NaN", "Infinity", "-Infinity", "oops", "", " "])("rejects number %s with its source", (value) => {
    expect(failure(() => parse([`--count=${value}`])).message).toBe(
      `Unknown number "${value}" in --count; use a finite number.`,
    )
    if (value.trim() !== "") {
      expect(failure(() => parse([], { DEMO_COUNT: value })).message).toContain("DEMO_COUNT")
    }
  })

  test.each([
    ["1", true],
    [" TRUE ", true],
    ["0", false],
    ["False", false],
  ])("parses boolean environment value %s", (value, expected) => {
    expect(parse([], { DEMO_ENABLED: value }).options.enabled).toBe(expected)
  })

  test("rejects boolean values on flags and invalid environment values", () => {
    expect(failure(() => parse(["--enabled=false"])).message).toBe("Option --enabled takes no value.")
    expect(failure(() => parse([], { DEMO_ENABLED: "yes" })).message).toContain("DEMO_ENABLED")
  })

  test("requires a value for every non-boolean flag", () => {
    for (const flag of ["--a-b", "--count", "--labels"]) {
      expect(failure(() => parse([flag])).message).toBe(`Option ${flag} needs a value.`)
    }
  })

  test("rejects package flags when no options are defined or the profile omits options", () => {
    for (const options of [{}, undefined]) {
      expect(failure(() => parseSettings(["--a-b=x"], {}, { ...profile, options })).message).toContain("--a-b=x")
    }
  })
})

describe("parseToolOptions", () => {
  test("reads all four kinds from flags or the environment, with flags winning", () => {
    expect(parseToolOptions(flags, {}, typedProfile)).toEqual(flagOptions)
    expect(parseToolOptions([], env, typedProfile)).toEqual(envOptions)
    expect(parseToolOptions(flags, env, typedProfile)).toEqual(flagOptions)
    expect(parseToolOptions([], {}, typedProfile)).toEqual({})
    expect(parseToolOptions([], {})).toEqual({})
  })

  test.each(["--toolsets=alpha", "--confirm=harness", "--read-only", "--tools=a", "--exclude-tools=a", "--nope"])(
    "rejects the non-tool-option flag %s",
    (flag) => {
      expect(failure(() => parseToolOptions([flag], {}, typedProfile)).message).toContain(flag.split("=")[0]!)
    },
  )
})

describe("plugin tool options", () => {
  test("reads all four typed values and trims text and list items", () => {
    expect(fromOptions({ a_b: " flag ", enabled: true, count: 3, labels: [" a ", "", " ", "b"] }).options).toEqual(
      flagOptions,
    )
    expect(fromOptions({ enabled: false, count: 0 }).options).toEqual({ enabled: false, count: 0 })
  })

  test("falls back to the environment, including explicitly undefined options", () => {
    expect(fromOptions(undefined, env).options).toEqual(envOptions)
    expect(
      fromOptions({ a_b: undefined, enabled: undefined, count: undefined, labels: undefined }, env).options,
    ).toEqual(envOptions)
  })

  test("options win even over invalid environment values", () => {
    expect(fromOptions(flagOptions, env).options).toEqual(flagOptions)
    expect(fromOptions(flagOptions, { DEMO_COUNT: "bad", DEMO_ENABLED: "bad" }).options).toEqual(flagOptions)
  })

  test("blank text and empty lists suppress environment fallback", () => {
    for (const labels of [[], ["", " "]]) {
      expect(fromOptions({ a_b: " ", labels }, env).options).toEqual({ enabled: false, count: 2.5 })
    }
    expect(fromOptions({}, { DEMO_A_B: " ", DEMO_ENABLED: "", DEMO_COUNT: " ", DEMO_LABELS: ", ," }).options).toEqual(
      {},
    )
  })

  test.each([
    ["a_b", 1, "text"],
    ["a_b", null, "text"],
    ["enabled", "true", "true or false"],
    ["enabled", 1, "true or false"],
    ["count", "1", "a finite number"],
    ["count", Number.NaN, "a finite number"],
    ["count", Number.POSITIVE_INFINITY, "a finite number"],
    ["count", Number.NEGATIVE_INFINITY, "a finite number"],
    ["labels", "a,b", "a list of strings"],
    ["labels", [1], "a list of strings"],
    ["labels", null, "a list of strings"],
  ])("rejects %s=%p with the expected type", (name, value, expected) => {
    expect(failure(() => fromOptions({ [name]: value })).message).toBe(`Option "${name}" must be ${expected}.`)
  })

  test("rejects invalid fallback values, naming their variables", () => {
    expect(failure(() => fromOptions({}, { DEMO_ENABLED: "yes" })).message).toContain("DEMO_ENABLED")
    expect(failure(() => fromOptions({}, { DEMO_COUNT: "NaN" })).message).toContain("DEMO_COUNT")
  })

  test("lists the package's options in unknown-option errors", () => {
    const message = failure(() => fromOptions({ nope: 1 })).message
    expect(message).toContain('Unknown option "nope"')
    for (const name of Object.keys(typedProfile.options!)) expect(message).toContain(name)
  })
})

describe("tool option variables", () => {
  test("lists package option variables after standard settings and before tool variables", () => {
    const variables = ["DEMO_A_B", "DEMO_ENABLED", "DEMO_COUNT", "DEMO_LABELS"]
    expect(settingVariables(typedProfile)).toEqual([...settingVariables({ ...profile, options: {} }), ...variables])
    expect(forwardedVariables(typedProfile, ["XDG_STATE_HOME"])).toEqual([
      ...settingVariables(typedProfile),
      "XDG_STATE_HOME",
    ])
  })
})
