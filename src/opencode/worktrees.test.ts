import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { WORKTREE_ROOT_OPTION } from "../core/worktree/layout"
import { tempRepo, type TempRepo } from "../testing/git-repo"
import {
  branchExists,
  commitIn,
  layoutDirectory,
  REMOTE_REPOSITORY,
  worktreeRootOf,
} from "../testing/worktree-fixtures"
import { tempDir } from "./testing"
import { FakeOperationError, setUpWorktrees, strategyOf } from "./worktrees.testing"

const repos: TempRepo[] = []
const cleanups: (() => void)[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
  for (const cleanup of cleanups.splice(0)) cleanup()
})

async function open(): Promise<TempRepo> {
  const repo = await tempRepo()
  repos.push(repo)
  return repo
}

/** The folder OpenCode would suggest for a worktree named `name`: not where the layout puts it. */
const suggested = (repo: TempRepo, name: string) => join(repo.home, "opencode-worktrees", name)

describe("the worktree strategy: create", () => {
  test("takes the suggested folder's name as the branch and places the worktree by the layout", async () => {
    const repo = await open()
    const strategy = strategyOf(await setUpWorktrees(repo))

    const created = await strategy.create({ sourceDirectory: repo.dir, directory: suggested(repo, "bright-owl") })

    expect(created).toEqual({ directory: layoutDirectory(repo, REMOTE_REPOSITORY, "bright-owl") })
    expect(existsSync(created.directory)).toBe(true)
    expect(existsSync(suggested(repo, "bright-owl"))).toBe(false)
    expect((await repo.git(["-C", created.directory, "branch", "--show-current"])).trim()).toBe("bright-owl")
  })

  test("starts a new branch at the ref the harness passes as its branch", async () => {
    const repo = await open()
    await repo.git(["checkout", "-b", "base"])
    await repo.commit("on base", { "base.txt": "base" })
    await repo.git(["checkout", "main"])
    const strategy = strategyOf(await setUpWorktrees(repo))

    const { directory } = await strategy.create({
      sourceDirectory: repo.dir,
      directory: suggested(repo, "calm-fox"),
      branch: "base",
    })

    expect(existsSync(join(directory, "base.txt"))).toBe(true)
  })

  test("lets a refusal reach the caller with its message", async () => {
    const repo = await open()
    const strategy = strategyOf(await setUpWorktrees(repo))
    const input = { sourceDirectory: repo.dir, directory: suggested(repo, "twin") }
    await strategy.create(input)

    await expect(strategy.create(input)).rejects.toMatchObject({ code: "invalid_argument" })
  })

  test("fails outside a repository", async () => {
    const repo = await open()
    const strategy = strategyOf(await setUpWorktrees(repo))

    const call = strategy.create({ sourceDirectory: tempDir(cleanups), directory: suggested(repo, "lost") })

    await expect(call).rejects.toMatchObject({ code: "not_a_repository" })
  })
})

describe("the worktree strategy: list", () => {
  test("lists the main working tree first, then the live worktrees of the layout", async () => {
    const repo = await open()
    const strategy = strategyOf(await setUpWorktrees(repo))
    const { directory } = await strategy.create({ sourceDirectory: repo.dir, directory: suggested(repo, "live") })

    expect(await strategy.list(repo.dir)).toEqual([
      { directory: repo.dir, type: "root" },
      { directory, type: "worktree" },
    ])
    expect(await strategy.list(directory)).toEqual([
      { directory: repo.dir, type: "root" },
      { directory, type: "worktree" },
    ])
  })

  test("leaves out a worktree outside the layout and one whose directory is gone", async () => {
    const repo = await open()
    const strategy = strategyOf(await setUpWorktrees(repo))
    const live = await strategy.create({ sourceDirectory: repo.dir, directory: suggested(repo, "live") })
    const gone = await strategy.create({ sourceDirectory: repo.dir, directory: suggested(repo, "gone") })
    await repo.git(["worktree", "add", "-b", "outside", join(repo.home, "elsewhere")])
    rmSync(gone.directory, { recursive: true })

    expect(await strategy.list(repo.dir)).toEqual([
      { directory: repo.dir, type: "root" },
      { directory: live.directory, type: "worktree" },
    ])
  })

  test("follows the worktree_root option", async () => {
    const repo = await open()
    const strategy = strategyOf(await setUpWorktrees(repo))
    const { directory } = await strategy.create({ sourceDirectory: repo.dir, directory: suggested(repo, "moved") })
    const otherRoot = strategyOf(
      await setUpWorktrees(repo, {
        options: { toolsets: ["worktree"], [WORKTREE_ROOT_OPTION]: join(repo.home, "other-root") },
      }),
    )

    expect(directory.startsWith(worktreeRootOf(repo))).toBe(true)
    expect(await otherRoot.list(repo.dir)).toEqual([{ directory: repo.dir, type: "root" }])
  })

  test("is empty outside a repository, or in a directory that does not exist", async () => {
    const repo = await open()
    const strategy = strategyOf(await setUpWorktrees(repo))

    expect(await strategy.list(tempDir(cleanups))).toEqual([])
    expect(await strategy.list(join(repo.home, "no-such-directory"))).toEqual([])
  })
})

