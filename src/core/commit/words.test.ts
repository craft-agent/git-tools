import { describe, expect, test } from "bun:test"
import type { ToolSpec } from "../tool"
import { translator } from "../words"
import { commitAmend } from "./amend"
import { commitCreate } from "./create"
import { commitRead } from "./read"
import { commitStage } from "./stage"
import { commitVerify } from "./verify"
import { COMMIT_TRANSLATIONS } from "./words"

const ja = translator(COMMIT_TRANSLATIONS, "ja")

const COMMIT_TOOLS: ToolSpec[] = [commitRead, commitStage, commitCreate, commitAmend, commitVerify]

/** The words the commit tools write in English: their titles and, when present, their intents. */
function commitWords(): string[] {
  return COMMIT_TOOLS.flatMap((tool) => (tool.intent === undefined ? [tool.title] : [tool.title, tool.intent]))
}

describe("COMMIT_TRANSLATIONS", () => {
  test("has a Japanese word for every word the commit tools write", () => {
    expect(Object.keys(COMMIT_TRANSLATIONS.ja!).sort()).toEqual(commitWords().sort())
  })

  test("translates every title and intent", () => {
    for (const word of commitWords()) expect(ja.word(word)).not.toBe(word)
  })
})
