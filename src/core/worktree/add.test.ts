import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { git, gitResult } from "../git"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import {
  layoutDirectory,
  LOCAL_REPOSITORY,
  pushFromAnotherClone,
  REMOTE_REPOSITORY,
  revision,
  worktreeContext,
  worktreeRootOf,
} from "../../testing/worktree-fixtures"
import { writeTargets } from "../targets"
import { annotations, invoke } from "../tool"
import { worktreeAdd } from "./add"
import type { AddRequest } from "./add-plan"

type Args = Pick<AddRequest, "branch" | "from">

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

async function open(options?: Parameters<typeof tempRepo>[0]): Promise<TempRepo> {
  const repo = await tempRepo(options)
  repos.push(repo)
  return repo
}

const add = (repo: TempRepo, args: Args) => invoke(worktreeAdd, args, worktreeContext(repo))

/** A git setting of the repository that is not set reads as null. */
async function configValue(repo: TempRepo, key: string): Promise<string | null> {
  const result = await gitResult(["config", "--get", key], { cwd: repo.dir })
  return result.code === 0 ? result.stdout.trim() : null
}

describe("git_worktree_add", () => {
  test("is an add tool of the worktree toolset that reaches the network", () => {
    const hints = annotations(worktreeAdd)
    expect(hints.readOnlyHint).toBe(false)
    expect(hints.destructiveHint).toBe(false)
    expect(hints.openWorldHint).toBe(true)
    expect(worktreeAdd.toolset).toBe("worktree")
  })

  test("names the layout's directory as its target", async () => {
    const repo = await open()
    const targets = await writeTargets(worktreeAdd, { branch: "task/x" }, worktreeContext(repo))
    expect(targets).toEqual([layoutDirectory(repo, REMOTE_REPOSITORY, "task/x")])
    expect(await writeTargets(worktreeAdd, { branch: "bad..name" }, worktreeContext(repo))).toEqual(["*"])
  })

  test("cuts a new branch from the fetched default branch: a commit pushed meanwhile is in, a local-only one is out", async () => {
    const repo = await open()
    const localOnly = await repo.commit("local only", { "local.txt": "x\n" })
    const pushed = await pushFromAnotherClone(repo, "pushed meanwhile")

    const added = await add(repo, { branch: "task/new" })

    const directory = layoutDirectory(repo, REMOTE_REPOSITORY, "task/new")
    expect(added).toEqual({
      directory,
      branch: "task/new",
      new_branch: true,
      base: { ref: "origin/main", sha: pushed },
      fetched: true,
      warnings: [],
    })
    expect((await git(["rev-parse", "HEAD"], { cwd: directory })).trim()).toBe(pushed)
    expect((await git(["symbolic-ref", "--short", "HEAD"], { cwd: directory })).trim()).toBe("task/new")
    expect(existsSync(join(directory, "local.txt"))).toBe(false)
    expect(await revision(repo, "main")).toBe(localOnly)
    expect(await revision(repo, "origin/main")).toBe(pushed)
  })

  test("writes each / of the branch as - in the directory", async () => {
    const repo = await open()
    const added = await add(repo, { branch: "feature/deep/name" })
    expect(added.directory).toBe(join(worktreeRootOf(repo), REMOTE_REPOSITORY, "feature-deep-name"))
  })

  test("gives the new branch no upstream", async () => {
    const repo = await open()
    await add(repo, { branch: "task/a" })
    expect(await configValue(repo, "branch.task/a.merge")).toBeNull()
    expect(await configValue(repo, "branch.task/a.remote")).toBeNull()
  })

  test("does not run the repository's hooks on the checkout", async () => {
    const repo = await open()
    const marker = join(repo.home, "hook-ran")
    writeFileSync(join(repo.dir, ".git", "hooks", "post-checkout"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
    await repo.git(["worktree", "add", "--detach", join(repo.home, "control")])
    expect(existsSync(marker)).toBe(true)
    await git(["worktree", "remove", "--force", join(repo.home, "control")], { cwd: repo.dir })
    rmSync(marker)

    await add(repo, { branch: "task/hooks" })

    expect(existsSync(marker)).toBe(false)
  })

  test("starts a new branch at from: a tag, a commit id or a local branch", async () => {
    const repo = await open()
    const first = await revision(repo, "HEAD")
    await repo.git(["tag", "v1"])
    const second = await repo.commit("second", { "second.txt": "2\n" })
    await repo.git(["branch", "side", first])

    expect((await add(repo, { branch: "from-tag", from: "v1" })).base).toEqual({ ref: "v1", sha: first })
    expect((await add(repo, { branch: "from-sha", from: second })).base).toEqual({ ref: second, sha: second })
    const fromBranch = await add(repo, { branch: "from-branch", from: "side" })
    expect(fromBranch.base).toEqual({ ref: "side", sha: first })
    expect(fromBranch.fetched).toBe(true)
    expect(await revision(repo, "from-tag")).toBe(first)
  })

  test("checks an existing branch out as it is, without fetching or a base", async () => {
    const repo = await open()
    const tip = await repo.commit("on feat", { "feat.txt": "f\n" })
    await repo.git(["branch", "feat", tip])
    await repo.git(["reset", "--hard", "HEAD~1"])

    const added = await add(repo, { branch: "feat" })

    const directory = layoutDirectory(repo, REMOTE_REPOSITORY, "feat")
    expect(added).toEqual({ directory, branch: "feat", new_branch: false, base: null, fetched: null, warnings: [] })
    expect((await git(["rev-parse", "HEAD"], { cwd: directory })).trim()).toBe(tip)
    expect(existsSync(join(directory, "feat.txt"))).toBe(true)
  })

  test("cuts from HEAD when there is no origin, and names the repository after the folder", async () => {
    const repo = await open({ remote: false })
    const head = await revision(repo, "HEAD")

    const added = await add(repo, { branch: "task/local" })

    expect(added).toEqual({
      directory: layoutDirectory(repo, LOCAL_REPOSITORY, "task/local"),
      branch: "task/local",
      new_branch: true,
      base: { ref: "HEAD", sha: head },
      fetched: null,
      warnings: [],
    })
  })

  test("reads the default branch with ls-remote when origin/HEAD is not recorded", async () => {
    const repo = await open()
    await repo.git(["push", "origin", "main:trunk"])
    await git(["symbolic-ref", "HEAD", "refs/heads/trunk"], { cwd: repo.remote! })
    // A newer git records origin/HEAD on fetch; keep it unrecorded so only the remote can say.
    await repo.git(["config", "remote.origin.followRemoteHEAD", "never"])

    const added = await add(repo, { branch: "task/trunk" })

    expect((await gitResult(["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd: repo.dir })).code).not.toBe(0)
    expect(added.base).toEqual({ ref: "origin/trunk", sha: await revision(repo, "origin/trunk") })
  })

  test("prefers the default branch recorded as origin/HEAD over the remote's", async () => {
    const repo = await open()
    await repo.git(["push", "origin", "main:release"])
    await repo.git(["fetch", "origin"])
    await repo.git(["remote", "set-head", "origin", "release"])

    const added = await add(repo, { branch: "task/rel" })

    expect(added.base!.ref).toBe("origin/release")
  })

  test("warns, and cuts from the last fetch, when fetching origin fails", async () => {
    const repo = await open()
    const known = await revision(repo, "origin/main")
    await repo.git(["remote", "set-url", "origin", join(repo.home, "nowhere.git")])

    const added = await add(repo, { branch: "task/offline" })

    expect(added.fetched).toBe(false)
    expect(added.warnings).toEqual(["fetching origin failed: origin/main is as of the last fetch"])
    expect(added.base).toEqual({ ref: "origin/main", sha: known })
    expect(existsSync(added.directory)).toBe(true)
  })

  test("returns the real path of the directory when the root is reached through a symlink", async () => {
    const repo = await open()
    const real = join(repo.home, "real-root")
    const link = join(repo.home, "link-root")
    mkdirSync(real)
    symlinkSync(real, link)

    const added = await invoke(worktreeAdd, { branch: "task/link" }, worktreeContext(repo, link))

    expect(added.directory).toBe(join(real, REMOTE_REPOSITORY, "task-link"))
    expect(existsSync(join(added.directory, "README.md"))).toBe(true)
  })
})
