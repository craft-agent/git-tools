import { describe, expect, test } from "bun:test"
import type { ToolSpec } from "../tool"
import { translator } from "../words"
import { worktreeRead } from "./read"
import { WORKTREE_TRANSLATIONS } from "./words"

const ja = translator(WORKTREE_TRANSLATIONS, "ja")

const WORKTREE_TOOLS: ToolSpec[] = [worktreeRead]

/** The words the worktree tools write in English: their titles and, when present, their intents. */
function worktreeWords(): string[] {
  return WORKTREE_TOOLS.flatMap((tool) => (tool.intent === undefined ? [tool.title] : [tool.title, tool.intent]))
}

describe("WORKTREE_TRANSLATIONS", () => {
  test("has a Japanese word for every word the worktree tools write", () => {
    expect(Object.keys(WORKTREE_TRANSLATIONS.ja!).sort()).toEqual(worktreeWords().sort())
  })

  test("translates every title and intent", () => {
    for (const word of worktreeWords()) expect(ja.word(word)).not.toBe(word)
  })
})
