import { describe, expect, test } from "bun:test"
import {
  languageVariable,
  parseSettings,
  parseToolSettings,
  promptLanguage,
  settingsFromOptions,
  settingVariables,
} from "./settings"
import { failure, profile } from "./settings.testing"

const fromOptions = (options: Record<string, unknown> | undefined, env: Record<string, string | undefined> = {}) =>
  settingsFromOptions(options, env, profile)

describe("languageVariable", () => {
  test("is the profile's prefix and LANGUAGE, and no setting variable", () => {
    expect(languageVariable(profile)).toBe("DEMO_LANGUAGE")
    expect(settingVariables(profile)).not.toContain("DEMO_LANGUAGE")
  })
})

describe("settingsFromOptions language", () => {
  test("reads the option trimmed, and treats blank as unset", () => {
    expect(fromOptions({ language: "ja" })).toEqual({ language: "ja" })
    expect(fromOptions({ language: " ja-JP " }).language).toBe("ja-JP")
    expect(fromOptions({ language: "  " })).toEqual({})
    expect(fromOptions({ language: "xx-unknown" }).language).toBe("xx-unknown")
  })

  test("rejects a value that is not a string", () => {
    const message = failure(() => fromOptions({ language: 1 })).message
    expect(message).toBe('Option "language" must be a language tag such as "ja".')
  })

  test("falls back to the environment, and an option wins over it", () => {
    expect(fromOptions({}, { DEMO_LANGUAGE: " fr " }).language).toBe("fr")
    expect(fromOptions({}, { DEMO_LANGUAGE: " " })).toEqual({})
    expect(fromOptions({ language: "ja" }, { DEMO_LANGUAGE: "fr" }).language).toBe("ja")
  })

  test("the unknown-option message lists language", () => {
    expect(failure(() => fromOptions({ bogus: 1 })).message).toContain("language")
  })
})

describe("the command-line parsers", () => {
  test("reject --language as an unknown option", () => {
    expect(failure(() => parseSettings(["--language", "ja"], {}, profile)).message).toContain("--language")
    expect(failure(() => parseToolSettings(["--language=ja"], {}, profile)).message).toContain("--language")
  })

  test("ignore the language variable", () => {
    const env = { DEMO_LANGUAGE: "ja" }
    expect(parseSettings([], env, profile)).toEqual({ confirm: "harness" })
    expect(parseToolSettings([], env, profile)).toEqual({})
  })
})

describe("promptLanguage", () => {
  const env = { DEMO_LANGUAGE: "fr" }

  test("prefers the flag, then the environment, then the harness", () => {
    expect(promptLanguage("ja", env, "de", profile)).toBe("ja")
    expect(promptLanguage(undefined, env, "de", profile)).toBe("fr")
    expect(promptLanguage(undefined, {}, "de", profile)).toBe("de")
  })

  test("skips blank values and trims", () => {
    expect(promptLanguage(" ", env, "de", profile)).toBe("fr")
    expect(promptLanguage(undefined, { DEMO_LANGUAGE: "" }, " de ", profile)).toBe("de")
    expect(promptLanguage(" ja ", {}, undefined, profile)).toBe("ja")
  })

  test("is undefined when nothing is set", () => {
    expect(promptLanguage(undefined, {}, undefined, profile)).toBeUndefined()
    expect(promptLanguage(" ", { DEMO_LANGUAGE: " " }, "", profile)).toBeUndefined()
  })
})
