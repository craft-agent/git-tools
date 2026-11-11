import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { ToolError } from "../errors"
import { annotations, invoke, type ToolContext } from "../tool"
import { worktreeRead } from "./read"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

async function open(): Promise<TempRepo> {
  const repo = await tempRepo()
  await repo.git(["remote", "set-url", "origin", "https://github.com/craft-agent/tools.git"])
  repos.push(repo)
  return repo
}

const list = (cwd: string, options?: ToolContext["options"]) =>
  invoke(worktreeRead, { method: "list" }, { cwd, options })

/** The worktrees of a listing by branch name; git does not list the linked ones in the order they were added. */
function byBranchName(listing: Awaited<ReturnType<typeof list>>) {
  return new Map(listing.worktrees.map((worktree) => [worktree.branch, worktree]))
}

describe("git_worktree_read", () => {
  test("is a read tool that stays on the machine", () => {
    const hints = annotations(worktreeRead)
    expect(hints.readOnlyHint).toBe(true)
    expect(hints.openWorldHint).toBe(false)
    expect(worktreeRead.toolset).toBe("worktree")
  })

  test("refuses another method or argument as invalid_argument", async () => {
    const repo = await open()
    for (const args of [{ method: "add" }, { method: "list", branch: "x" }, {}]) {
      const error = await invoke(worktreeRead, args, { cwd: repo.dir }).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(ToolError)
      expect((error as ToolError).code).toBe("invalid_argument")
    }
  })

  test("refuses a directory outside any repository as not_a_repository", async () => {
    const repo = await open()
    const error = await list(repo.home).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe("not_a_repository")
  })

  test("lists the main working tree alone, with the default root and the repository from origin", async () => {
    const repo = await open()
    const head = (await repo.git(["rev-parse", "HEAD"])).trim()
    expect(await list(repo.dir)).toEqual({
      root: join(repo.home, "worktrees"),
      repository: "tools",
      worktrees: [
        {
          directory: repo.dir,
          branch: "main",
          head,
          main: true,
          current: true,
          locked: false,
          lock_reason: null,
          prunable: false,
          in_layout: false,
        },
      ],
    })
  })

  test("lists linked worktrees in and out of the layout, from the one the call is made in", async () => {
    const repo = await open()
    const root = join(repo.home, "worktrees")
    const inside = join(root, "tools", "feat-x")
    const elsewhere = join(repo.home, "elsewhere", "other")
    await repo.git(["worktree", "add", "-b", "feat/x", inside])
    await repo.git(["worktree", "add", "-b", "other", elsewhere])
    mkdirSync(join(inside, "src", "deep"), { recursive: true })

    for (const cwd of [inside, join(inside, "src", "deep")]) {
      const listing = await list(cwd)
      expect(listing.worktrees[0]).toMatchObject({ directory: repo.dir, main: true, current: false })
      const byBranch = byBranchName(listing)
      expect(byBranch.size).toBe(3)
      expect(byBranch.get("feat/x")).toMatchObject({ directory: inside, main: false, current: true, in_layout: true })
      expect(byBranch.get("other")).toMatchObject({
        directory: elsewhere,
        main: false,
        current: false,
        in_layout: false,
      })
      expect(byBranch.get("main")).toMatchObject({ in_layout: false })
    }
  })

  test("lists a detached, a locked and a gone worktree", async () => {
    const repo = await open()
    const root = join(repo.home, "worktrees", "tools")
    const head = (await repo.git(["rev-parse", "HEAD"])).trim()
    await repo.git(["worktree", "add", "--detach", join(root, "detached")])
    await repo.git(["worktree", "add", "-b", "locked", join(root, "locked")])
    await repo.git(["worktree", "lock", "--reason", "on a usb stick", join(root, "locked")])
    await repo.git(["worktree", "add", "-b", "bare-lock", join(root, "bare-lock")])
    await repo.git(["worktree", "lock", join(root, "bare-lock")])
    await repo.git(["worktree", "add", "-b", "gone", join(root, "gone")])
    rmSync(join(root, "gone"), { recursive: true })

    const listing = await list(repo.dir)
    const byDirectory = new Map(listing.worktrees.map((worktree) => [worktree.directory, worktree]))
    expect(byDirectory.get(join(root, "detached"))).toMatchObject({
      branch: null,
      head,
      locked: false,
      prunable: false,
    })
    expect(byDirectory.get(join(root, "locked"))).toMatchObject({ locked: true, lock_reason: "on a usb stick" })
    expect(byDirectory.get(join(root, "bare-lock"))).toMatchObject({ locked: true, lock_reason: null })
    expect(byDirectory.get(join(root, "gone"))).toMatchObject({ branch: "gone", prunable: true, in_layout: true })
  })

  test("takes the root from the worktree_root setting, ~ expanded, and compares the layout against it", async () => {
    const repo = await open()
    await repo.git(["worktree", "add", "-b", "feat", join(repo.home, "trees", "tools", "feat")])
    await repo.git(["worktree", "add", "-b", "default", join(repo.home, "worktrees", "tools", "default")])

    for (const setting of ["~/trees", ` ${join(repo.home, "trees")} `]) {
      const listing = await list(repo.dir, { worktree_root: setting })
      expect(listing.root).toBe(join(repo.home, "trees"))
      const byBranch = byBranchName(listing)
      expect(byBranch.get("main")?.in_layout).toBe(false)
      expect(byBranch.get("feat")?.in_layout).toBe(true)
      expect(byBranch.get("default")?.in_layout).toBe(false)
    }
  })

  test("refuses a worktree_root that is not absolute as invalid_argument", async () => {
    const repo = await open()
    const error = await list(repo.dir, { worktree_root: "trees" }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe("invalid_argument")
  })

  test("names the repository after the main checkout when origin is missing", async () => {
    const repo = await open()
    await repo.git(["remote", "remove", "origin"])
    expect((await list(repo.dir)).repository).toBe("work")
  })

  test("compares the layout on real paths, so a linked root spelled through a symlink still matches", async () => {
    const repo = await open()
    const real = join(repo.home, "real")
    mkdirSync(real)
    const link = join(repo.home, "link")
    symlinkSync(real, link)
    await repo.git(["worktree", "add", "-b", "feat", join(link, "tools", "feat")])

    const listing = await list(repo.dir, { worktree_root: link })
    expect(listing.root).toBe(link)
    expect(byBranchName(listing).get("feat")).toMatchObject({ directory: join(real, "tools", "feat"), in_layout: true })
  })
})
