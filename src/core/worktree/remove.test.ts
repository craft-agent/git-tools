import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, rmSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { git } from "../git"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import {
  addTaskWorktree,
  branchExists,
  commitIn,
  pushFromAnotherClone,
  REMOTE_REPOSITORY,
  removeIn,
  revision,
  worktreeContext,
  worktreeRootOf,
} from "../../testing/worktree-fixtures"
import { writeTargets } from "../targets"
import { annotations, invoke } from "../tool"
import { worktreeRemove } from "./remove"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

async function open(options?: Parameters<typeof tempRepo>[0]): Promise<TempRepo> {
  const repo = await tempRepo(options)
  repos.push(repo)
  return repo
}

/** The folder of the repository under the test's worktree root, where the layout puts its worktrees. */
const layoutFolder = (repo: TempRepo) => join(worktreeRootOf(repo), REMOTE_REPOSITORY)

describe("git_worktree_remove", () => {
  test("is an overwrite tool of the worktree toolset that reaches the network", () => {
    const hints = annotations(worktreeRemove)
    expect(hints.readOnlyHint).toBe(false)
    expect(hints.destructiveHint).toBe(true)
    expect(hints.idempotentHint).toBe(true)
    expect(hints.openWorldHint).toBe(true)
    expect(worktreeRemove.toolset).toBe("worktree")
    expect(Object.keys(worktreeRemove.input.shape)).toEqual(["directory"])
  })

  test("names the worktree's real path as its target, however it is spelled", async () => {
    const repo = await open()
    const directory = await addTaskWorktree(repo, "task/x")
    const context = worktreeContext(repo)

    expect(await writeTargets(worktreeRemove, { directory }, context)).toEqual([directory])
    expect(await writeTargets(worktreeRemove, { directory: relative(repo.dir, directory) }, context)).toEqual([
      directory,
    ])
    expect(await writeTargets(worktreeRemove, { directory: "  " }, context)).toEqual(["*"])
  })

  test("never takes a force argument", async () => {
    const repo = await open()
    const directory = await addTaskWorktree(repo, "task/x")

    const call = invoke(worktreeRemove, { directory, force: true }, worktreeContext(repo))

    await expect(call).rejects.toMatchObject({ code: "invalid_argument" })
    expect(existsSync(directory)).toBe(true)
  })

  test("removes a merged worktree, deletes its branch by ancestry and drops the empty layout folder", async () => {
    const repo = await open()
    const directory = await addTaskWorktree(repo, "task/a")
    await commitIn(directory, "work", { "a.txt": "a\n" })
    await git(["push", "origin", "task/a:main"], { cwd: directory })

    const removed = await removeIn(repo, directory)

    expect(removed).toEqual({
      directory,
      branch: "task/a",
      pruned: false,
      branch_deleted: true,
      landed: { by: "ancestry", into: "origin/main" },
      kept_because: null,
      warnings: [],
    })
    expect(existsSync(directory)).toBe(false)
    expect(await branchExists(repo, "task/a")).toBe(false)
    expect(existsSync(layoutFolder(repo))).toBe(false)
    expect(existsSync(worktreeRootOf(repo))).toBe(true)
  })

  test("deletes a branch that was just created, since its tip is in the default branch", async () => {
    const repo = await open()
    const directory = await addTaskWorktree(repo, "task/empty")

    const removed = await removeIn(repo, directory)

    expect(removed).toMatchObject({ branch_deleted: true, landed: { by: "ancestry", into: "origin/main" } })
    expect(await branchExists(repo, "task/empty")).toBe(false)
  })

  test("keeps a branch with a commit nothing holds, and says it has not landed", async () => {
    const repo = await open()
    const directory = await addTaskWorktree(repo, "task/a")
    const tip = await commitIn(directory, "unmerged", { "a.txt": "a\n" })

    const removed = await removeIn(repo, directory)

    expect(removed).toEqual({
      directory,
      branch: "task/a",
      pruned: false,
      branch_deleted: false,
      landed: null,
      kept_because: "not_landed",
      warnings: [],
    })
    expect(existsSync(directory)).toBe(false)
    expect(await revision(repo, "task/a")).toBe(tip)
  })

  test("fetches origin first: a branch merged there after the last fetch has landed", async () => {
    const repo = await open()
    const directory = await addTaskWorktree(repo, "task/a")
    const lastFetched = await revision(repo, "origin/main")
    const tip = await commitIn(directory, "work", { "a.txt": "a\n" })
    await git(["push", repo.remote!, "task/a:main"], { cwd: directory })
    // Some git versions move origin/main on a push to its path; put it back as of the last fetch.
    await repo.git(["update-ref", "refs/remotes/origin/main", lastFetched])
    expect(await revision(repo, "origin/main")).not.toBe(tip)

    const removed = await removeIn(repo, directory)

    expect(removed).toMatchObject({ branch_deleted: true, landed: { by: "ancestry", into: "origin/main" } })
    expect(await revision(repo, "origin/main")).toBe(tip)
  })

  test("warns, and goes by the last fetch, when fetching origin fails", async () => {
    const repo = await open()
    const directory = await addTaskWorktree(repo, "task/a")
    await commitIn(directory, "unmerged", { "a.txt": "a\n" })
    await repo.git(["remote", "set-url", "origin", join(repo.home, "nowhere.git")])

    const removed = await removeIn(repo, directory)

    expect(removed.kept_because).toBe("not_landed")
    expect(removed.warnings).toEqual(["fetching origin failed: origin/main is as of the last fetch"])
    expect(existsSync(directory)).toBe(false)
  })

  test("goes by what origin has now: a branch the default branch moved past counts as landed", async () => {
    const repo = await open()
    const directory = await addTaskWorktree(repo, "task/a")
    await pushFromAnotherClone(repo, "pushed meanwhile")

    const removed = await removeIn(repo, directory)

    expect(removed).toMatchObject({ branch_deleted: true, landed: { by: "ancestry", into: "origin/main" } })
  })

  test("keeps the layout folder while another worktree is in it", async () => {
    const repo = await open()
    const first = await addTaskWorktree(repo, "task/a")
    const second = await addTaskWorktree(repo, "task/b")

    await removeIn(repo, first)

    expect(existsSync(second)).toBe(true)
    expect(existsSync(layoutFolder(repo))).toBe(true)
  })

  test("does not touch a folder that is not the layout's, even when it is left empty", async () => {
    const repo = await open()
    const directory = join(repo.home, "elsewhere", "wt")
    await repo.git(["worktree", "add", "-b", "task/x", directory])

    await removeIn(repo, directory)

    expect(existsSync(join(repo.home, "elsewhere"))).toBe(true)
  })

  test("is not stopped by ignored files, which go with the directory", async () => {
    const repo = await open()
    await repo.commit("ignore logs", { ".gitignore": "*.log\n" })
    await repo.git(["push", "origin", "main"])
    const directory = await addTaskWorktree(repo, "task/a")
    writeFileSync(join(directory, "debug.log"), "noise\n")

    const removed = await removeIn(repo, directory)

    expect(removed.directory).toBe(directory)
    expect(existsSync(directory)).toBe(false)
  })

  test("takes a directory relative to the working tree of the call", async () => {
    const repo = await open()
    const directory = await addTaskWorktree(repo, "task/a")

    const removed = await removeIn(repo, relative(repo.dir, directory))

    expect(removed.directory).toBe(directory)
    expect(existsSync(directory)).toBe(false)
  })

  test("prunes a worktree whose directory is gone, and settles its branch", async () => {
    const repo = await open()
    const gone = await addTaskWorktree(repo, "task/gone")
    const kept = await addTaskWorktree(repo, "task/kept")
    await commitIn(kept, "unmerged", { "k.txt": "k\n" })
    rmSync(gone, { recursive: true })

    const removed = await removeIn(repo, gone)

    expect(removed).toEqual({
      directory: gone,
      branch: "task/gone",
      pruned: true,
      branch_deleted: true,
      landed: { by: "ancestry", into: "origin/main" },
      kept_because: null,
      warnings: [],
    })
    expect(await repo.git(["worktree", "list", "--porcelain"])).not.toContain(gone)
    expect(existsSync(kept)).toBe(true)
  })

  test("prunes a gone worktree whose branch has not landed, and keeps the branch", async () => {
    const repo = await open()
    const directory = await addTaskWorktree(repo, "task/a")
    await commitIn(directory, "unmerged", { "a.txt": "a\n" })
    rmSync(directory, { recursive: true })

    const removed = await removeIn(repo, directory)

    expect(removed).toMatchObject({ pruned: true, branch_deleted: false, kept_because: "not_landed" })
    expect(await branchExists(repo, "task/a")).toBe(true)
    expect(existsSync(layoutFolder(repo))).toBe(false)
  })
})
