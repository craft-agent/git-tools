import { describe, expect, test } from "bun:test"
import type { ToolSpec } from "../tool"
import { translator } from "../words"
import { repoRead } from "./read"
import { REPO_TRANSLATIONS } from "./words"

const ja = translator(REPO_TRANSLATIONS, "ja")

const REPO_TOOLS: ToolSpec[] = [repoRead]

/** The words the repo tools write in English: their titles and, when present, their intents. */
function repoWords(): string[] {
  return REPO_TOOLS.flatMap((tool) => (tool.intent === undefined ? [tool.title] : [tool.title, tool.intent]))
}

describe("REPO_TRANSLATIONS", () => {
  test("has a Japanese word for every word the repo tools write", () => {
    expect(Object.keys(REPO_TRANSLATIONS.ja!).sort()).toEqual(repoWords().sort())
  })

  test("translates every title and intent", () => {
    for (const word of repoWords()) expect(ja.word(word)).not.toBe(word)
  })
})
