import { describe, expect, test } from "bun:test"
import { translator } from "../words"
import { rebaseRead } from "./read"
import { REBASE_TRANSLATIONS } from "./words"

const ja = translator(REBASE_TRANSLATIONS, "ja")

const REBASE_TOOLS = [rebaseRead]

describe("REBASE_TRANSLATIONS", () => {
  test("has a Japanese word for every word the rebase tools write", () => {
    const words = REBASE_TOOLS.flatMap((tool) => (tool.intent === undefined ? [tool.title] : [tool.title, tool.intent]))
    expect(Object.keys(REBASE_TRANSLATIONS.ja!).sort()).toEqual([...new Set(words)].sort())
    for (const word of words) expect(ja.word(word), word).not.toBe(word)
  })
})
