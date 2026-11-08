import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { git, gitResult } from "../core/git"
import { tempRepo, type TempRepo } from "./git-repo"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) {
    repo.cleanup()
  }
})

describe("tempRepo", () => {
  test("isolates global git config and points HOME at repo.home", async () => {
    const repo = await tempRepo()
    repos.push(repo)

    expect(process.env.HOME).toBe(repo.home)
    const email = await repo.git(["config", "--global", "user.email"])
    expect(email.trim()).toBe("test@example.com")
  })

  test("cleanup restores HOME and XDG_CONFIG_HOME, removes directories, and is idempotent", async () => {
    const originalHome = process.env.HOME
    const originalXdg = process.env.XDG_CONFIG_HOME

    try {
      // With XDG_CONFIG_HOME initially set
      process.env.HOME = "/custom/home"
      process.env.XDG_CONFIG_HOME = "/custom/xdg"
      const repoWithXdg = await tempRepo()
      expect(existsSync(repoWithXdg.dir)).toBe(true)
      repoWithXdg.cleanup()
      expect(process.env.HOME).toBe("/custom/home")
      expect(process.env.XDG_CONFIG_HOME).toBe("/custom/xdg")
      expect(existsSync(repoWithXdg.dir)).toBe(false)
      expect(() => repoWithXdg.cleanup()).not.toThrow()

      // With XDG_CONFIG_HOME initially unset
      process.env.HOME = "/custom/home"
      delete process.env.XDG_CONFIG_HOME
      const repoWithoutXdg = await tempRepo()
      expect(existsSync(repoWithoutXdg.dir)).toBe(true)
      repoWithoutXdg.cleanup()
      expect(process.env.HOME).toBe("/custom/home")
      expect(process.env.XDG_CONFIG_HOME).toBeUndefined()
      expect(existsSync(repoWithoutXdg.dir)).toBe(false)
      expect(() => repoWithoutXdg.cleanup()).not.toThrow()
    } finally {
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
      if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = originalXdg
    }
  })

  test("working tree is on main with one commit and tracks bare origin", async () => {
    const repo = await tempRepo()
    repos.push(repo)

    const branch = await repo.git(["branch", "--show-current"])
    expect(branch.trim()).toBe("main")

    const count = await repo.git(["rev-list", "--count", "HEAD"])
    expect(count.trim()).toBe("1")

    expect(repo.remote).toBeDefined()
    const isBare = await git(["rev-parse", "--is-bare-repository"], { cwd: repo.remote! })
    expect(isBare.trim()).toBe("true")

    const localHead = (await repo.git(["rev-parse", "HEAD"])).trim()
    const remoteHead = (await git(["rev-parse", "main"], { cwd: repo.remote! })).trim()
    expect(remoteHead).toBe(localHead)

    const upstream = (await repo.git(["rev-parse", "--abbrev-ref", "@{upstream}"])).trim()
    expect(upstream).toBe("origin/main")
  })

  test("commit writes files, stages all, commits, and returns new HEAD sha", async () => {
    const repo = await tempRepo()
    repos.push(repo)

    const sha = await repo.commit("second", { "a/b.txt": "x\n" })
    const head = (await repo.git(["rev-parse", "HEAD"])).trim()
    expect(sha).toBe(head)

    const filePath = join(repo.dir, "a/b.txt")
    expect(existsSync(filePath)).toBe(true)
    expect(readFileSync(filePath, "utf8")).toBe("x\n")

    const count = (await repo.git(["rev-list", "--count", "HEAD"])).trim()
    expect(count).toBe("2")
  })

  test("tempRepo({ remote: false, initialCommit: false })", async () => {
    const repo = await tempRepo({ remote: false, initialCommit: false })
    repos.push(repo)

    expect(repo.remote).toBeUndefined()

    const remotes = (await repo.git(["remote"])).trim()
    expect(remotes).toBe("")

    const result = await gitResult(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: repo.dir })
    expect(result.code).toBe(1)
  })
})
