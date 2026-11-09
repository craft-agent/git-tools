import { afterEach, describe, expect, test } from "bun:test"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { PREFIXED } from "../../testing/secret-fixtures"
import { callDescription, templatePlaceholders } from "../describe"
import { FACT_TRANSLATIONS } from "../facts"
import { GIT_FACT_TRANSLATIONS } from "../git-facts"
import { type CallDescription, invoke, type ToolSpec } from "../tool"
import { translator } from "../words"
import { commitAmend } from "./amend"
import { commitCreate } from "./create"
import { commitRead } from "./read"
import { commitStage } from "./stage"
import { commitVerify } from "./verify"
import { COMMIT_TRANSLATIONS } from "./words"

const ja = translator(COMMIT_TRANSLATIONS, "ja")

const COMMIT_TOOLS: ToolSpec[] = [commitRead, commitStage, commitCreate, commitAmend, commitVerify]

/** The words the shared fact tables own, which the commit table leaves out. */
const SHARED_WORDS = new Set([...Object.keys(FACT_TRANSLATIONS.ja!), ...Object.keys(GIT_FACT_TRANSLATIONS.ja!)])

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

/** A repository with two files changed in one hunk each, described staging one hunk and then both. */
async function stageDescriptions() {
  const repo = await tempRepo()
  repos.push(repo)
  await repo.commit("add files", { "a.txt": "a\n", "b.txt": "b\n" })
  repo.write("a.txt", "a changed\n")
  repo.write("b.txt", "b changed\n")
  const { digest } = (await invoke(commitRead, { method: "hunks" }, { cwd: repo.dir })).hunks!
  const describeHunks = (hunks: number[]) => callDescription(commitStage, { digest, hunks }, { cwd: repo.dir })
  return [await describeHunks([1]), await describeHunks([1, 2])]
}

/** A repository with a staged credential, described committing it with a message, as a fixup and with its finding accepted. */
async function createDescriptions() {
  const repo = await tempRepo()
  repos.push(repo)
  repo.write("a.txt", `id ${PREFIXED["github-pat"]}\n`)
  await repo.git(["add", "a.txt"])
  const describeCreate = (args: Parameters<typeof commitCreate.execute>[0]) =>
    callDescription(commitCreate, args, { cwd: repo.dir })
  return [
    await describeCreate({ message: "feat: add a" }),
    await describeCreate({ fixup: "HEAD" }),
    await describeCreate({ message: "feat: add a", accept_findings: ["a.txt:1:github-pat"] }),
  ]
}

/** The words the commit tools write in English: their titles, their intents and the words their descriptions write beyond the shared facts'. */
async function commitWords(): Promise<string[]> {
  const toolWords = COMMIT_TOOLS.flatMap((tool) =>
    tool.intent === undefined ? [tool.title] : [tool.title, tool.intent],
  )
  const descriptionWords = [...(await stageDescriptions()), ...(await createDescriptions())].flatMap(wordsOf)
  return [...new Set([...toolWords, ...descriptionWords.filter((word) => !SHARED_WORDS.has(word))])]
}

/** The tool's words in a description: its headline template, fact labels, value templates and text label. */
function wordsOf(description: CallDescription | undefined): string[] {
  if (description === undefined) throw new Error("The fixture call gave no description.")
  const { headline, facts, text } = description
  return [
    ...(headline ? [headline.text] : []),
    ...facts.flatMap(({ label, value }) => [label, ...(typeof value === "string" ? [] : [value.text])]),
    ...(text ? [text.label] : []),
  ]
}

describe("COMMIT_TRANSLATIONS", () => {
  test("has a Japanese word for every word the commit tools write", async () => {
    expect(Object.keys(COMMIT_TRANSLATIONS.ja!).sort()).toEqual((await commitWords()).sort())
  })

  test("translates every title, intent and description word", async () => {
    for (const word of await commitWords()) {
      const translated = (templatePlaceholders(word)?.size ?? 0) > 0 ? ja.template(word) : ja.word(word)
      expect(translated, word).not.toBe(word)
    }
  })
})
