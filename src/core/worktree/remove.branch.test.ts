import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import {
  addTaskWorktree,
  branchExists,
  commitIn,
  layoutDirectory,
  REMOTE_REPOSITORY,
  removeIn,
  revision,
  worktreeRootOf,
} from "../../testing/worktree-fixtures"
import { planRemove, type RemoveRequest } from "./remove-plan"
import { removePlanned } from "./remove-run"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

async function open(options?: Parameters<typeof tempRepo>[0]): Promise<TempRepo> {
  const repo = await tempRepo(options)
  repos.push(repo)
  return repo
}

describe("git_worktree_remove and the branch", () => {
  test("removes a detached worktree and has no branch to settle", async () => {
    const repo = await open()
    const directory = layoutDirectory(repo, REMOTE_REPOSITORY, "detached")
    await repo.git(["worktree", "add", "--detach", directory])

    const removed = await removeIn(repo, directory)

    expect(removed).toEqual({
      directory,
      branch: null,
      pruned: false,
      branch_deleted: false,
      landed: null,
      kept_because: "detached",
      warnings: [],
    })
    expect(existsSync(directory)).toBe(false)
  })

  test("never deletes the default branch, even though it has landed", async () => {
    const repo = await open()
    await repo.git(["switch", "-c", "other"])
    const directory = layoutDirectory(repo, REMOTE_REPOSITORY, "main")
    await repo.git(["worktree", "add", directory, "main"])

    const removed = await removeIn(repo, directory)

    expect(removed).toMatchObject({
      branch: "main",
      branch_deleted: false,
      landed: null,
      kept_because: "default_branch",
    })
    expect(await branchExists(repo, "main")).toBe(true)
  })

  test("never deletes the branch origin names as its default, whatever it is called", async () => {
    const repo = await open()
    await repo.git(["push", "origin", "main:release"])
    await repo.git(["fetch", "origin"])
    await repo.git(["remote", "set-head", "origin", "release"])
    const directory = layoutDirectory(repo, REMOTE_REPOSITORY, "release")
    await repo.git(["worktree", "add", "-b", "release", directory])

    const removed = await removeIn(repo, directory)

    expect(removed).toMatchObject({ branch: "release", kept_because: "default_branch" })
    expect(await branchExists(repo, "release")).toBe(true)
  })

  test("takes main and master for the default branch when there is no origin", async () => {
    const repo = await open({ remote: false })
    const directory = join(repo.home, "master-tree")
    await repo.git(["worktree", "add", "-b", "master", directory])

    const removed = await removeIn(repo, directory)

    expect(removed).toMatchObject({ branch: "master", kept_because: "default_branch" })
    expect(await branchExists(repo, "master")).toBe(true)
  })

  test("has nothing to prove a branch landed against without an origin, so it stays", async () => {
    const repo = await open({ remote: false })
    const directory = await addTaskWorktree(repo, "task/a")

    const removed = await removeIn(repo, directory)

    expect(removed).toMatchObject({ branch_deleted: false, landed: null, kept_because: "not_landed", warnings: [] })
    expect(existsSync(directory)).toBe(false)
    expect(await branchExists(repo, "task/a")).toBe(true)
  })

  test("keeps a branch another worktree still has checked out", async () => {
    const repo = await open()
    const directory = await addTaskWorktree(repo, "task/a")
    const other = join(repo.home, "second-checkout")
    await repo.git(["worktree", "add", "--force", other, "task/a"])

    const removed = await removeIn(repo, directory)

    expect(removed).toMatchObject({
      branch: "task/a",
      branch_deleted: false,
      landed: null,
      kept_because: "checked_out",
    })
    expect(existsSync(other)).toBe(true)
    expect(await branchExists(repo, "task/a")).toBe(true)
  })

  test("keeps a landed branch git refuses to delete, with git's reason as a warning", async () => {
    const repo = await open()
    const directory = await addTaskWorktree(repo, "task/a")
    writeFileSync(join(repo.dir, ".git", "refs", "heads", "task", "a.lock"), "")

    const removed = await removeIn(repo, directory)

    expect(removed.branch_deleted).toBe(false)
    expect(removed.kept_because).toBe("delete_failed")
    expect(removed.landed).toEqual({ by: "ancestry", into: "origin/main" })
    expect(removed.warnings).toHaveLength(1)
    expect(removed.warnings[0]).toStartWith("could not delete task/a: git update-ref failed")
  })

  test("deletes a landed branch", async () => {
    const repo = await open()
    const directory = await addTaskWorktree(repo, "task/a")

    const removed = await removeIn(repo, directory)

    expect(removed).toMatchObject({ branch_deleted: true, kept_because: null })
    expect(await branchExists(repo, "task/a")).toBe(false)
  })

  test("keeps a landed branch that moved before the deletion, with its newer commit", async () => {
    const repo = await open()
    const directory = await addTaskWorktree(repo, "task/a")
    const request: RemoveRequest = {
      callerRoot: repo.dir,
      worktreeRoot: worktreeRootOf(repo),
      directory,
    }
    const plan = await planRemove(request)
    const newer = await commitIn(directory, "newer", { "newer.txt": "x" })

    const removed = await removePlanned(request, plan)

    expect(removed).toMatchObject({ branch_deleted: false, kept_because: "moved" })
    expect(await revision(repo, "task/a")).toBe(newer)
  })
})
