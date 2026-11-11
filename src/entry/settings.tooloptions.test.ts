import { describe, expect, test } from "bun:test"
import { NOTE_OPTION } from "./options.testing"
import { PROJECT_PROFILE } from "./profile"
import {
  forwardedVariables,
  parseSettings,
  parseToolOptions,
  parseToolSettings,
  settingsFromOptions,
  settingVariables,
} from "./settings"
import { failure, profile } from "./settings.testing"

const FLAG = "--note-text"
const VARIABLE = "DEMO_NOTE_TEXT"

describe("tool options on the command line", () => {
  test("a flag, in both forms, or the variable gives the option, trimmed", () => {
    expect(parseSettings([FLAG, " a b "], {}, profile).options).toEqual({ [NOTE_OPTION]: "a b" })
    expect(parseSettings([`${FLAG}=/x/y`], {}, profile).options).toEqual({ [NOTE_OPTION]: "/x/y" })
    expect(parseSettings([], { [VARIABLE]: " /x/y\n" }, profile).options).toEqual({ [NOTE_OPTION]: "/x/y" })
    expect(parseToolSettings([FLAG, "a"], {}, profile).options).toEqual({ [NOTE_OPTION]: "a" })
  })

  test("a flag wins over its variable", () => {
    expect(parseSettings([FLAG, "flag"], { [VARIABLE]: "variable" }, profile).options).toEqual({
      [NOTE_OPTION]: "flag",
    })
  })

  test("blank counts as unset", () => {
    expect(parseSettings([], { [VARIABLE]: "  " }, profile).options).toEqual({})
    expect(parseSettings([`${FLAG}=`], {}, profile).options).toEqual({})
    expect(parseSettings([FLAG, " "], {}, profile).options).toEqual({})
  })

  test("a flag without a value is rejected, naming it", () => {
    expect(failure(() => parseSettings([FLAG], {}, profile)).message).toContain(FLAG)
    expect(failure(() => parseSettings([FLAG, "--read-only"], {}, profile)).message).toContain(FLAG)
  })

  test("a profile without the option does not know its flag or variable", () => {
    const none = { ...profile, options: [] }
    expect(failure(() => parseSettings([FLAG, "a"], {}, none)).message).toContain(FLAG)
    expect(parseSettings([], { [VARIABLE]: "a" }, none).options).toEqual({})
  })

  test("the package's own profile reads published_text_rules from --published-text-rules", () => {
    const options = { published_text_rules: "/rules.json" }
    expect(parseSettings(["--published-text-rules", "/rules.json"], {}).options).toEqual(options)
    expect(parseSettings([], { GIT_TOOLS_PUBLISHED_TEXT_RULES: "/rules.json" }).options).toEqual(options)
  })

  test("the package's own profile reads worktree_root from --worktree-root", () => {
    const options = { worktree_root: "~/trees" }
    expect(parseSettings(["--worktree-root", "~/trees"], {}).options).toEqual(options)
    expect(parseSettings([], { GIT_TOOLS_WORKTREE_ROOT: " ~/trees " }).options).toEqual(options)
    expect(settingsFromOptions({ worktree_root: "~/trees" }, {}).options).toEqual(options)
  })
})

describe("parseToolOptions", () => {
  test("reads the tool options from flags and the environment", () => {
    expect(parseToolOptions([FLAG, "a"], { [VARIABLE]: "b" }, profile)).toEqual({ [NOTE_OPTION]: "a" })
    expect(parseToolOptions([], { [VARIABLE]: "b" }, profile)).toEqual({ [NOTE_OPTION]: "b" })
    expect(parseToolOptions([], {}, profile)).toEqual({})
  })

  test("rejects every other flag as unknown, naming it", () => {
    expect(failure(() => parseToolOptions(["--toolsets", "alpha"], {}, profile)).message).toContain("--toolsets")
    expect(failure(() => parseToolOptions(["--confirm=harness"], {}, profile)).message).toContain("--confirm")
    expect(failure(() => parseToolOptions(["--nope"], {}, profile)).message).toContain("--nope")
  })
})

describe("tool options as plugin options", () => {
  const fromOptions = (options: Record<string, unknown>, env: Record<string, string | undefined> = {}) =>
    settingsFromOptions(options, env, profile)

  test("an option gives the value, trimmed", () => {
    expect(fromOptions({ [NOTE_OPTION]: " /x/y " }).options).toEqual({ [NOTE_OPTION]: "/x/y" })
  })

  test("the variable stands in, and an option wins over it", () => {
    expect(fromOptions({}, { [VARIABLE]: "env" }).options).toEqual({ [NOTE_OPTION]: "env" })
    expect(fromOptions({ [NOTE_OPTION]: "option" }, { [VARIABLE]: "env" }).options).toEqual({ [NOTE_OPTION]: "option" })
  })

  test("blank counts as unset, and a blank option does not fall back to the variable", () => {
    expect(fromOptions({ [NOTE_OPTION]: "  " }).options).toEqual({})
    expect(fromOptions({}, { [VARIABLE]: " " }).options).toEqual({})
    expect(fromOptions({ [NOTE_OPTION]: "" }, { [VARIABLE]: "env" }).options).toEqual({})
  })

  test("an option that is not text is rejected, naming it", () => {
    for (const value of [1, true, ["a"], null, {}]) {
      expect(failure(() => fromOptions({ [NOTE_OPTION]: value })).message).toBe(`Option "${NOTE_OPTION}" must be text.`)
    }
  })

  test("an unknown option is still rejected, and the message lists the tool options", () => {
    const message = failure(() => fromOptions({ bogus: "a" })).message
    expect(message).toContain('"bogus"')
    expect(message).toContain(NOTE_OPTION)
  })
})

describe("the variables of the tool options", () => {
  test("follow the settings' variables", () => {
    expect(settingVariables(profile).at(-1)).toBe(VARIABLE)
    expect(forwardedVariables(profile, ["X"])).toEqual([...settingVariables(profile), "X"])
  })

  test("the package's own include GIT_TOOLS_PUBLISHED_TEXT_RULES and GIT_TOOLS_WORKTREE_ROOT", () => {
    expect(PROJECT_PROFILE.options).toEqual(["published_text_rules", "worktree_root"])
    for (const variable of ["GIT_TOOLS_PUBLISHED_TEXT_RULES", "GIT_TOOLS_WORKTREE_ROOT"]) {
      expect(settingVariables()).toContain(variable)
      expect(forwardedVariables()).toContain(variable)
    }
  })
})
