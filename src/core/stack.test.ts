import { afterEach, describe, expect, test } from "bun:test"
import { tempRepo, type TempRepo } from "../testing/git-repo"
import { layersAbove, readStack, stackBranches, topBranch } from "./stack"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

async function fixture(options?: Parameters<typeof tempRepo>[0]) {
  const repo = await tempRepo(options)
  repos.push(repo)
  return repo
}

async function sha(repo: TempRepo, rev: string): Promise<string> {
  return (await repo.git(["rev-parse", rev])).trim()
}

/** Cuts `name` from the current branch and gives it `count` commits of its own. */
async function layer(repo: TempRepo, name: string, count = 1): Promise<void> {
  await repo.git(["switch", "-c", name])
  for (let i = 1; i <= count; i++) await repo.commit(`${name}: ${i}`, { [`${name}-${i}.txt`]: `${i}\n` })
}

/** A stack l1 < l2 < l3 (l2 has two commits), with l3 checked out. */
async function threeLayers() {
  const repo = await fixture()
  await layer(repo, "l1")
  await layer(repo, "l2", 2)
  await layer(repo, "l3")
  return repo
}

const names = (stack: NonNullable<Awaited<ReturnType<typeof readStack>>>) => stack.layers.map((item) => item.branches)

describe("readStack", () => {
  test("a branch alone is one layer", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    expect(await readStack(repo.dir)).toEqual({
      base: await sha(repo, "main"),
      default_ref: "origin/main",
      branch: "feat",
      position: 0,
      layers: [{ branches: ["feat"], tip: await sha(repo, "feat") }],
    })
  })

  test("reads three layers from each of them", async () => {
    const repo = await threeLayers()
    const tips = [await sha(repo, "l1"), await sha(repo, "l2"), await sha(repo, "l3")]
    for (const [position, branch] of ["l1", "l2", "l3"].entries()) {
      await repo.git(["switch", branch])
      const stack = (await readStack(repo.dir))!
      expect(stack.branch).toBe(branch)
      expect(stack.position).toBe(position)
      expect(stack.base).toBe(await sha(repo, "main"))
      expect(stack.layers).toEqual([
        { branches: ["l1"], tip: tips[0]! },
        { branches: ["l2"], tip: tips[1]! },
        { branches: ["l3"], tip: tips[2]! },
      ])
      expect(topBranch(stack)).toBe("l3")
      expect(stackBranches(stack)).toEqual(["l1", "l2", "l3"])
      expect(layersAbove(stack).map((item) => item.branches)).toEqual([["l1"], ["l2"], ["l3"]].slice(position + 1))
    }
  })

  test("branches sharing a tip are one layer, the current one first", async () => {
    const repo = await threeLayers()
    await repo.git(["switch", "-c", "l4"])
    await repo.git(["branch", "a-sibling"])
    const stack = (await readStack(repo.dir))!
    expect(names(stack)).toEqual([["l1"], ["l2"], ["l4", "a-sibling", "l3"]])
    expect(stack.position).toBe(2)
    expect(topBranch(stack)).toBe("l4")
  })

  test("a layer of branches sharing a tip below the current one is sorted by name", async () => {
    const repo = await threeLayers()
    await repo.git(["branch", "b-twin", "l2"])
    await repo.git(["branch", "a-twin", "l2"])
    await repo.git(["switch", "l3"])
    expect(names((await readStack(repo.dir))!)).toEqual([["l1"], ["a-twin", "b-twin", "l2"], ["l3"]])
  })

  test("branch names with a slash work", async () => {
    const repo = await fixture()
    await layer(repo, "feat/one")
    await layer(repo, "feat/two")
    await repo.git(["switch", "feat/one"])
    expect(names((await readStack(repo.dir))!)).toEqual([["feat/one"], ["feat/two"]])
  })

  test("a fork above is ambiguous unless a top is named", async () => {
    const repo = await fixture()
    await layer(repo, "l1")
    await layer(repo, "l2")
    await layer(repo, "l3a")
    await repo.git(["switch", "l2"])
    await layer(repo, "l3b")
    await repo.git(["switch", "l2"])

    const error = await readStack(repo.dir).catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      code: "invalid_argument",
      details: { candidate_tops: ["l3a", "l3b"], line_branches: ["l1", "l2", "l3a", "l3b"] },
    })
    expect((error as Error).message).toContain("Pass top")

    const stack = (await readStack(repo.dir, { top: "l3b" }))!
    expect(names(stack)).toEqual([["l1"], ["l2"], ["l3b"]])
    expect(stack.position).toBe(1)
  })

  test("a top that is the current branch or not above it", async () => {
    const repo = await threeLayers()
    await repo.git(["switch", "l2"])
    expect(names((await readStack(repo.dir, { top: "l2" }))!)).toEqual([["l1"], ["l2"]])
    expect(names((await readStack(repo.dir, { top: "l3" }))!)).toEqual([["l1"], ["l2"], ["l3"]])
    await expect(readStack(repo.dir, { top: "l1" })).rejects.toMatchObject({ code: "invalid_argument" })
    await expect(readStack(repo.dir, { top: "nope" })).rejects.toMatchObject({ code: "invalid_argument" })
  })

  test("an empty layer above shares the current tip and may be named as the top", async () => {
    const repo = await threeLayers()
    await repo.git(["branch", "l4"])
    const stack = (await readStack(repo.dir, { top: "l4" }))!
    expect(names(stack)).toEqual([["l1"], ["l2"], ["l3", "l4"]])
    expect(topBranch(stack)).toBe("l3")
    expect(layersAbove(stack)).toEqual([])
  })

  test("the default branch, a branch on it and an unrelated branch are never layers", async () => {
    const repo = await threeLayers()
    await repo.git(["branch", "on-main", "main"])
    await repo.git(["switch", "--orphan", "unrelated"])
    await repo.commit("unrelated: 1", { "unrelated.txt": "u\n" })
    await repo.git(["switch", "l2"])
    await repo.git(["branch", "-f", "main", "l3"])
    expect(names((await readStack(repo.dir))!)).toEqual([["l1"], ["l2"], ["l3"]])

    await repo.git(["switch", "on-main"])
    expect(names((await readStack(repo.dir))!)).toEqual([["on-main"]])
  })

  test("is null on a detached HEAD and without a remote default branch", async () => {
    const repo = await threeLayers()
    await repo.git(["checkout", "--detach"])
    expect(await readStack(repo.dir)).toBeNull()

    await repo.git(["switch", "l3"])
    await repo.git(["update-ref", "-d", "refs/remotes/origin/main"])
    expect(await readStack(repo.dir)).toBeNull()

    expect(await readStack((await fixture({ remote: false })).dir)).toBeNull()
  })
})
