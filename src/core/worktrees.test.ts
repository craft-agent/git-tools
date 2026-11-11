import { afterEach, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { tempRepo, type TempRepo } from "../testing/git-repo"
import { branchName, listWorktrees, parseWorktreeList, type ListedWorktree } from "./worktrees"

const SHA = "1111111111111111111111111111111111111111"
const OTHER_SHA = "2222222222222222222222222222222222222222"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

/** A listed worktree with the fields a test does not name left at their plain values. */
function listed(fields: Partial<ListedWorktree>): ListedWorktree {
  return {
    path: "/x",
    head: SHA,
    branch: null,
    bare: false,
    detached: false,
    main: false,
    locked: null,
    prunable: null,
    ...fields,
  }
}

describe("parseWorktreeList", () => {
  test("reads the main working tree first and a linked one after it", () => {
    const porcelain = [
      `worktree /work/main\nHEAD ${SHA}\nbranch refs/heads/main\n`,
      `worktree /work/trees/feat-x\nHEAD ${OTHER_SHA}\nbranch refs/heads/feat/x\n`,
    ].join("\n")
    expect(parseWorktreeList(porcelain)).toEqual([
      listed({ path: "/work/main", branch: "refs/heads/main", main: true }),
      listed({ path: "/work/trees/feat-x", head: OTHER_SHA, branch: "refs/heads/feat/x" }),
    ])
  })

  test("reads a detached HEAD as a sha with no branch", () => {
    const [main, detached] = parseWorktreeList(
      `worktree /a\nHEAD ${SHA}\nbranch refs/heads/main\n\nworktree /b\nHEAD ${OTHER_SHA}\ndetached\n`,
    )
    expect(main!.detached).toBe(false)
    expect(detached).toEqual(listed({ path: "/b", head: OTHER_SHA, detached: true }))
  })

  test("reads a bare repository, which has no HEAD line", () => {
    expect(parseWorktreeList("worktree /srv/repo.git\nbare\n")).toEqual([
      listed({ path: "/srv/repo.git", head: null, bare: true, main: true }),
    ])
  })

  test("reads a lock with and without a reason", () => {
    const [, withReason, withoutReason] = parseWorktreeList(
      [
        `worktree /a\nHEAD ${SHA}\nbranch refs/heads/main\n`,
        `worktree /b\nHEAD ${SHA}\nbranch refs/heads/b\nlocked on a usb stick\n`,
        `worktree /c\nHEAD ${SHA}\ndetached\nlocked\n`,
      ].join("\n"),
    )
    expect(withReason!.locked).toBe("on a usb stick")
    expect(withoutReason!.locked).toBe("")
  })

  test("reads a prunable worktree with its reason", () => {
    const [, gone] = parseWorktreeList(
      `worktree /a\nHEAD ${SHA}\nbranch refs/heads/main\n\nworktree /b\nHEAD ${SHA}\nbranch refs/heads/b\nprunable gitdir file points to non-existent location\n`,
    )
    expect(gone!.prunable).toBe("gitdir file points to non-existent location")
    expect(gone!.locked).toBeNull()
  })

  test("reads a path with spaces and tolerates CRLF line ends and empty output", () => {
    expect(parseWorktreeList(`worktree /my trees/a b\r\nHEAD ${SHA}\r\nbranch refs/heads/main\r\n`)).toEqual([
      listed({ path: "/my trees/a b", branch: "refs/heads/main", main: true }),
    ])
    expect(parseWorktreeList("")).toEqual([])
  })
})

describe("branchName", () => {
  test("shortens a local branch ref and leaves anything else as it is", () => {
    expect(branchName("refs/heads/feat/x")).toBe("feat/x")
    expect(branchName("refs/remotes/origin/x")).toBe("refs/remotes/origin/x")
    expect(branchName(null)).toBeNull()
  })
})

describe("listWorktrees", () => {
  test("lists a real repository's worktrees: main, a branch, a detached, a locked and a gone one", async () => {
    const repo = await tempRepo()
    repos.push(repo)
    const trees = join(repo.home, "trees")
    await repo.git(["worktree", "add", "-b", "feat/x", join(trees, "feat-x")])
    await repo.git(["worktree", "add", "--detach", join(trees, "detached")])
    await repo.git(["worktree", "add", "-b", "locked", join(trees, "locked")])
    await repo.git(["worktree", "lock", "--reason", "keep", join(trees, "locked")])
    await repo.git(["worktree", "add", "-b", "gone", join(trees, "gone")])
    rmSync(join(trees, "gone"), { recursive: true })

    const head = (await repo.git(["rev-parse", "HEAD"])).trim()
    const byPath = new Map((await listWorktrees(repo.dir)).map((entry) => [entry.path, entry]))

    expect([...byPath.keys()][0]).toBe(repo.dir)
    expect(byPath.get(repo.dir)).toEqual(listed({ path: repo.dir, head, branch: "refs/heads/main", main: true }))
    expect(byPath.get(join(trees, "feat-x"))).toEqual(
      listed({ path: join(trees, "feat-x"), head, branch: "refs/heads/feat/x" }),
    )
    expect(byPath.get(join(trees, "detached"))).toEqual(listed({ path: join(trees, "detached"), head, detached: true }))
    expect(byPath.get(join(trees, "locked"))!.locked).toBe("keep")
    expect(byPath.get(join(trees, "gone"))!.prunable).toEqual(expect.any(String))
  })
})
