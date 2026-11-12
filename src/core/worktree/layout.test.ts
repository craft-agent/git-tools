import { afterEach, describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { ToolError } from "../errors"
import { mainCheckout, repositoryName, WORKTREE_ROOT_OPTION, worktreePath, worktreeRoot } from "./layout"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

async function open(options?: Parameters<typeof tempRepo>[0]): Promise<TempRepo> {
  const repo = await tempRepo(options)
  repos.push(repo)
  return repo
}

const rootOf = (value: string | undefined) =>
  worktreeRoot({ options: value === undefined ? undefined : { [WORKTREE_ROOT_OPTION]: value } })

describe("worktreeRoot", () => {
  test("is worktrees under the home directory when the setting is unset or blank", async () => {
    const repo = await open()
    expect(rootOf(undefined)).toBe(join(repo.home, "worktrees"))
    expect(rootOf("")).toBe(join(repo.home, "worktrees"))
    expect(rootOf("  \t")).toBe(join(repo.home, "worktrees"))
    expect(worktreeRoot({ options: {} })).toBe(join(repo.home, "worktrees"))
  })

  test("falls back to the account's home directory when HOME is blank", async () => {
    await open()
    process.env.HOME = " "
    expect(rootOf(undefined)).toBe(join(homedir(), "worktrees"))
  })

  test("takes an absolute, normalized path", () => {
    expect(rootOf("/srv/trees")).toBe("/srv/trees")
  })

  test("takes an absolute path under the home directory", async () => {
    const repo = await open()
    expect(rootOf(repo.home)).toBe(repo.home)
    expect(rootOf(join(repo.home, "x"))).toBe(join(repo.home, "x"))
    expect(rootOf(join(repo.home, "a", "b"))).toBe(join(repo.home, "a", "b"))
  })

  test("refuses a path that is not absolute, naming the setting", () => {
    for (const value of ["trees", "./trees", "../trees", "~other/trees", "~x"]) {
      let error: unknown
      try {
        rootOf(value)
      } catch (caught) {
        error = caught
      }
      expect(error, value).toBeInstanceOf(ToolError)
      expect((error as ToolError).code).toBe("invalid_argument")
      expect((error as ToolError).message).toContain("worktree_root")
      expect((error as ToolError).message).toContain(value)
    }
  })
})

describe("repositoryName", () => {
  async function named(url: string): Promise<string> {
    const repo = await open()
    await repo.git(["remote", "set-url", "origin", url])
    return repositoryName(repo.dir)
  }

  test("is the last part of origin's URL without .git", async () => {
    expect(await named("https://github.com/craft-agent/git-tools.git")).toBe("git-tools")
    expect(await named("https://github.com/craft-agent/git-tools")).toBe("git-tools")
    expect(await named("git@github.com:craft-agent/git-tools.git")).toBe("git-tools")
    expect(await named("ssh://git@host:2222/srv/git/tools.git")).toBe("tools")
    expect(await named("/srv/git/local-tools.git")).toBe("local-tools")
  })

  test("ignores trailing slashes", async () => {
    expect(await named("https://github.com/craft-agent/git-tools/")).toBe("git-tools")
    expect(await named("https://github.com/craft-agent/git-tools.git//")).toBe("git-tools")
  })

  test("is the main checkout's folder name without origin", async () => {
    const repo = await open({ remote: false })
    expect(await repositoryName(repo.dir)).toBe("work")
  })

  test("is the main checkout's folder name when origin's URL names nothing", async () => {
    expect(await named("host:")).toBe("work")
    expect(await named("https://host/..")).toBe("work")
  })

  test("is the same from a linked worktree", async () => {
    const repo = await open({ remote: false })
    const linked = join(repo.home, "linked")
    await repo.git(["worktree", "add", "-b", "feat", linked])
    expect(await repositoryName(linked)).toBe("work")
  })
})

describe("mainCheckout", () => {
  test("is the folder of the .git directory, from the main checkout or a linked worktree", async () => {
    const repo = await open()
    const linked = join(repo.home, "linked")
    await repo.git(["worktree", "add", "-b", "feat", linked])
    expect(await mainCheckout(repo.dir)).toBe(repo.dir)
    expect(await mainCheckout(linked)).toBe(repo.dir)
  })

  test("is the git directory itself for a bare repository", async () => {
    const repo = await open()
    expect(await mainCheckout(repo.remote!)).toBe(repo.remote!)
    expect(await repositoryName(repo.remote!)).toBe(basename(repo.remote!, ".git"))
  })
})

describe("worktreePath", () => {
  test("is <root>/<repository>/<branch>, with each / of the branch written -", () => {
    expect(worktreePath("/srv/trees", "tools", "feat")).toBe("/srv/trees/tools/feat")
    expect(worktreePath("/srv/trees", "tools", "feat/login/form")).toBe("/srv/trees/tools/feat-login-form")
  })
})
