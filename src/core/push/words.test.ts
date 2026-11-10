import { describe, expect, test } from "bun:test"
import type { ToolSpec } from "../tool"
import { translator } from "../words"
import { pushRead } from "./read"
import { PUSH_TRANSLATIONS } from "./words"

const ja = translator(PUSH_TRANSLATIONS, "ja")

const PUSH_TOOLS: ToolSpec[] = [pushRead]

/** The words the push tools write in English: their titles and, when present, their intents. */
function pushWords(): string[] {
  return PUSH_TOOLS.flatMap((tool) => (tool.intent === undefined ? [tool.title] : [tool.title, tool.intent]))
}

describe("PUSH_TRANSLATIONS", () => {
  test("has a Japanese word for every word the push tools write", () => {
    expect(Object.keys(PUSH_TRANSLATIONS.ja!).sort()).toEqual(pushWords().sort())
  })

  test("translates every title and intent", () => {
    for (const word of pushWords()) expect(ja.word(word)).not.toBe(word)
  })
})
