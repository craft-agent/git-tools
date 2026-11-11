import { afterEach, describe, expect, test } from "bun:test"
import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { addTaskWorktree, layoutDirectory, REMOTE_REPOSITORY, worktreeContext } from "../../testing/worktree-fixtures"
import { callDescription, templatePlaceholders } from "../describe"
import { FACT_TRANSLATIONS } from "../facts"
import { GIT_FACT_TRANSLATIONS } from "../git-facts"
import type { CallDescription, ToolSpec } from "../tool"
import { translator } from "../words"
import { worktreeAdd } from "./add"
import { worktreeRead } from "./read"
import { worktreeRemove } from "./remove"
import { WORKTREE_TRANSLATIONS } from "./words"

const ja = translator(WORKTREE_TRANSLATIONS, "ja")

const WORKTREE_TOOLS: ToolSpec[] = [worktreeRead, worktreeAdd, worktreeRemove]

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

/**
 * Every description removing a worktree gives: a branch's worktree and a
 * detached one, removed and pruned, with one ignored path lost and with
 * several.
 */
async function removeDescriptions() {
  const repo = await tempRepo()
  repos.push(repo)
  await repo.commit("ignore logs", { ".gitignore": "*.log\n" })
  await repo.git(["push", "origin", "main"])
  const one = await addTaskWorktree(repo, "task/one")
  writeFileSync(join(one, "a.log"), "a\n")
  const several = await addTaskWorktree(repo, "task/several")
  writeFileSync(join(several, "a.log"), "a\n")
  writeFileSync(join(several, "b.log"), "b\n")
  const detached = layoutDirectory(repo, REMOTE_REPOSITORY, "detached")
  await repo.git(["worktree", "add", "--detach", detached])
  const gone = await addTaskWorktree(repo, "task/gone")
  const goneDetached = layoutDirectory(repo, REMOTE_REPOSITORY, "gone-detached")
  await repo.git(["worktree", "add", "--detach", goneDetached])
  rmSync(gone, { recursive: true })
  rmSync(goneDetached, { recursive: true })

  const describeRemove = (directory: string) => callDescription(worktreeRemove, { directory }, worktreeContext(repo))
  return Promise.all([one, several, detached, gone, goneDetached].map(describeRemove))
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
  const descriptionWords = [...(await addDescriptions()), ...(await removeDescriptions())].flatMap(wordsOf)
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
