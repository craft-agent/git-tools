import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { installFakeGh, type FakeGh } from "../../testing/fake-gh"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { asGithubRemote } from "../../testing/push-fixtures"
import {
  addTaskWorktree,
  commitIn,
  layoutDirectory,
  REMOTE_REPOSITORY,
  repositoryState,
  revision,
  worktreeContext,
} from "../../testing/worktree-fixtures"
import { callDescription } from "../describe"
import { git, gitResult } from "../git"
import { worktreeRemove } from "./remove"

const repos: TempRepo[] = []
const fakes: FakeGh[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
  for (const fake of fakes.splice(0)) fake.restore()
})

async function open(options?: Parameters<typeof tempRepo>[0]): Promise<TempRepo> {
  const repo = await tempRepo(options)
  repos.push(repo)
  return repo
}

const describeRemove = (repo: TempRepo, directory: string) =>
  callDescription(worktreeRemove, { directory }, worktreeContext(repo))

/** A repository whose `.gitignore` ignores `*.log` and `build/`, with a worktree cut after that. */
async function withIgnoreRules(): Promise<{ repo: TempRepo; directory: string }> {
  const repo = await open()
  await repo.commit("ignore", { ".gitignore": "*.log\nbuild/\n" })
  await repo.git(["push", "origin", "main"])
  return { repo, directory: await addTaskWorktree(repo, "task/a") }
}

/** Moves `main` on the origin that `asGithubRemote` made from a second clone, which the repository has not fetched. */
async function pushToGithubCopy(repo: TempRepo): Promise<void> {
  const other = join(repo.home, "other-clone")
  await git(["clone", "--quiet", join(repo.dir, "github.com", "o", "r.git"), other], { cwd: repo.home })
  await git(["commit", "--allow-empty", "-m", "pushed meanwhile"], { cwd: other })
  await git(["push", "--quiet", "origin", "main"], { cwd: other })
}

describe("git_worktree_remove description", () => {
  test("describes removing the worktree of a branch, with no facts when nothing ignored is lost", async () => {
    const repo = await open()
    const directory = await addTaskWorktree(repo, "task/a")

    expect(await describeRemove(repo, directory)).toEqual({
      headline: { text: "About to remove the worktree of {branch}", values: { branch: "task/a" } },
      facts: [],
    })
  })

  test("describes removing a detached worktree", async () => {
    const repo = await open()
    const directory = layoutDirectory(repo, REMOTE_REPOSITORY, "detached")
    await repo.git(["worktree", "add", "--detach", directory])

    expect(await describeRemove(repo, directory)).toEqual({
      headline: { text: "About to remove a detached worktree" },
      facts: [],
    })
  })

  test("describes pruning a worktree whose directory is gone", async () => {
    const repo = await open()
    const gone = await addTaskWorktree(repo, "task/gone")
    const detached = layoutDirectory(repo, REMOTE_REPOSITORY, "detached")
    await repo.git(["worktree", "add", "--detach", detached])
    rmSync(gone, { recursive: true })
    rmSync(detached, { recursive: true })

    expect(await describeRemove(repo, gone)).toEqual({
      headline: { text: "About to prune the worktree of {branch}", values: { branch: "task/gone" } },
      facts: [],
    })
    expect(await describeRemove(repo, detached)).toEqual({
      headline: { text: "About to prune a detached worktree" },
      facts: [],
    })
  })

  test("counts the ignored paths the removal loses: a folder of them is one path", async () => {
    const { repo, directory } = await withIgnoreRules()
    writeFileSync(join(directory, "a.log"), "a\n")
    writeFileSync(join(directory, "b.log"), "b\n")
    mkdirSync(join(directory, "build", "deep"), { recursive: true })
    writeFileSync(join(directory, "build", "deep", "out.o"), "o\n")

    const description = await describeRemove(repo, directory)

    expect(description!.facts).toEqual([
      { label: "Ignored files", value: { text: "{count} paths lost", values: { count: 3 } } },
    ])
  })

  test("says one path in the singular", async () => {
    const { repo, directory } = await withIgnoreRules()
    writeFileSync(join(directory, "a.log"), "a\n")

    const description = await describeRemove(repo, directory)

    expect(description!.facts).toEqual([
      { label: "Ignored files", value: { text: "{count} path lost", values: { count: 1 } } },
    ])
  })

  test("gives no description when a local check fails", async () => {
    const repo = await open()
    const dirty = await addTaskWorktree(repo, "task/dirty")
    writeFileSync(join(dirty, "loose.txt"), "l\n")
    const locked = await addTaskWorktree(repo, "task/locked")
    await repo.git(["worktree", "lock", locked])
    const detached = layoutDirectory(repo, REMOTE_REPOSITORY, "detached")
    await repo.git(["worktree", "add", "--detach", detached])
    await commitIn(detached, "only here", { "x.txt": "x\n" })
    const stopped = await addTaskWorktree(repo, "task/stopped")
    await commitIn(stopped, "one", { "c.txt": "one\n" })
    await repo.commit("two", { "c.txt": "two\n" })
    expect((await gitResult(["rebase", "main"], { cwd: stopped })).code).not.toBe(0)

    const ok = await addTaskWorktree(repo, "task/ok")
    expect(await describeRemove(repo, ok)).toBeDefined()
    for (const directory of [dirty, locked, detached, stopped, repo.dir, repo.home, join(repo.home, "missing"), " "]) {
      expect(await describeRemove(repo, directory), directory).toBeUndefined()
    }
    expect(
      await callDescription(worktreeRemove, { directory: ok }, { ...worktreeContext(repo), cwd: ok }),
    ).toBeUndefined()
  })

  test("reads this repository alone: no fetch, no gh, nothing changed, and the same answer twice", async () => {
    const repo = await open()
    await asGithubRemote(repo)
    const directory = await addTaskWorktree(repo, "task/a")
    const known = await revision(repo, "origin/main")
    await pushToGithubCopy(repo)
    const fake = installFakeGh([{ match: ".", stdout: "{}" }])
    fakes.push(fake)
    const before = await repositoryState(repo)

    const first = await describeRemove(repo, directory)

    expect(first!.headline).toEqual({ text: "About to remove the worktree of {branch}", values: { branch: "task/a" } })
    expect(await describeRemove(repo, directory)).toEqual(first)
    expect(fake.calls()).toEqual([])
    expect(await revision(repo, "origin/main")).toBe(known)
    expect(await repositoryState(repo)).toBe(before)
  })
})
