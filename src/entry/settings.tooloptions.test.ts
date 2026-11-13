import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"
import type { EntryProfile } from "./profile"
import {
  forwardedVariables,
  parseSettings,
  parseTargetSettings,
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

describe("parseTargetSettings", () => {
  test("reads all four kinds from flags or the environment, with flags winning", () => {
    expect(parseTargetSettings(flags, {}, typedProfile).options).toEqual(flagOptions)
    expect(parseTargetSettings([], env, typedProfile).options).toEqual(envOptions)
    expect(parseTargetSettings(flags, env, typedProfile).options).toEqual(flagOptions)
    expect(parseTargetSettings([], {}, typedProfile).options).toEqual({})
    expect(parseTargetSettings([], {}).options).toEqual({})
  })

  test.each(["--toolsets=alpha", "--confirm=harness", "--read-only", "--tools=a", "--exclude-tools=a", "--nope"])(
    "rejects the non-tool-option flag %s",
    (flag) => {
      expect(failure(() => parseTargetSettings([flag], {}, typedProfile)).message).toContain(flag.split("=")[0]!)
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

describe("path tool options", () => {
  const pathProfile: EntryProfile = { ...profile, options: { notes_dir: "path", extra_dirs: "paths" } }
  const home = "/home/demo"
  const read = (argv: string[], variables: Record<string, string | undefined> = {}) =>
    parseSettings(argv, { HOME: home, ...variables }, pathProfile).options
  const readOption = (value: unknown, variables: Record<string, string | undefined> = {}) =>
    settingsFromOptions({ notes_dir: value }, { HOME: home, ...variables }, pathProfile).options

  test("reads an absolute path from a flag, the = form, a variable and a plugin option", () => {
    const expected = { notes_dir: "/srv/notes" }
    expect(read(["--notes-dir", " /srv/notes "])).toEqual(expected)
    expect(read(["--notes-dir=/srv/notes"])).toEqual(expected)
    expect(read([], { DEMO_NOTES_DIR: " /srv/notes " })).toEqual(expected)
    expect(readOption(" /srv/notes ")).toEqual(expected)
    expect(read(["--notes-dir=/flag"], { DEMO_NOTES_DIR: "/env" })).toEqual({ notes_dir: "/flag" })
  })

  test.each([
    ["~", home],
    ["~/", home],
    ["~/x", `${home}/x`],
    ["~/x/../y/", `${home}/y`],
    ["/a/b/../c", "/a/c"],
    ["/a//b/./c/", "/a/b/c"],
  ])("expands and normalizes %s", (text, expected) => {
    expect(read([`--notes-dir=${text}`]).notes_dir).toBe(expected)
    expect(read([], { DEMO_NOTES_DIR: text }).notes_dir).toBe(expected)
    expect(readOption(text).notes_dir).toBe(expected)
  })

  test("takes the home directory from an absolute HOME in the given environment, else from the system", () => {
    expect(parseSettings(["--notes-dir=~/x"], { HOME: "/other" }, pathProfile).options.notes_dir).toBe("/other/x")
    for (const variables of [{ HOME: "relative/home" }, { HOME: "" }, {}]) {
      expect(parseSettings(["--notes-dir=~/x"], variables, pathProfile).options.notes_dir).toBe(join(homedir(), "x"))
    }
  })

  test("refuses a relative path, naming the source", () => {
    for (const text of ["x", "./x", "../x", "~user/x", "~x"]) {
      expect(failure(() => read([`--notes-dir=${text}`])).message).toBe("--notes-dir must be an absolute path.")
      expect(failure(() => read([], { DEMO_NOTES_DIR: text })).message).toBe("DEMO_NOTES_DIR must be an absolute path.")
      expect(failure(() => readOption(text)).message).toBe('Option "notes_dir" must be an absolute path.')
    }
  })

  test("treats a blank path as unset, and a blank flag suppresses the variable", () => {
    expect(read(["--notes-dir= "], { DEMO_NOTES_DIR: "/env" })).toEqual({})
    expect(read([], { DEMO_NOTES_DIR: " " })).toEqual({})
    expect(readOption(" ", { DEMO_NOTES_DIR: "/env" })).toEqual({})
    expect(readOption(undefined, { DEMO_NOTES_DIR: "/env" })).toEqual({ notes_dir: "/env" })
  })

  test("rejects a plugin path that is not text", () => {
    for (const value of [1, null, ["/a"]]) {
      expect(failure(() => readOption(value)).message).toBe('Option "notes_dir" must be an absolute path.')
    }
  })

  test("reads paths as a list, checking and normalizing each item", () => {
    const expected = { extra_dirs: ["/a/c", `${home}/x`, "/b"] }
    expect(read(["--extra-dirs", " /a/b/../c, ,~/x,/b,"])).toEqual(expected)
    expect(read([], { DEMO_EXTRA_DIRS: "/a/b/../c,~/x, ,/b" })).toEqual(expected)
    expect(
      settingsFromOptions({ extra_dirs: [" /a/b/../c ", "", "~/x", " ", "/b"] }, { HOME: home }, pathProfile).options,
    ).toEqual(expected)
  })

  test("refuses the first relative item of paths, naming the source", () => {
    expect(failure(() => read(["--extra-dirs=/a,b,/c"])).message).toBe("--extra-dirs must be an absolute path.")
    expect(failure(() => read([], { DEMO_EXTRA_DIRS: "/a,~u/b" })).message).toBe(
      "DEMO_EXTRA_DIRS must be an absolute path.",
    )
    expect(failure(() => settingsFromOptions({ extra_dirs: ["/a", "b"] }, {}, pathProfile)).message).toBe(
      'Option "extra_dirs" must be an absolute path.',
    )
  })

  test("treats paths with no item left as unset, and rejects a plugin value that is not a list of strings", () => {
    expect(read(["--extra-dirs=, ,"], { DEMO_EXTRA_DIRS: "/env" })).toEqual({})
    expect(read([], { DEMO_EXTRA_DIRS: " , " })).toEqual({})
    expect(settingsFromOptions({ extra_dirs: ["", " "] }, { DEMO_EXTRA_DIRS: "/env" }, pathProfile).options).toEqual({})
    for (const value of ["/a", [1], null]) {
      expect(failure(() => settingsFromOptions({ extra_dirs: value }, {}, pathProfile)).message).toBe(
        'Option "extra_dirs" must be a list of absolute paths.',
      )
    }
  })
})

describe("bounded tool options", () => {
  const boundedProfile: EntryProfile = {
    ...profile,
    options: {
      note_limit: { type: "number", integer: true, min: 1, max: 50 },
      ratio: { type: "number", min: 0, max: 1 },
      floor: { type: "number", min: 2 },
      ceiling: { type: "number", max: 9 },
      whole: { type: "number", integer: true },
      labels: { type: "list", min: 1, max: 2 },
      few: { type: "list", min: 2 },
      one_at_most: { type: "list", max: 1 },
      extra_dirs: { type: "paths", max: 3 },
      plain: { type: "text" },
      verbose: { type: "boolean" },
      limit_dir: { type: "path" },
    },
  }
  const read = (argv: string[], variables: Record<string, string | undefined> = {}) =>
    parseSettings(argv, variables, boundedProfile).options
  const readOption = (name: string, value: unknown) =>
    settingsFromOptions({ [name]: value }, {}, boundedProfile).options

  const flagOf = (name: string) => `--${name.replace(/_/g, "-")}`
  const variableOf = (name: string) => `DEMO_${name.toUpperCase()}`

  test.each([
    ["note_limit", 51, "a whole number from 1 to 50"],
    ["ratio", -0.5, "a number from 0 to 1"],
    ["floor", 1, "a number of at least 2"],
    ["ceiling", 10, "a number of at most 9"],
    ["whole", 1.5, "a whole number"],
  ])("refuses %s=%p in every source, naming it", (name, value, expected) => {
    expect(failure(() => read([`${flagOf(name)}=${value}`])).message).toBe(`${flagOf(name)} must be ${expected}.`)
    expect(failure(() => read([], { [variableOf(name)]: String(value) })).message).toBe(
      `${variableOf(name)} must be ${expected}.`,
    )
    expect(failure(() => readOption(name, value)).message).toBe(`Option "${name}" must be ${expected}.`)
  })

  test("refuses a number just outside either end, and a fraction when the number must be whole", () => {
    expect(failure(() => read(["--note-limit=0"])).message).toBe("--note-limit must be a whole number from 1 to 50.")
    expect(failure(() => read(["--note-limit=51"])).message).toBe("--note-limit must be a whole number from 1 to 50.")
    expect(failure(() => read(["--note-limit=2.5"])).message).toBe("--note-limit must be a whole number from 1 to 50.")
    expect(failure(() => read(["--ratio=1.0001"])).message).toBe("--ratio must be a number from 0 to 1.")
  })

  test("accepts the bounds themselves and values between", () => {
    expect(read(["--note-limit=1", "--ratio=0"])).toEqual({ note_limit: 1, ratio: 0 })
    expect(read(["--note-limit=50", "--ratio=1"])).toEqual({ note_limit: 50, ratio: 1 })
    expect(read(["--ratio=0.25", "--whole=-3", "--floor=2", "--ceiling=9"])).toEqual({
      ratio: 0.25,
      whole: -3,
      floor: 2,
      ceiling: 9,
    })
    expect(readOption("note_limit", 50)).toEqual({ note_limit: 50 })
  })

  test.each([
    ["labels", ["a", "b", "c"], "from 1 to 2 items"],
    ["one_at_most", ["a", "b"], "at most 1 item"],
    ["extra_dirs", ["/a", "/b", "/c", "/d"], "at most 3 items"],
  ])("refuses %s with %p in every source, naming it", (name, items, expected) => {
    const text = items.join(",")
    expect(failure(() => read([`${flagOf(name)}=${text}`])).message).toBe(`${flagOf(name)} must list ${expected}.`)
    expect(failure(() => read([], { [variableOf(name)]: text })).message).toBe(
      `${variableOf(name)} must list ${expected}.`,
    )
    expect(failure(() => readOption(name, items)).message).toBe(`Option "${name}" must list ${expected}.`)
  })

  test("words a minimum alone", () => {
    expect(failure(() => read(["--few=a"])).message).toBe("--few must list at least 2 items.")
  })

  test("accepts lists within bounds, counting items after blanks are dropped", () => {
    expect(read(["--labels=a", "--extra-dirs=/a,/b,/c", "--few=a,b,c,d"])).toEqual({
      labels: ["a"],
      extra_dirs: ["/a", "/b", "/c"],
      few: ["a", "b", "c", "d"],
    })
    expect(read(["--labels= a, ,b,"])).toEqual({ labels: ["a", "b"] })
    expect(readOption("labels", ["a", "", "b", " "])).toEqual({ labels: ["a", "b"] })
    expect(read(["--extra-dirs=/a,/a/../a"])).toEqual({ extra_dirs: ["/a", "/a"] })
  })

  test("never checks an option that is not given, nor a blank one", () => {
    expect(read([])).toEqual({})
    expect(read(["--labels= , ", "--few=,"], { DEMO_LABELS: "a,b,c" })).toEqual({})
    expect(read([], { DEMO_FEW: " , " })).toEqual({})
    expect(
      settingsFromOptions({ labels: [], few: ["", " "], extra_dirs: undefined }, {}, boundedProfile).options,
    ).toEqual({})
  })

  test("reads a declaration that is only a type, and a boolean declared as an object", () => {
    expect(read(["--plain= text ", "--limit-dir=/a/../b", "--verbose"])).toEqual({
      plain: "text",
      limit_dir: "/b",
      verbose: true,
    })
    expect(failure(() => read(["--verbose=true"])).message).toBe("Option --verbose takes no value.")
    expect(read([], { DEMO_VERBOSE: "0", DEMO_PLAIN: "x" })).toEqual({ verbose: false, plain: "x" })
    expect(readOption("verbose", true)).toEqual({ verbose: true })
    expect(failure(() => readOption("plain", 1)).message).toBe('Option "plain" must be text.')
  })

  test("keeps the type errors of a bounded option", () => {
    expect(failure(() => read(["--ratio=x"])).message).toBe('Unknown number "x" in --ratio; use a finite number.')
    expect(failure(() => readOption("ratio", "1")).message).toBe('Option "ratio" must be a finite number.')
    expect(failure(() => readOption("labels", "a")).message).toBe('Option "labels" must be a list of strings.')
    expect(failure(() => readOption("extra_dirs", ["rel"])).message).toBe(
      'Option "extra_dirs" must be an absolute path.',
    )
  })
})

describe("tool option variables", () => {
  test("lists package option variables after standard settings and before tool variables", () => {
    const variables = ["DEMO_A_B", "DEMO_ENABLED", "DEMO_COUNT", "DEMO_LABELS"]
    expect(settingVariables(typedProfile)).toEqual([...settingVariables({ ...profile, options: {} }), ...variables])
    expect(forwardedVariables(typedProfile, ["XDG_STATE_HOME"])).toEqual([
      ...settingVariables(typedProfile),
      "DEMO_GRANT_KEY",
      "XDG_STATE_HOME",
    ])
  })
})
