import { afterEach, describe, expect, test } from "bun:test"
import { type TempRepo, tempRepo } from "../../testing/git-repo"
import { PREFIXED } from "../../testing/secret-fixtures"
import { callDescription } from "../describe"
import { PIN_PATTERN } from "../pin"
import { shortSha } from "../rewrite"
import { commitAmend } from "./amend"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

async function fixture(options?: Parameters<typeof tempRepo>[0]) {
  const repo = await tempRepo(options)
  repos.push(repo)
  return repo
}

/** A repository on branch `feat` cut from main, with one commit of its own. */
async function featureBranch() {
  const repo = await fixture()
  await repo.git(["switch", "-c", "feat"])
  const first = await repo.commit("feat: change a\n\nWhy it changes.", { "a.txt": "a\n" })
  return { repo, first }
}

async function stage(repo: TempRepo, path: string, content: string): Promise<void> {
  repo.write(path, content)
  await repo.git(["add", path])
}

const describeAmend = (repo: TempRepo, args: Parameters<typeof commitAmend.execute>[0]) =>
  callDescription(commitAmend, args, { cwd: repo.dir })

const labels = (description: Awaited<ReturnType<typeof describeAmend>>) => description!.facts.map((fact) => fact.label)

describe("git_commit_amend description", () => {
  test("describes a reword with HEAD's short sha and subject, the new message and no counts", async () => {
    const { repo, first } = await featureBranch()

    const description = await describeAmend(repo, {
      message: "feat: rework a  \r\n\r\n\r\n\r\nWhy it changes.   \n\n\n",
    })

    expect(description!.headline).toEqual({
      text: "About to amend {commit}",
      values: { commit: `${shortSha(first)} feat: change a` },
    })
    expect(description!.facts).toEqual([
      { label: "Change", value: { text: "message only" } },
      { label: "Branch", value: "feat" },
    ])
    expect(description!.text).toEqual({ label: "Commit message", body: "feat: rework a\n\nWhy it changes.\n" })
    expect(description!.pins).toEqual({ head: first, index: expect.stringMatching(PIN_PATTERN) })
  })

  test("describes staged changes with HEAD's own message and the counts", async () => {
    const { repo } = await featureBranch()
    await stage(repo, "a.txt", "a\nb\n")
    await stage(repo, "b.txt", "b\n")

    const description = await describeAmend(repo, {})

    expect(description!.facts).toEqual([
      { label: "Change", value: { text: "staged changes" } },
      { label: "Branch", value: "feat" },
      { label: "Files", value: { text: "{files} files", values: { files: 2 } } },
      { label: "Lines", value: { text: "{added} added, {removed} removed", values: { added: 2, removed: 0 } } },
    ])
    expect(description!.text).toEqual({ label: "Commit message", body: "feat: change a\n\nWhy it changes.\n" })
  })

  test("tells staged changes and a new message from a message that is HEAD's own", async () => {
    const { repo } = await featureBranch()
    const unchanged = await describeAmend(repo, { message: "feat: change a\n\nWhy it changes.  \n\n" })
    expect(unchanged!.facts[0]).toEqual({ label: "Change", value: { text: "no change" } })

    await stage(repo, "a.txt", "a2\n")
    const both = await describeAmend(repo, { message: "feat: rework a" })
    expect(both!.facts[0]).toEqual({ label: "Change", value: { text: "staged changes and message" } })
    expect(labels(both)).toEqual(["Change", "Branch", "Files", "Lines"])

    const same = await describeAmend(repo, { message: "feat: change a\n\nWhy it changes.\n" })
    expect(same!.facts[0]).toEqual({ label: "Change", value: { text: "staged changes" } })
  })

  test("leads with the push that the amend would need to be forced", async () => {
    const { repo, first } = await featureBranch()
    expect(labels(await describeAmend(repo, { message: "feat: rework a" }))).toEqual(["Change", "Branch"])

    await repo.git(["push", "-u", "origin", "feat"])
    const pushed = await describeAmend(repo, { message: "feat: rework a" })
    expect(pushed!.facts[0]).toEqual({ label: "Push", value: { text: "needs a force push" } })
    expect(labels(pushed)).toEqual(["Push", "Change", "Branch"])
    expect(pushed!.pins!.head).toBe(first)
  })

  test("adds no push when the branch's remote branch is behind the commit being amended", async () => {
    const { repo } = await featureBranch()
    await repo.git(["push", "-u", "origin", "feat"])
    await repo.commit("feat: change b", { "b.txt": "b\n" })

    expect(labels(await describeAmend(repo, { message: "feat: rework b" }))).toEqual(["Change", "Branch"])
  })

  test("leads with the accepted findings that the staged changes hold, after any push", async () => {
    const { repo } = await featureBranch()
    await stage(repo, "a.txt", `id ${PREFIXED["github-pat"]}\n`)

    const accepted = await describeAmend(repo, { accept_findings: ["a.txt:1:github-pat"] })
    expect(accepted!.facts[0]).toEqual({ label: "Accepted findings", value: "a.txt:1:github-pat" })

    await repo.git(["push", "-u", "origin", "feat"])
    const pushed = await describeAmend(repo, { accept_findings: ["a.txt:1:github-pat"] })
    expect(labels(pushed)).toEqual(["Push", "Accepted findings", "Change", "Branch", "Files", "Lines"])

    const unmatched = await describeAmend(repo, { accept_findings: ["b.txt:1:github-pat"] })
    expect(labels(unmatched)).toEqual(["Push", "Change", "Branch", "Files", "Lines"])
  })

  test("gives no description when the call would fail before it amends", async () => {
    const unborn = await fixture({ initialCommit: false })
    await stage(unborn, "a.txt", "a\n")
    expect(await describeAmend(unborn, { message: "feat: add a" })).toBeUndefined()

    const { repo } = await featureBranch()
    expect(await describeAmend(repo, {})).toBeUndefined()
    expect(await describeAmend(repo, { message: " \n\n" })).toBeUndefined()
  })

  test("gives an equal description for the same state, and a new index pin for other staged content", async () => {
    const { repo } = await featureBranch()
    await stage(repo, "a.txt", "one\n")
    const first = await describeAmend(repo, { message: "feat: rework a" })
    expect(await describeAmend(repo, { message: "feat: rework a" })).toEqual(first)

    await stage(repo, "a.txt", "two\n")
    const second = await describeAmend(repo, { message: "feat: rework a" })
    expect(second!.pins!.index).not.toBe(first!.pins!.index)
    expect({ ...second, pins: undefined }).toEqual({ ...first, pins: undefined })
  })

  test("describes without writing to the repository", async () => {
    const { repo } = await featureBranch()
    await stage(repo, "a.txt", `id ${PREFIXED["github-pat"]}\n`)
    const state = async () => [
      await repo.git(["status", "--porcelain"]),
      await repo.git(["count-objects", "-v"]),
      await repo.git(["ls-files", "--stage"]),
      await repo.git(["rev-parse", "HEAD"]),
    ]
    const before = await state()

    await describeAmend(repo, { message: "feat: rework a", accept_findings: ["a.txt:1:github-pat"] })
    await describeAmend(repo, {})

    expect(await state()).toEqual(before)
  })
})
