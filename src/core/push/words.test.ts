import { afterEach, describe, expect, test } from "bun:test"
import { acceptedFact } from "../commit/commit-describe"
import { callDescription, templatePlaceholders } from "../describe"
import { FACT_TRANSLATIONS } from "../facts"
import { GIT_FACT_TRANSLATIONS } from "../git-facts"
import { type CallDescription, type ToolSpec } from "../tool"
import { translator } from "../words"
import { fullSha, previewedSend } from "../../testing/push-fixtures"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { layer } from "../../testing/rebase-fixtures"
import { pushRead } from "./read"
import { pushSend } from "./send"
import { branchesFact, type KindedBranch } from "./send-describe"
import { KIND_WORDS, type SentKind } from "./send-plan"
import { PUSH_TRANSLATIONS } from "./words"

const ja = translator(PUSH_TRANSLATIONS, "ja")

const PUSH_TOOLS: ToolSpec[] = [pushRead, pushSend]

/** The words the shared fact tables own, and the commit table's `Accepted findings`, which the push table leaves out. */
const SHARED_WORDS = new Set([
  ...Object.keys(FACT_TRANSLATIONS.ja!),
  ...Object.keys(GIT_FACT_TRANSLATIONS.ja!),
  acceptedFact([]).label,
])

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

/** One new branch described, then a line of layers with accepted findings, then a force push. */
async function sendDescriptions(): Promise<(CallDescription | undefined)[]> {
  const repo = await tempRepo()
  repos.push(repo)
  const describeSend = (args: Parameters<typeof pushSend.execute>[0]) =>
    callDescription(pushSend, args, { cwd: repo.dir })

  await layer(repo, "l1")
  const single = await describeSend(await previewedSend(repo))

  await repo.git(["push", "-u", "origin", "l1"])
  await repo.commit("l1: more", { "more.txt": "1\n" })
  await layer(repo, "l2")
  const line = await describeSend({ ...(await previewedSend(repo)), accept_findings: ["a:1:r"] })

  const remoteTip = await fullSha(repo, "origin/l1")
  await repo.git(["switch", "l1"])
  await repo.git(["reset", "--hard", "HEAD~2"])
  await repo.commit("l1: replacement", { "other.txt": "x\n" })
  const force = await describeSend({
    remote: "origin",
    branches: [{ branch: "l1", sha: await fullSha(repo, "l1"), expect: remoteTip }],
  })
  return [single, line, force]
}

/** Every non-empty set of kinds the `Branches` fact can name, each as a fact. */
function branchesFacts() {
  const kinds = Object.keys(KIND_WORDS) as SentKind[]
  const subsets = Array.from({ length: 2 ** kinds.length - 1 }, (_, index) =>
    kinds.filter((_kind, position) => ((index + 1) >> position) & 1),
  )
  return subsets.map((subset) => branchesFact(subset.map((kind): KindedBranch => ({ branch: `${kind}-branch`, kind }))))
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

/** The words the push tools write in English: their titles, their intents and the words their descriptions write beyond the shared facts'. */
async function pushWords(): Promise<string[]> {
  const toolWords = PUSH_TOOLS.flatMap((tool) => (tool.intent === undefined ? [tool.title] : [tool.title, tool.intent]))
  const descriptionWords = [
    ...(await sendDescriptions()).flatMap(wordsOf),
    ...branchesFacts().flatMap(({ label, value }) => (typeof value === "string" ? [label] : [label, value.text])),
  ]
  return [...new Set([...toolWords, ...descriptionWords.filter((word) => !SHARED_WORDS.has(word))])]
}

describe("PUSH_TRANSLATIONS", () => {
  test("has a Japanese word for every word the push tools write", async () => {
    expect(Object.keys(PUSH_TRANSLATIONS.ja!).sort()).toEqual((await pushWords()).sort())
  })

  test("translates every title, intent and description word", async () => {
    for (const word of await pushWords()) {
      const translated = (templatePlaceholders(word)?.size ?? 0) > 0 ? ja.template(word) : ja.word(word)
      expect(translated, word).not.toBe(word)
    }
  })

  test("the Branches fact names every set of kinds with a template of its own", () => {
    const texts = branchesFacts().map(({ value }) => (typeof value === "string" ? value : value.text))
    expect(new Set(texts).size).toBe(7)
  })
})
