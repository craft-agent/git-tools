import { afterEach, describe, expect, test } from "bun:test"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { worktreeContext } from "../../testing/worktree-fixtures"
import { callDescription, templatePlaceholders } from "../describe"
import { FACT_TRANSLATIONS } from "../facts"
import { GIT_FACT_TRANSLATIONS } from "../git-facts"
import type { CallDescription, ToolSpec } from "../tool"
import { translator } from "../words"
import { worktreeAdd } from "./add"
import { worktreeRead } from "./read"
import { WORKTREE_TRANSLATIONS } from "./words"

const ja = translator(WORKTREE_TRANSLATIONS, "ja")

const WORKTREE_TOOLS: ToolSpec[] = [worktreeRead, worktreeAdd]

/** The words the shared fact tables own, which the worktree table leaves out. */
const SHARED_WORDS = new Set([...Object.keys(FACT_TRANSLATIONS.ja!), ...Object.keys(GIT_FACT_TRANSLATIONS.ja!)])

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

/** A new branch and an existing one, described adding a worktree. */
async function addDescriptions() {
  const repo = await tempRepo()
  repos.push(repo)
  await repo.git(["branch", "feat"])
  const describeAdd = (branch: string) => callDescription(worktreeAdd, { branch }, worktreeContext(repo))
  return [await describeAdd("task/new"), await describeAdd("feat")]
}

/** The tool's words in a description: its headline template, fact labels and value templates. */
function wordsOf(description: CallDescription | undefined): string[] {
  if (description === undefined) throw new Error("The fixture call gave no description.")
  const { headline, facts } = description
  return [
    ...(headline ? [headline.text] : []),
    ...facts.flatMap(({ label, value }) => [label, ...(typeof value === "string" ? [] : [value.text])]),
  ]
}

/** The words the worktree tools write in English: their titles, their intents and the words their descriptions write beyond the shared facts'. */
async function worktreeWords(): Promise<string[]> {
  const toolWords = WORKTREE_TOOLS.flatMap((tool) =>
    tool.intent === undefined ? [tool.title] : [tool.title, tool.intent],
  )
  const descriptionWords = (await addDescriptions()).flatMap(wordsOf)
  return [...new Set([...toolWords, ...descriptionWords.filter((word) => !SHARED_WORDS.has(word))])]
}

describe("WORKTREE_TRANSLATIONS", () => {
  test("has a Japanese word for every word the worktree tools write", async () => {
    expect(Object.keys(WORKTREE_TRANSLATIONS.ja!).sort()).toEqual((await worktreeWords()).sort())
  })

  test("translates every title, intent and description word", async () => {
    for (const word of await worktreeWords()) {
      const translated = (templatePlaceholders(word)?.size ?? 0) > 0 ? ja.template(word) : ja.word(word)
      expect(translated, word).not.toBe(word)
    }
  })
})
