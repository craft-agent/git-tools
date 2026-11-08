import { afterEach, describe, expect, test } from "bun:test"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { gitResult } from "../git"
import { invoke } from "../tool"
import { repoRead } from "./read"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) {
    repo.cleanup()
  }
})

describe("git_repo_read status", () => {
  test("summarizes branch, base, staged, unstaged, untracked, stashes, and worktrees", async () => {
    const repo = await tempRepo()
    repos.push(repo)

    await repo.commit("init", { "a.txt": "a\n", "b.txt": "b\n", "c d.txt": "c\n" })
    await repo.git(["push", "origin", "main"])
    await repo.git(["switch", "-c", "feat/x"])
    await repo.git(["commit", "--allow-empty", "-m", "feat: one"])
    await repo.git(["commit", "--allow-empty", "-m", "feat: two"])
    repo.write("a.txt", "a2\n")
    await repo.git(["stash", "push", "-q"])
    repo.write("a.txt", "a3\n")
    await repo.git(["add", "a.txt"])
    repo.write("b.txt", "b2\n")
    repo.write("c d.txt", "c2\n")
    await repo.git(["mv", "c d.txt", "e f.txt"])
    repo.write("new.txt", "n\n")

    const res = await invoke(repoRead, { method: "status" }, { cwd: repo.dir })
    const status = res.status!

    expect(res.root).toBe(repo.dir)
    expect(status.branch).toBe("feat/x")
    expect(status.detached).toBe(false)
    expect(status.unborn).toBe(false)
    expect(status.upstream).toBe(null)
    expect(status.base).toMatchObject({
      ref: "origin/main",
      ahead: 2,
      behind: 0,
      truncated: false,
    })
    expect(status.base?.commits.map((c) => c.subject)).toEqual(["feat: two", "feat: one"])
    expect(status.operation).toBe(null)
    expect(status.conflicted).toEqual({ count: 0, items: [], truncated: false })
    expect(status.staged).toEqual({
      count: 2,
      items: [
        { path: "a.txt", status: "M" },
        { path: "e f.txt", status: "R", from: "c d.txt" },
      ],
      truncated: false,
    })
    expect(status.unstaged).toEqual({
      count: 2,
      items: [
        { path: "b.txt", status: "M" },
        { path: "e f.txt", status: "M" },
      ],
      truncated: false,
    })
    expect(status.untracked).toEqual({
      count: 1,
      items: ["new.txt"],
      truncated: false,
    })
    expect(status.clean).toBe(false)
    expect(status.worktrees).toEqual([{ path: repo.dir, branch: "feat/x", head: expect.any(String), current: true }])
    expect(status.stashes.count).toBe(1)
    expect(status.head).toBe((await repo.git(["rev-parse", "HEAD"])).trim())
  })

  test("reports a conflicted merge on main with its conflicted files and upstream", async () => {
    const repo = await tempRepo()
    repos.push(repo)

    await repo.commit("init", { "a.txt": "a\n" })
    await repo.git(["push", "origin", "main"])
    await repo.git(["switch", "-c", "other"])
    await repo.commit("other", { "a.txt": "other\n" })
    await repo.git(["switch", "main"])
    await repo.commit("main", { "a.txt": "main\n" })

    const mergeRes = await gitResult(["merge", "other"], { cwd: repo.dir })
    expect(mergeRes.code).not.toBe(0)

    const res = await invoke(repoRead, { method: "status" }, { cwd: repo.dir })
    const status = res.status!

    expect(status.branch).toBe("main")
    expect(status.operation).toBe("merge")
    expect(status.conflicted).toEqual({ count: 1, items: ["a.txt"], truncated: false })
    expect(status.upstream).toEqual({ ref: "origin/main", ahead: 1, behind: 0, gone: false })
  })

  test("handles an unborn repository without commits", async () => {
    const repo = await tempRepo({ remote: false, initialCommit: false })
    repos.push(repo)

    const res = await invoke(repoRead, { method: "status" }, { cwd: repo.dir })
    const status = res.status!

    expect(status.branch).toBe("main")
    expect(status.unborn).toBe(true)
    expect(status.head).toBe(null)
    expect(status.base).toBe(null)
    expect(status.clean).toBe(true)
  })

  test("reports detached HEAD", async () => {
    const repo = await tempRepo()
    repos.push(repo)

    const headSha = (await repo.git(["rev-parse", "HEAD"])).trim()
    await repo.git(["checkout", "--detach", headSha])

    const res = await invoke(repoRead, { method: "status" }, { cwd: repo.dir })
    const status = res.status!

    expect(status.branch).toBe(null)
    expect(status.detached).toBe(true)
    expect(status.head).toBe(headSha)
  })

  test("reports gone: true when upstream remote branch was deleted", async () => {
    const repo = await tempRepo()
    repos.push(repo)

    await repo.git(["switch", "-c", "topic"])
    await repo.git(["push", "-u", "origin", "topic"])
    await repo.git(["push", "origin", "--delete", "topic"])
    await repo.git(["fetch", "--prune", "origin"])

    const res = await invoke(repoRead, { method: "status" }, { cwd: repo.dir })
    const status = res.status!

    expect(status.upstream).toEqual({ ref: "origin/topic", ahead: 0, behind: 0, gone: true })
  })

  test("last_fetch is null in clone-less repo and an ISO string after fetch", async () => {
    const localRepo = await tempRepo({ remote: false })
    repos.push(localRepo)
    const localRes = await invoke(repoRead, { method: "status" }, { cwd: localRepo.dir })
    expect(localRes.status!.last_fetch).toBe(null)

    const remoteRepo = await tempRepo({ remote: true })
    repos.push(remoteRepo)
    await remoteRepo.git(["fetch", "origin"])
    const remoteRes = await invoke(repoRead, { method: "status" }, { cwd: remoteRepo.dir })
    expect(typeof remoteRes.status!.last_fetch).toBe("string")
  })

  test("truncates untracked items at 50 when there are 51 files", async () => {
    const repo = await tempRepo()
    repos.push(repo)

    for (let i = 1; i <= 51; i++) {
      repo.write(`file-${i.toString().padStart(2, "0")}.txt`, "content\n")
    }

    const res = await invoke(repoRead, { method: "status" }, { cwd: repo.dir })
    const status = res.status!

    expect(status.untracked.count).toBe(51)
    expect(status.untracked.items).toHaveLength(50)
    expect(status.untracked.truncated).toBe(true)
  })
})
