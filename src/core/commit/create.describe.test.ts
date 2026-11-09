import { afterEach, describe, expect, test } from "bun:test"
import { type TempRepo, tempRepo } from "../../testing/git-repo"
import { PREFIXED } from "../../testing/secret-fixtures"
import { callDescription } from "../describe"
import { PIN_PATTERN } from "../pin"
import { shortSha } from "../rewrite"
import { commitCreate } from "./create"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

async function fixture() {
  const repo = await tempRepo()
  repos.push(repo)
  return repo
}

async function stage(repo: TempRepo, path: string, content: string): Promise<void> {
  repo.write(path, content)
  await repo.git(["add", path])
}

const describeCreate = (repo: TempRepo, args: Parameters<typeof commitCreate.execute>[0]) =>
  callDescription(commitCreate, args, { cwd: repo.dir })

describe("git_commit_create description", () => {
  test("describes a message with its normalized subject, text, branch and counts, pinning the index", async () => {
    const repo = await fixture()
    await stage(repo, "a.txt", "a\nb\n")
    await stage(repo, "README.md", "# Changed\n")

    const description = await describeCreate(repo, {
      message: "feat: add a  \r\n\r\n\r\n\r\nWhy it is needed.   \n\n\n",
    })

    expect(description!.headline).toEqual({ text: "About to commit {subject}", values: { subject: "feat: add a" } })
    expect(description!.text).toEqual({ label: "Commit message", body: "feat: add a\n\nWhy it is needed.\n" })
    expect(description!.facts).toEqual([
      { label: "Branch", value: "main" },
      { label: "Files", value: { text: "{files} files", values: { files: 2 } } },
      { label: "Lines", value: { text: "{added} added, {removed} removed", values: { added: 3, removed: 1 } } },
    ])
    expect(description!.pins).toEqual({
      head: (await repo.git(["rev-parse", "HEAD"])).trim(),
      index: expect.stringMatching(PIN_PATTERN),
    })
  })

  test("describes a fixup with the target's short sha and subject", async () => {
    const repo = await fixture()
    const target = await repo.commit("feat: first", { "a.txt": "a\n" })
    await repo.commit("feat: second", { "b.txt": "b\n" })
    await stage(repo, "a.txt", "a changed\n")

    const description = await describeCreate(repo, { fixup: target })

    expect(description!.headline).toEqual({
      text: "About to commit a fixup of {commit}",
      values: { commit: `${shortSha(target)} feat: first` },
    })
    expect(description!.text).toEqual({ label: "Commit message", body: "fixup! feat: first\n" })
    expect(description!.facts.map((fact) => fact.label)).toEqual(["Branch", "Files", "Lines"])
  })

  test("leads with the accepted findings that the staged changes hold", async () => {
    const repo = await fixture()
    await stage(repo, "a.txt", `id ${PREFIXED["github-pat"]}\n`)
    await stage(repo, "b.txt", `id ${PREFIXED["github-pat"]}\n`)

    const accepted = await describeCreate(repo, {
      message: "feat: add a",
      accept_findings: ["b.txt:1:github-pat", "a.txt:1:github-pat", "a.txt:1:github-pat"],
    })
    expect(accepted!.facts[0]).toEqual({ label: "Accepted findings", value: "a.txt:1:github-pat, b.txt:1:github-pat" })

    const unmatched = await describeCreate(repo, { message: "feat: add a", accept_findings: ["c.txt:1:github-pat"] })
    expect(unmatched!.facts.map((fact) => fact.label)).toEqual(["Branch", "Files", "Lines"])
  })

  test("gives no description when the call would fail before it commits", async () => {
    const repo = await fixture()
    expect(await describeCreate(repo, { message: "feat: add a" })).toBeUndefined()

    await stage(repo, "a.txt", "a\n")
    expect(await describeCreate(repo, { message: "feat: add a", fixup: "HEAD" })).toBeUndefined()
    expect(await describeCreate(repo, {})).toBeUndefined()
    expect(await describeCreate(repo, { message: " \n\n" })).toBeUndefined()
  })

  test("gives no description for a fixup of a commit that is not on the branch", async () => {
    const repo = await fixture()
    await repo.git(["checkout", "-b", "other"])
    const elsewhere = await repo.commit("feat: elsewhere", { "c.txt": "c\n" })
    await repo.git(["checkout", "main"])
    await stage(repo, "a.txt", "a\n")

    expect(await describeCreate(repo, { fixup: elsewhere })).toBeUndefined()
  })

  test("gives an equal description for the same state, and a new index pin for other staged content", async () => {
    const repo = await fixture()
    await stage(repo, "a.txt", "one\n")
    const first = await describeCreate(repo, { message: "feat: add a" })
    expect(await describeCreate(repo, { message: "feat: add a" })).toEqual(first)

    await stage(repo, "a.txt", "two\n")
    const second = await describeCreate(repo, { message: "feat: add a" })
    expect(second!.pins!.index).not.toBe(first!.pins!.index)
    expect({ ...second, pins: undefined }).toEqual({ ...first, pins: undefined })
  })

  test("pins an empty head for an unborn repository", async () => {
    const repo = await tempRepo({ initialCommit: false })
    repos.push(repo)
    await stage(repo, "a.txt", "a\n")

    const description = await describeCreate(repo, { message: "feat: add a" })

    expect(description!.pins!.head).toBe("")
  })

  test("describes without writing to the repository", async () => {
    const repo = await fixture()
    await stage(repo, "a.txt", `id ${PREFIXED["github-pat"]}\n`)
    const state = async () => [
      await repo.git(["status", "--porcelain"]),
      await repo.git(["count-objects", "-v"]),
      await repo.git(["ls-files", "--stage"]),
    ]
    const before = await state()

    await describeCreate(repo, { message: "feat: add a", accept_findings: ["a.txt:1:github-pat"] })
    await describeCreate(repo, { fixup: "HEAD" })

    expect(await state()).toEqual(before)
  })
})
