import { afterEach, describe, expect, test } from "bun:test"
import { installFakeGh, type FakeGh, type GhRule } from "../../testing/fake-gh"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { asGithubRemote } from "../../testing/push-fixtures"
import { addTaskWorktree, branchExists, commitIn, removeIn } from "../../testing/worktree-fixtures"

const repos: TempRepo[] = []
const fakes: FakeGh[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
  for (const fake of fakes.splice(0)) fake.restore()
})

/** A repository whose origin reads as `o/r` on GitHub. */
async function onGithub(): Promise<TempRepo> {
  const repo = await tempRepo()
  repos.push(repo)
  await asGithubRemote(repo)
  return repo
}

/** Puts a fake `gh` on `PATH` that answers with `rule`. */
function answering(rule: GhRule): FakeGh {
  const fake = installFakeGh([rule])
  fakes.push(fake)
  return fake
}

/** The reply of GitHub's merged pull requests of a branch, with `nodes` as they are. */
function mergedPullRequests(...nodes: unknown[]): GhRule {
  return { match: "api graphql", stdout: JSON.stringify({ data: { repository: { pullRequests: { nodes } } } }) }
}

/** A merged pull request whose head commit is `sha` and whose head repository is `repository` (null once deleted). */
function pullRequest(number: number, sha: string, repository: string | null = "o/r", extra = {}) {
  return {
    number,
    headRefOid: sha,
    headRepository: repository === null ? null : { nameWithOwner: repository },
    ...extra,
  }
}

/** A worktree of `task/a` with a commit of its own, which no ancestry proves landed; returns the worktree and the commit. */
async function unmerged(repo: TempRepo): Promise<{ directory: string; tip: string }> {
  const directory = await addTaskWorktree(repo, "task/a")
  return { directory, tip: await commitIn(directory, "squashed away", { "a.txt": "a\n" }) }
}

describe("git_worktree_remove on a GitHub origin", () => {
  test("deletes a squash-merged branch: a merged pull request of this repository has its tip as head", async () => {
    const repo = await onGithub()
    const { directory, tip } = await unmerged(repo)
    const fake = answering(mergedPullRequests(pullRequest(7, tip)))

    const removed = await removeIn(repo, directory)

    expect(removed).toMatchObject({
      branch: "task/a",
      branch_deleted: true,
      landed: { by: "pull_request", number: 7 },
      kept_because: null,
      warnings: [],
    })
    expect(await branchExists(repo, "task/a")).toBe(false)
    const calls = fake.calls()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain("owner=o")
    expect(calls[0]).toContain("name=r")
    expect(calls[0]).toContain("branch=task/a")
    expect(calls[0]!.join(" ")).toContain("states: MERGED")
  })

  test("compares the repository's name without regard to case", async () => {
    const repo = await onGithub()
    const { directory, tip } = await unmerged(repo)
    answering(mergedPullRequests(pullRequest(3, tip, "O/R")))

    const removed = await removeIn(repo, directory)

    expect(removed.landed).toEqual({ by: "pull_request", number: 3 })
  })

  test("counts a lower layer merged into the layer below it, whatever the base", async () => {
    const repo = await onGithub()
    const { directory, tip } = await unmerged(repo)
    answering(mergedPullRequests(pullRequest(9, tip, "o/r", { baseRefName: "task/b" })))

    const removed = await removeIn(repo, directory)

    expect(removed).toMatchObject({ branch_deleted: true, landed: { by: "pull_request", number: 9 } })
  })

  test("keeps a branch whose merged pull requests had another head commit, came from a fork or lost their head repository", async () => {
    const repo = await onGithub()
    const { directory, tip } = await unmerged(repo)
    const older = "0".repeat(tip.length)
    answering(mergedPullRequests(pullRequest(1, older), pullRequest(2, tip, "fork/r"), pullRequest(3, tip, null), null))

    const removed = await removeIn(repo, directory)

    expect(removed).toMatchObject({ branch_deleted: false, landed: null, kept_because: "not_landed", warnings: [] })
    expect(await branchExists(repo, "task/a")).toBe(true)
  })

  test("keeps the branch, with a warning, when gh fails", async () => {
    const repo = await onGithub()
    const { directory } = await unmerged(repo)
    answering({ match: "api graphql", stderr: "boom", code: 1 })

    const removed = await removeIn(repo, directory)

    expect(removed).toMatchObject({ branch_deleted: false, landed: null, kept_because: "not_landed" })
    expect(removed.warnings).toEqual([
      "could not read GitHub's pull requests for task/a: gh failed (exit 1): boom; the branch stays",
    ])
    expect(await branchExists(repo, "task/a")).toBe(true)
  })

  test("keeps the branch, with a warning, when GitHub has no such repository", async () => {
    const repo = await onGithub()
    const { directory } = await unmerged(repo)
    answering({ match: "api graphql", stdout: JSON.stringify({ data: { repository: null } }) })

    const removed = await removeIn(repo, directory)

    expect(removed.kept_because).toBe("not_landed")
    expect(removed.warnings).toEqual([
      "could not read GitHub's pull requests for task/a: o/r is not on GitHub; the branch stays",
    ])
  })

  test("does not ask GitHub when ancestry already proves the branch landed", async () => {
    const repo = await onGithub()
    const directory = await addTaskWorktree(repo, "task/empty")
    const fake = answering(mergedPullRequests())

    const removed = await removeIn(repo, directory)

    expect(removed.landed).toEqual({ by: "ancestry", into: "origin/main" })
    expect(fake.calls()).toEqual([])
  })

  test("never calls gh when origin is not on GitHub", async () => {
    const repo = await tempRepo()
    repos.push(repo)
    const { directory, tip } = await unmerged(repo)
    const fake = answering(mergedPullRequests(pullRequest(7, tip)))

    const removed = await removeIn(repo, directory)

    expect(removed).toMatchObject({ branch_deleted: false, kept_because: "not_landed", warnings: [] })
    expect(fake.calls()).toEqual([])
  })
})
