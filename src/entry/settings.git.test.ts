import { describe, expect, test } from "bun:test"
import { PROJECT } from "../project"
import { PROJECT_PROFILE } from "./profile"
import {
  forwardedVariables,
  parseSettings,
  parseToolOptions,
  parseToolSettings,
  settingsFromOptions,
  settingVariables,
} from "./settings"
import { failure } from "./settings.testing"

const OPTIONS = {
  published_text_rules: {
    flag: "--published-text-rules",
    variable: "GIT_TOOLS_PUBLISHED_TEXT_RULES",
    value: "/rules.json",
  },
  worktree_root: { flag: "--worktree-root", variable: "GIT_TOOLS_WORKTREE_ROOT", value: "/trees" },
}

describe("the options of git-tools", () => {
  test("are both paths", () => {
    expect(PROJECT.options).toEqual({ published_text_rules: "path", worktree_root: "path" })
    expect(PROJECT_PROFILE.options).toEqual(PROJECT.options)
  })

  describe.each(Object.entries(OPTIONS))("%s", (name, { flag, variable, value }) => {
    const options = { [name]: value }

    test("is read from its flag, in both forms, trimmed", () => {
      expect(parseSettings([flag, ` ${value} `], {}).options).toEqual(options)
      expect(parseSettings([`${flag}=${value}`], {}).options).toEqual(options)
      expect(parseToolSettings([flag, value], {}).options).toEqual(options)
      expect(parseToolOptions([flag, value], {})).toEqual(options)
    })

    test("is read from its variable, trimmed, and a flag wins over it", () => {
      expect(parseSettings([], { [variable]: ` ${value}\n` }).options).toEqual(options)
      expect(parseSettings([flag, value], { [variable]: "/other" }).options).toEqual(options)
    })

    test("is unset when blank, from a flag or a variable", () => {
      expect(parseSettings([flag, " "], {}).options).toEqual({})
      expect(parseSettings([`${flag}=`], {}).options).toEqual({})
      expect(parseSettings([], { [variable]: "  " }).options).toEqual({})
    })

    test("is a plugin option, trimmed, standing in for its variable", () => {
      expect(settingsFromOptions({ [name]: ` ${value} ` }, {}).options).toEqual(options)
      expect(settingsFromOptions({}, { [variable]: value }).options).toEqual(options)
      expect(settingsFromOptions({ [name]: value }, { [variable]: "/other" }).options).toEqual(options)
      expect(settingsFromOptions({ [name]: "  " }, { [variable]: "/other" }).options).toEqual({})
    })

    test("is refused as a plugin option when it is not text, naming it", () => {
      for (const given of [1, true, ["a"], null, {}]) {
        expect(failure(() => settingsFromOptions({ [name]: given }, {})).message).toBe(
          `Option "${name}" must be an absolute path.`,
        )
      }
    })

    test("has its variable among the settings' and the forwarded ones", () => {
      expect(settingVariables()).toContain(variable)
      expect(forwardedVariables()).toContain(variable)
    })
  })

  test("both are given together", () => {
    const flags = Object.values(OPTIONS).flatMap(({ flag, value }) => [flag, value])
    expect(parseSettings(flags, {}).options).toEqual({ published_text_rules: "/rules.json", worktree_root: "/trees" })
  })
})
