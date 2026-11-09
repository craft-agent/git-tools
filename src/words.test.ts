import { describe, expect, test } from "bun:test"
import { COMMIT_TRANSLATIONS } from "./core/commit/words"
import { templatePlaceholders } from "./core/describe"
import { FACT_TRANSLATIONS } from "./core/facts"
import { GIT_FACT_TRANSLATIONS } from "./core/git-facts"
import { REBASE_TRANSLATIONS } from "./core/rebase/words"
import { REPO_TRANSLATIONS } from "./core/repo/words"
import { translator } from "./core/words"
import { ALL_TOOLS } from "./tools"
import { ALL_TRANSLATIONS } from "./words"

const ja = translator(ALL_TRANSLATIONS, "ja")

describe("ALL_TRANSLATIONS", () => {
  test("joins the Japanese tables of the facts, the git facts, the repo, the commit and the rebase tools", () => {
    expect(ALL_TRANSLATIONS.ja).toEqual({
      ...FACT_TRANSLATIONS.ja,
      ...GIT_FACT_TRANSLATIONS.ja,
      ...REPO_TRANSLATIONS.ja,
      ...COMMIT_TRANSLATIONS.ja,
      ...REBASE_TRANSLATIONS.ja,
    })
    expect(ALL_TRANSLATIONS.ja!.Size).toBe("サイズ")
  })

  test("gives no English word to two tables", () => {
    const keys = [
      FACT_TRANSLATIONS,
      GIT_FACT_TRANSLATIONS,
      REPO_TRANSLATIONS,
      COMMIT_TRANSLATIONS,
      REBASE_TRANSLATIONS,
    ].flatMap((table) => Object.keys(table.ja!))
    expect(new Set(keys).size).toBe(keys.length)
  })

  test("gives every write tool an intent", () => {
    for (const tool of ALL_TOOLS.filter((spec) => spec.class !== "read")) {
      expect(tool.intent, tool.id).toBeDefined()
    }
  })

  test("has a Japanese word for every title and intent", () => {
    for (const tool of ALL_TOOLS) {
      for (const word of [tool.title, ...(tool.intent === undefined ? [] : [tool.intent])]) {
        expect(ja.word(word), `${tool.id}: ${word}`).not.toBe(word)
      }
    }
  })

  test("keeps the placeholders of every template", () => {
    const templates = Object.keys(ALL_TRANSLATIONS.ja!).filter((key) => (templatePlaceholders(key)?.size ?? 0) > 0)
    for (const key of templates) {
      expect(ja.template(key), key).toBe(ALL_TRANSLATIONS.ja![key]!)
    }
  })
})
