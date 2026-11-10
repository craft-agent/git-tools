import { afterEach, describe, expect, test } from "bun:test"
import { installFakeGh, type FakeGh } from "../../testing/fake-gh"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { invoke } from "../tool"
import { commitRead } from "./read"

const repos: TempRepo[] = []
const fakes: FakeGh[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
  for (const fake of fakes.splice(0)) fake.restore()
})

/** A repository on branch `feat` with two commits of its own; returns their ids. */
async function fixture() {
  const repo = await tempRepo()
  repos.push(repo)
  await repo.git(["switch", "-c", "feat"])
  const one = await repo.commit("feat: one", { "one.txt": "1\n" })
  const two = await repo.commit("feat: two", { "two.txt": "2\n" })
  return { repo, one, two }
}

const amend = (repo: TempRepo, args: { sha?: string } = {}) =>
  invoke(commitRead, { method: "amend", ...args }, { cwd: repo.dir }).then((result) => result.amend!)

describe("git_commit_read amend", () => {
  test("recommends amend for HEAD, which defaults when no sha is given", async () => {
    const { repo, two } = await fixture()
    const result = await amend(repo)
    expect(result).toMatchObject({
      sha: two,
      is_head: true,
      on_branch: true,
      pushed: false,
      remote_branches: [],
      recommendation: "amend",
      needs_force_push: false,
      refusals: [],
      warnings: [],
    })
    expect(result.reason).toContain("git_commit_amend")
    expect(result.reason).not.toContain("force-push")
  })

  test("recommends fixup for an earlier commit, naming it", async () => {
    const { repo, one } = await fixture()
    const result = await amend(repo, { sha: "HEAD~1" })
    expect(result).toMatchObject({ sha: one, is_head: false, on_branch: true, recommendation: "fixup" })
    expect(result.reason).toContain(`fixup: ${one.slice(0, 12)}`)
    expect(result.reason).toContain("autosquash rebase")
  })

  test("adds the force push once the branch is pushed", async () => {
    const { repo } = await fixture()
    await repo.git(["push", "-u", "origin", "feat"])
    const head = await amend(repo)
    expect(head).toMatchObject({
      recommendation: "amend",
      pushed: true,
      remote_branches: ["origin/feat"],
      needs_force_push: true,
      refusals: [],
    })
    expect(head.reason).toContain("force-push the branch with a lease")
    expect((await amend(repo, { sha: "HEAD~1" })).reason).toContain("force-push the branch with a lease")
  })

  test("recommends a new commit on the default branch", async () => {
    const repo = await tempRepo()
    repos.push(repo)
    await repo.commit("fix: local on main", { "a.txt": "a\n" })
    const result = await amend(repo)
    expect(result).toMatchObject({ recommendation: "new_commit", pushed: false })
    expect(result.refusals[0]).toMatchObject({ rule: "default_branch" })
    expect(result.reason).toBe(result.refusals.map((refusal) => refusal.message).join(" "))
  })

  test("recommends a new commit when GitHub protects the pushed branch against force pushes", async () => {
    const gh = installFakeGh([
      {
        match: "api graphql",
        stdout: JSON.stringify({
          data: { repository: { ref: { refUpdateRule: null, rules: { nodes: [{ type: "NON_FAST_FORWARD" }] } } } },
        }),
      },
    ])
    fakes.push(gh)
    const { repo } = await fixture()
    await repo.git(["push", "-u", "origin", "feat"])
    await repo.git(["config", "remote.origin.url", "https://github.com/o/r.git"])
    const result = await amend(repo)
    expect(result).toMatchObject({ recommendation: "new_commit", needs_force_push: true })
    expect(result.refusals).toEqual([{ rule: "protected", message: expect.stringContaining("origin/feat cannot be") }])
    expect(result.reason).toContain("a ruleset blocks force pushes")
  })

  test("recommends a new commit for one already merged into the default branch", async () => {
    const { repo } = await fixture()
    const result = await amend(repo, { sha: "main" })
    expect(result).toMatchObject({ recommendation: "new_commit", pushed: true, remote_branches: ["origin/main"] })
    expect(result.refusals[0]).toMatchObject({ rule: "merged" })
  })

  test("recommends a new commit for one another remote branch holds", async () => {
    const { repo } = await fixture()
    await repo.git(["push", "origin", "feat:someone-else"])
    const result = await amend(repo)
    expect(result.recommendation).toBe("new_commit")
    expect(result.refusals[0]).toMatchObject({ rule: "shared" })
    expect(result.reason).toContain("origin/someone-else")
  })

  test("recommends a new commit, without running the rule, for a commit of another branch", async () => {
    const { repo } = await fixture()
    await repo.git(["switch", "-c", "elsewhere", "main"])
    const other = await repo.commit("feat: elsewhere", { "other.txt": "o\n" })
    await repo.git(["switch", "feat"])
    const result = await amend(repo, { sha: other })
    expect(result).toMatchObject({
      sha: other,
      is_head: false,
      on_branch: false,
      recommendation: "new_commit",
      needs_force_push: false,
      refusals: [],
      warnings: [],
    })
    expect(result.reason).toContain("is not on this branch")
  })

  test("lists at most twenty remote branches", async () => {
    const { repo } = await fixture()
    await repo.git(["push", "origin", ...Array.from({ length: 22 }, (_, i) => `feat:copy-${i}`)])
    const result = await amend(repo)
    expect(result.pushed).toBe(true)
    expect(result.remote_branches).toHaveLength(20)
  })

  test("throws not_found for an unknown sha", async () => {
    const { repo } = await fixture()
    await expect(amend(repo, { sha: "no-such-commit" })).rejects.toMatchObject({ code: "not_found" })
  })

  test("refuses an argument of another method", async () => {
    const { repo } = await fixture()
    await expect(invoke(commitRead, { method: "amend", message: "feat: x" }, { cwd: repo.dir })).rejects.toMatchObject({
      code: "invalid_argument",
    })
  })
})
