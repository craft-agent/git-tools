import { afterEach, describe, expect, test } from "bun:test"
import { type TempRepo, tempRepo } from "../../testing/git-repo"
import { conflictingStack, layer, startStoppedRebase } from "../../testing/rebase-fixtures"
import { callDescription, templatePlaceholders } from "../describe"
import { FACT_TRANSLATIONS } from "../facts"
import { GIT_FACT_TRANSLATIONS } from "../git-facts"
import { type CallDescription, type ToolSpec } from "../tool"
import { translator } from "../words"
import { rebaseRead } from "./read"
import { rebaseResume } from "./resume"
import { rebaseSplit } from "./split"
import { rebaseStart } from "./start"
import { REBASE_TRANSLATIONS } from "./words"

const ja = translator(REBASE_TRANSLATIONS, "ja")

const REBASE_TOOLS: ToolSpec[] = [rebaseRead, rebaseStart, rebaseResume, rebaseSplit]

/** The words the shared fact tables own, which the rebase table leaves out. */
const SHARED_WORDS = new Set([...Object.keys(FACT_TRANSLATIONS.ja!), ...Object.keys(GIT_FACT_TRANSLATIONS.ja!)])

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

async function fixture() {
  const repo = await tempRepo()
  repos.push(repo)
  return repo
}

/** A pushed stack with a fixup, described rebasing, folding in place, and rebasing after a layer that landed. */
async function startDescriptions() {
  const repo = await fixture()
  await layer(repo, "l1")
  await layer(repo, "l2")
  await repo.git(["push", "origin", "l1", "l2"])
  await repo.commit("fixup! l1: 1", { "fix.txt": "fix\n" })
  const describeStart = (args: Parameters<typeof rebaseStart.execute>[0]) =>
    callDescription(rebaseStart, args, { cwd: repo.dir })
  return [await describeStart({}), await describeStart({ keep_base: true }), await describeStart({ after: "l1" })]
}

/** A stack stopped on a conflict, described continuing, skipping and aborting. */
async function resumeDescriptions() {
  const repo = await fixture()
  await conflictingStack(repo)
  await startStoppedRebase(repo)
  const describeResume = (action: "continue" | "skip" | "abort") =>
    callDescription(rebaseResume, { action }, { cwd: repo.dir })
  return [await describeResume("continue"), await describeResume("skip"), await describeResume("abort")]
}

/** An unpushed branch of three commits, described cutting, adding a layer, and both. */
async function splitDescriptions() {
  const repo = await fixture()
  await layer(repo, "feat", 3)
  const describeSplit = (args: Parameters<typeof rebaseSplit.execute>[0]) =>
    callDescription(rebaseSplit, args, { cwd: repo.dir })
  const at = ["HEAD~2"]
  return [
    await describeSplit({ at, names: ["low"] }),
    await describeSplit({ add: "next" }),
    await describeSplit({ at, names: ["low"], add: "next" }),
  ]
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

/** The words the rebase tools write in English: their titles, their intents and the words their descriptions write beyond the shared facts'. */
async function rebaseWords(): Promise<string[]> {
  const toolWords = REBASE_TOOLS.flatMap((tool) =>
    tool.intent === undefined ? [tool.title] : [tool.title, tool.intent],
  )
  const descriptionWords = [
    ...(await startDescriptions()),
    ...(await resumeDescriptions()),
    ...(await splitDescriptions()),
  ].flatMap(wordsOf)
  return [...new Set([...toolWords, ...descriptionWords.filter((word) => !SHARED_WORDS.has(word))])]
}

describe("REBASE_TRANSLATIONS", () => {
  test("has a Japanese word for every word the rebase tools write", async () => {
    expect(Object.keys(REBASE_TRANSLATIONS.ja!).sort()).toEqual((await rebaseWords()).sort())
  })

  test("translates every title, intent and description word", async () => {
    for (const word of await rebaseWords()) {
      const translated = (templatePlaceholders(word)?.size ?? 0) > 0 ? ja.template(word) : ja.word(word)
      expect(translated, word).not.toBe(word)
    }
  })
})
