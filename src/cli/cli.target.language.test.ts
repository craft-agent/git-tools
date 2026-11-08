import { describe, expect, test } from "bun:test"
import { PROJECT } from "../project"
import { EXIT_OK, EXIT_USAGE } from "./cli"
import { ADD_ID, DESCRIBED_ID, ENGLISH_WORDS, TRANSLATIONS, cli, json } from "./testing"

const ARGS = '{"area":"north"}'
const JAPANESE_WORDS = { details: "詳細", target: "対象", more: "（ほか {count} 件）" }

const ENGLISH = {
  resources: ["north"],
  title: DESCRIBED_ID,
  words: ENGLISH_WORDS,
  description: {
    headline: 'Label the area "north"',
    facts: [{ label: "Area", value: "north" }],
    text: { label: "Body", body: "Body<U+202E> line\nnext" },
  },
}
const JAPANESE = {
  resources: ["north"],
  title: "ラベル付け",
  words: JAPANESE_WORDS,
  description: {
    headline: 'エリア "north" にラベルを付ける',
    facts: [{ label: "エリア", value: "north" }],
    text: { label: "本文", body: "Body<U+202E> line\nnext" },
  },
}

/** Runs `target` for the described fixture with the fixture translations, over `flags` and `env`. */
const target = (flags: string[], env: Record<string, string | undefined> = {}) =>
  cli(["target", DESCRIBED_ID, "--cwd", "/x", ...flags], ARGS, { env, translations: TRANSLATIONS })

describe("target in a language", () => {
  test("--language translates the title, the plugin's words and the description's words", async () => {
    const run = await target(["--language", "ja"])
    expect(run.code).toBe(EXIT_OK)
    expect(run.stderr).toBe("")
    expect(json(run)).toEqual(JAPANESE)
  })

  test("takes the --flag=value form and a regional tag", async () => {
    expect(json(await target(["--language=ja-JP"]))).toEqual(JAPANESE)
    expect(json(await target(["--harness-language=ja_JP"]))).toEqual(JAPANESE)
  })

  test("--harness-language alone translates", async () => {
    expect(json(await target(["--harness-language", "ja"]))).toEqual(JAPANESE)
  })

  test("--language wins over --harness-language, and a language without a table is English", async () => {
    expect(json(await target(["--language", "en", "--harness-language", "ja"]))).toEqual(ENGLISH)
    expect(json(await target(["--language", "ja", "--harness-language", "fr"]))).toEqual(JAPANESE)
  })

  test("the environment variable sits between the flag and the harness language", async () => {
    expect(json(await target(["--harness-language", "fr"], { DEMO_LANGUAGE: "ja" }))).toEqual(JAPANESE)
    expect(json(await target(["--harness-language", "ja"], { DEMO_LANGUAGE: "fr" }))).toEqual(ENGLISH)
    expect(json(await target(["--language", "fr"], { DEMO_LANGUAGE: "ja" }))).toEqual(ENGLISH)
  })

  test("blank values count as unset", async () => {
    expect(json(await target(["--harness-language", "ja"], { DEMO_LANGUAGE: "  " }))).toEqual(JAPANESE)
  })

  test("an unknown language, and none, keep English", async () => {
    expect(json(await target(["--language", "fr"]))).toEqual(ENGLISH)
    expect(json(await target([]))).toEqual(ENGLISH)
  })

  test("without package translations the plugin's own words are still translated", async () => {
    const run = await cli(["target", ADD_ID, "--cwd", "/x", "--language", "ja"], ARGS)
    expect(json(run)).toEqual({ resources: ["north"], title: `Title of ${ADD_ID}`, words: JAPANESE_WORDS })
  })

  test("the flags may come before --cwd", async () => {
    const run = await cli(["target", DESCRIBED_ID, "--language", "ja", "--cwd", "/x"], ARGS, {
      translations: TRANSLATIONS,
    })
    expect(json(run)).toEqual(JAPANESE)
  })
})

describe("target flags", () => {
  test.each([["--language"], ["--harness-language"]])("%s without a value is a usage error", async (flag) => {
    for (const flags of [[flag], [flag, "--cwd", "/x"], [`${flag}=`]]) {
      const run = await cli(["target", ADD_ID, "--cwd", "/x", ...flags])
      expect(run).toEqual({
        code: EXIT_USAGE,
        stdout: "",
        stderr: `${PROJECT.cli}: Option ${flag} needs a value.\n`,
      })
    }
  })

  test("any other leftover is still an unknown option", async () => {
    const run = await cli(["target", ADD_ID, "--cwd", "/x", "--language", "ja", "--bogus"])
    expect(run.code).toBe(EXIT_USAGE)
    expect(run.stderr).toContain('Unknown option "--bogus".')
  })

  test.each([["--language"], ["--harness-language"]])("list and run reject %s", async (flag) => {
    const cases: [string[], string][] = [
      [["list", flag, "ja"], flag],
      [["run", ADD_ID, "--cwd", "/x", flag, "ja"], flag],
      [["run", ADD_ID, "--cwd", "/x", `${flag}=ja`], `${flag}=ja`],
    ]
    for (const [argv, option] of cases) {
      const run = await cli(argv)
      expect(run.code).toBe(EXIT_USAGE)
      expect(run.stdout).toBe("")
      expect(run.stderr).toContain(`Unknown option "${option}".`)
    }
  })
})
