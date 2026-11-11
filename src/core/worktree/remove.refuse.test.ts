import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { git, gitResult } from "../git"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import {
  addTaskWorktree,
  branchExists,
  commitIn,
  layoutDirectory,
  REMOTE_REPOSITORY,
  repositoryState,
  worktreeContext,
  worktreeRootOf,
} from "../../testing/worktree-fixtures"
import { ToolError, type ErrorCode } from "../errors"
import { shortSha } from "../rewrite"
import { invoke, type ToolContext } from "../tool"
import { removeWorktree, worktreeRemove } from "./remove"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

async function open(options?: Parameters<typeof tempRepo>[0]): Promise<TempRepo> {
  const repo = await tempRepo(options)
  repos.push(repo)
  return repo
}

/** Refuses the call with `code`, leaving every ref, worktree and directory as it was; returns the error. */
async function expectRefused(
  repo: TempRepo,
  directory: string,
  code: ErrorCode,
  ctx: ToolContext = worktreeContext(repo),
): Promise<ToolError> {
  const before = await repositoryState(repo)
  const existed = existsSync(directory)
  const error = await invoke(worktreeRemove, { directory }, ctx).then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(ToolError)
  expect((error as ToolError).code).toBe(code)
  expect(await repositoryState(repo)).toBe(before)
  expect(existsSync(directory)).toBe(existed)
  return error as ToolError
}

/** A detached worktree in the layout, at the commit `main` is at. */
async function detachedWorktree(repo: TempRepo): Promise<string> {
  const directory = layoutDirectory(repo, REMOTE_REPOSITORY, "detached")
  await repo.git(["worktree", "add", "--detach", directory])
  return directory
}

describe("git_worktree_remove refusals", () => {
  test("refuses a directory that is no worktree of the repository", async () => {
    const repo = await open()
    const directory = await addTaskWorktree(repo, "task/a")
    const inside = join(directory, "sub")
    mkdirSync(inside)

    for (const path of [repo.home, join(repo.home, "missing"), inside]) {
      const error = await expectRefused(repo, path, "not_found")
      expect(error.message).toBe(`${path} is not a worktree of this repository.`)
    }
  })

  test("refuses a blank directory", async () => {
    const repo = await open()
    await expectRefused(repo, "  ", "invalid_argument")
  })

  test("refuses the main working tree", async () => {
    const repo = await open()
    const error = await expectRefused(repo, repo.dir, "invalid_argument")
    expect(error.message).toContain("main working tree")
  })

  test("refuses the worktree the call is made from, or from a folder inside it", async () => {
    const repo = await open()
    const directory = await addTaskWorktree(repo, "task/a")
    const inside = join(directory, "deep", "folder")
    mkdirSync(inside, { recursive: true })

    for (const cwd of [directory, inside]) {
      const error = await expectRefused(repo, directory, "invalid_argument", { ...worktreeContext(repo), cwd })
      expect(error.message).toContain("made from inside")
    }
  })

  test("refuses a locked worktree, giving git's reason and leaving the unlocking to the person", async () => {
    const repo = await open()
    const directory = await addTaskWorktree(repo, "task/a")
    await repo.git(["worktree", "lock", "--reason", "on a usb stick", directory])

    const error = await expectRefused(repo, directory, "invalid_argument")

    expect(error.message).toContain("is locked (on a usb stick)")
    expect(error.message).toContain("git worktree unlock")

    await repo.git(["worktree", "unlock", directory])
    await repo.git(["worktree", "lock", directory])
    expect((await expectRefused(repo, directory, "invalid_argument")).message).not.toContain("(")
  })

  test("refuses modified, staged and untracked files, listing them with their status", async () => {
    const repo = await open()
    const directory = await addTaskWorktree(repo, "task/a")
    writeFileSync(join(directory, "README.md"), "changed\n")
    writeFileSync(join(directory, "staged.txt"), "s\n")
    await git(["add", "staged.txt"], { cwd: directory })
    writeFileSync(join(directory, "loose.txt"), "l\n")

    const error = await expectRefused(repo, directory, "dirty_tree")

    expect(error.details).toEqual({
      files: [
        { status: " M", path: "README.md" },
        { status: "A ", path: "staged.txt" },
        { status: "??", path: "loose.txt" },
      ],
      files_total: 3,
    })
  })

  test("lists a rename once, and the files of an untracked folder one by one", async () => {
    const repo = await open()
    const directory = await addTaskWorktree(repo, "task/a")
    await git(["mv", "README.md", "MOVED.md"], { cwd: directory })
    mkdirSync(join(directory, "new"))
    writeFileSync(join(directory, "new", "one.txt"), "1\n")
    writeFileSync(join(directory, "new", "two.txt"), "2\n")

    const error = await expectRefused(repo, directory, "dirty_tree")

    expect(error.details).toEqual({
      files: [
        { status: "R ", path: "MOVED.md" },
        { status: "??", path: "new/one.txt" },
        { status: "??", path: "new/two.txt" },
      ],
      files_total: 3,
    })
  })

  test("lists at most 50 files and counts them all", async () => {
    const repo = await open()
    const directory = await addTaskWorktree(repo, "task/a")
    for (let index = 0; index < 55; index++) writeFileSync(join(directory, `f${index}.txt`), "x\n")

    const error = await expectRefused(repo, directory, "dirty_tree")

    expect((error.details!.files as unknown[]).length).toBe(50)
    expect(error.details!.files_total).toBe(55)
  })

  test("refuses a detached HEAD at commits nothing holds, listing them", async () => {
    const repo = await open()
    const directory = await detachedWorktree(repo)
    const tip = await commitIn(directory, "only here", { "x.txt": "x\n" })

    const error = await expectRefused(repo, directory, "dirty_tree")

    expect(error.details).toEqual({ commits: [{ sha: shortSha(tip), subject: "only here" }], commits_total: 1 })
  })

  test("lists at most 20 unheld commits and counts them all", async () => {
    const repo = await open()
    const directory = await detachedWorktree(repo)
    for (let index = 0; index < 22; index++) {
      await git(["commit", "--allow-empty", "-m", `c${index}`], { cwd: directory })
    }

    const error = await expectRefused(repo, directory, "dirty_tree")

    const commits = error.details!.commits as { subject: string }[]
    expect(commits).toHaveLength(20)
    expect(commits[0]!.subject).toBe("c21")
    expect(error.details!.commits_total).toBe(22)
  })

  test("lets a detached HEAD go once a branch or a tag holds its commits", async () => {
    const repo = await open()
    for (const hold of ["branch", "tag"]) {
      const directory = layoutDirectory(repo, REMOTE_REPOSITORY, `detached-${hold}`)
      await repo.git(["worktree", "add", "--detach", directory])
      await commitIn(directory, `held by a ${hold}`, { [`${hold}.txt`]: "x\n" })
      await git(hold === "branch" ? ["branch", `keep-${hold}`] : ["tag", `keep-${hold}`], { cwd: directory })

      const removed = await invoke(worktreeRemove, { directory }, worktreeContext(repo))

      expect(removed.kept_because, hold).toBe("detached")
      expect(existsSync(directory), hold).toBe(false)
    }
  })

  test("refuses a worktree with a rebase stopped in it, before looking at its files", async () => {
    const repo = await open()
    const directory = await addTaskWorktree(repo, "task/a")
    await commitIn(directory, "one", { "c.txt": "one\n" })
    await repo.commit("two", { "c.txt": "two\n" })
    expect((await gitResult(["rebase", "main"], { cwd: directory })).code).not.toBe(0)

    const error = await expectRefused(repo, directory, "operation_in_progress")

    expect(error.message).toContain("rebase is in progress")
  })
})

