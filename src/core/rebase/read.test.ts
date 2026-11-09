import { afterEach, describe, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { dirname, join } from "node:path"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { invoke } from "../tool"
import { rebaseRead } from "./read"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

async function fixture(options?: Parameters<typeof tempRepo>[0]) {
  const repo = await tempRepo(options)
  repos.push(repo)
  return repo
}

/** Cuts `name` from the current branch and gives it `count` commits of its own. */
async function layer(repo: TempRepo, name: string, count = 1): Promise<void> {
  await repo.git(["switch", "-c", name])
  for (let i = 1; i <= count; i++) await repo.commit(`${name}: ${i}`, { [`${name}-${i}.txt`]: `${i}\n` })
}

const read = (repo: TempRepo, top?: string) =>
  invoke(rebaseRead, { method: "stack", top }, { cwd: repo.dir }).then((result) => result.stack!)

const sha = async (repo: TempRepo, rev: string) => (await repo.git(["rev-parse", rev])).trim().slice(0, 12)

describe("git_rebase_read stack", () => {
  test("reads a branch alone: its commits, a fixup among them, and a rewrite that is allowed", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    await repo.commit("fixup! feat: 1", { "fix.txt": "x\n" })

    const stack = await read(repo)
    expect(stack).toMatchObject({
      base: { ref: "origin/main", sha: await sha(repo, "main") },
      branch: "feat",
      top: "feat",
      rewrite: { allowed: true, needs_force_push: false, refusals: [] },
    })
    expect(stack.layers).toEqual([
      {
        branches: ["feat"],
        tip: await sha(repo, "feat"),
        current: true,
        count: 2,
        commits: [
          { sha: await sha(repo, "feat~1"), subject: "feat: 1" },
          { sha: await sha(repo, "feat"), subject: "fixup! feat: 1" },
        ],
        truncated: false,
        fixups: 1,
        remotes: [],
        worktree: null,
      },
    ])
  })

  test("reads three layers from the middle one", async () => {
    const repo = await fixture()
    await layer(repo, "l1")
    await layer(repo, "l2", 2)
    await layer(repo, "l3")
    await repo.git(["switch", "l2"])

    const stack = await read(repo)
    expect(stack.branch).toBe("l2")
    expect(stack.top).toBe("l3")
    expect(stack.layers.map((item) => [item.branches, item.current, item.count])).toEqual([
      [["l1"], false, 1],
      [["l2"], true, 2],
      [["l3"], false, 1],
    ])
    expect(stack.layers.map((item) => item.commits.map((commit) => commit.subject))).toEqual([
      ["l1: 1"],
      ["l2: 1", "l2: 2"],
      ["l3: 1"],
    ])
  })

  test("says where each branch stands to its remote branches, and that a rewrite then needs a force push", async () => {
    const repo = await fixture()
    for (const name of ["a", "b", "c", "d"]) await layer(repo, name)
    const tree = (await repo.git(["rev-parse", "main^{tree}"])).trim()
    const unrelated = (await repo.git(["commit-tree", tree, "-p", "main", "-m", "elsewhere"])).trim()
    await repo.git(["update-ref", "refs/remotes/origin/a", unrelated])
    await repo.git(["update-ref", "refs/remotes/origin/b", "a"])
    await repo.git(["update-ref", "refs/remotes/origin/c", "d"])
    await repo.git(["push", "origin", "d"])

    const stack = await read(repo)
    expect(stack.layers.map((item) => item.remotes)).toEqual([
      [{ branch: "a", ref: "origin/a", state: "diverged" }],
      [{ branch: "b", ref: "origin/b", state: "ahead" }],
      [{ branch: "c", ref: "origin/c", state: "behind" }],
      [{ branch: "d", ref: "origin/d", state: "same" }],
    ])
    expect(stack.rewrite).toMatchObject({ allowed: true, needs_force_push: true })
    expect(stack.rewrite!.published).toEqual(expect.arrayContaining(["origin/c", "origin/d"]))
  })

  test("names another worktree where a branch of the stack is checked out", async () => {
    const repo = await fixture()
    await layer(repo, "l1")
    await layer(repo, "l2")
    const path = join(dirname(repo.dir), "other")
    await repo.git(["worktree", "add", path, "l1"])

    const stack = await read(repo)
    expect(stack.layers.map((item) => item.worktree)).toEqual([realpathSync(path), null])
  })

  test("asks for top where the branches above fork, and reads the line it names", async () => {
    const repo = await fixture()
    await layer(repo, "l1")
    await layer(repo, "l2a")
    await repo.git(["switch", "l1"])
    await layer(repo, "l2b")
    await repo.git(["switch", "l1"])

    await expect(read(repo)).rejects.toMatchObject({ code: "invalid_argument" })
    await expect(read(repo, "nowhere")).rejects.toMatchObject({ code: "invalid_argument" })
    const stack = await read(repo, "l2a")
    expect(stack.top).toBe("l2a")
    expect(stack.layers.map((item) => item.branches)).toEqual([["l1"], ["l2a"]])
    expect(stack.rewrite).toMatchObject({ allowed: true, refusals: [] })
  })

  test("refuses a detached HEAD", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    await repo.git(["switch", "--detach"])
    await expect(read(repo)).rejects.toMatchObject({ code: "invalid_argument" })
  })

  test("refuses a clone with no remote default branch", async () => {
    const repo = await fixture({ remote: false })
    await layer(repo, "feat")
    await expect(read(repo)).rejects.toMatchObject({ code: "not_found" })
  })

  test("reads a branch at the base as one layer with no commits and no rewrite check", async () => {
    const repo = await fixture()
    await repo.git(["switch", "-c", "feat"])
    const stack = await read(repo)
    expect(stack.layers).toMatchObject([{ branches: ["feat"], count: 0, commits: [], fixups: 0 }])
    expect(stack.rewrite).toBeNull()
  })

  test("lists at most 30 commits of a layer, oldest first, and says it did not list them all", async () => {
    const repo = await fixture()
    await repo.git(["switch", "-c", "feat"])
    for (let i = 1; i <= 32; i++) await repo.git(["commit", "--allow-empty", "-m", `c${i}`])

    const [only] = (await read(repo)).layers
    expect(only).toMatchObject({ count: 32, truncated: true })
    expect(only!.commits).toHaveLength(30)
    expect([only!.commits[0]!.subject, only!.commits[29]!.subject]).toEqual(["c1", "c30"])
  })
})