describe("the worktree strategy: remove", () => {
  test("removes a clean worktree and deletes its landed branch", async () => {
    const repo = await open()
    const strategy = strategyOf(await setUpWorktrees(repo))
    const { directory } = await strategy.create({ sourceDirectory: repo.dir, directory: suggested(repo, "done") })

    await strategy.remove({ directory, force: false })

    expect(existsSync(directory)).toBe(false)
    expect(await branchExists(repo, "done")).toBe(false)
    expect(await strategy.list(repo.dir)).toEqual([{ directory: repo.dir, type: "root" }])
  })

  test("asks for a force when files changed, and removes the worktree once forced", async () => {
    const repo = await open()
    const strategy = strategyOf(
      await setUpWorktrees(repo, {}, { worktreeOperationError: async () => FakeOperationError }),
    )
    const { directory } = await strategy.create({ sourceDirectory: repo.dir, directory: suggested(repo, "dirty") })
    writeFileSync(join(directory, "notes.txt"), "unsaved")

    const refusal = await strategy.remove({ directory, force: false }).catch((error: unknown) => error)

    expect(refusal).toBeInstanceOf(FakeOperationError)
    expect(refusal).toMatchObject({ forceRequired: true, message: expect.stringContaining("uncommitted changes") })
    expect(existsSync(directory)).toBe(true)

    await strategy.remove({ directory, force: true })

    expect(existsSync(directory)).toBe(false)
  })

  test("raises the tool's own refusal when the harness has no such error class", async () => {
    const repo = await open()
    const withSeam = strategyOf(await setUpWorktrees(repo, {}, { worktreeOperationError: async () => undefined }))
    const withImport = strategyOf(await setUpWorktrees(repo))
    const { directory } = await withSeam.create({ sourceDirectory: repo.dir, directory: suggested(repo, "dirty") })
    writeFileSync(join(directory, "notes.txt"), "unsaved")

    for (const strategy of [withSeam, withImport]) {
      await expect(strategy.remove({ directory, force: false })).rejects.toMatchObject({
        code: "dirty_tree",
        details: { files: [{ status: "??", path: "notes.txt" }] },
      })
    }
    expect(existsSync(directory)).toBe(true)
  })

  test("refuses commits no branch holds as the tool does, with no force to offer", async () => {
    const repo = await open()
    const strategy = strategyOf(
      await setUpWorktrees(repo, {}, { worktreeOperationError: async () => FakeOperationError }),
    )
    const { directory } = await strategy.create({ sourceDirectory: repo.dir, directory: suggested(repo, "adrift") })
    await repo.git(["-C", directory, "checkout", "--detach"])
    await commitIn(directory, "adrift", { "adrift.txt": "work" })

    const refusal = await strategy.remove({ directory, force: false }).catch((error: unknown) => error)

    expect(refusal).not.toBeInstanceOf(FakeOperationError)
    expect(refusal).toMatchObject({ code: "dirty_tree", details: { commits_total: 1 } })
    await expect(strategy.remove({ directory, force: true })).rejects.toMatchObject({ code: "dirty_tree" })
    expect(existsSync(directory)).toBe(true)
  })

  test("lets other refusals through, such as the main working tree", async () => {
    const repo = await open()
    const strategy = strategyOf(
      await setUpWorktrees(repo, {}, { worktreeOperationError: async () => FakeOperationError }),
    )

    await expect(strategy.remove({ directory: repo.dir, force: false })).rejects.toMatchObject({
      code: "invalid_argument",
    })
  })

  test("finds nothing to do for a directory that is already gone", async () => {
    const repo = await open()
    const strategy = strategyOf(await setUpWorktrees(repo))

    await strategy.remove({ directory: join(repo.home, "no-such-directory"), force: false })
  })
})