describe("removeWorktree with force", () => {
  const forced = (repo: TempRepo, directory: string) =>
    removeWorktree({ callerRoot: repo.dir, worktreeRoot: worktreeRootOf(repo), directory, force: true })

  test("removes a worktree with modified and untracked files, and still applies the landed rule", async () => {
    const repo = await open()
    const landed = await addTaskWorktree(repo, "task/landed")
    const unlanded = await addTaskWorktree(repo, "task/unlanded")
    await commitIn(unlanded, "unmerged", { "u.txt": "u\n" })
    for (const directory of [landed, unlanded]) {
      writeFileSync(join(directory, "README.md"), "changed\n")
      writeFileSync(join(directory, "loose.txt"), "l\n")
    }

    expect(await forced(repo, landed)).toMatchObject({ branch_deleted: true, landed: { by: "ancestry" } })
    expect(await forced(repo, unlanded)).toMatchObject({ branch_deleted: false, kept_because: "not_landed" })

    expect(existsSync(landed) || existsSync(unlanded)).toBe(false)
    expect(await branchExists(repo, "task/landed")).toBe(false)
    expect(await branchExists(repo, "task/unlanded")).toBe(true)
  })

  test("skips no other check: a locked worktree, the main one and unheld commits still refuse", async () => {
    const repo = await open()
    const locked = await addTaskWorktree(repo, "task/locked")
    await repo.git(["worktree", "lock", locked])
    const detached = await detachedWorktree(repo)
    await commitIn(detached, "only here", { "x.txt": "x\n" })

    await expect(forced(repo, locked)).rejects.toMatchObject({ code: "invalid_argument" })
    await expect(forced(repo, repo.dir)).rejects.toMatchObject({ code: "invalid_argument" })
    await expect(forced(repo, detached)).rejects.toMatchObject({ code: "dirty_tree" })
    expect(existsSync(locked) && existsSync(detached)).toBe(true)
  })

  test("refuses the directory the call is made from, which callerDirectory names", async () => {
    const repo = await open()
    const directory = await addTaskWorktree(repo, "task/a")

    const call = removeWorktree({
      callerRoot: repo.dir,
      callerDirectory: directory,
      worktreeRoot: worktreeRootOf(repo),
      directory,
      force: true,
    })

    await expect(call).rejects.toMatchObject({ code: "invalid_argument" })
    expect(existsSync(directory)).toBe(true)
  })
})
