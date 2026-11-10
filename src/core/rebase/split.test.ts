import { afterEach, describe, expect, test } from "bun:test"
import { type TempRepo, tempRepo } from "../../testing/git-repo"
import { layer } from "../../testing/rebase-fixtures"
import { invoke } from "../tool"
import { rebaseSplit } from "./split"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

async function fixture() {
  const repo = await tempRepo()
  repos.push(repo)
  return repo
}

const split = (repo: TempRepo, args: Parameters<typeof rebaseSplit.execute>[0]) =>
  invoke(rebaseSplit, args, { cwd: repo.dir })

const rev = async (repo: TempRepo, ref: string) => (await repo.git(["rev-parse", ref])).trim()
const short = async (repo: TempRepo, ref: string) => (await rev(repo, ref)).slice(0, 12)
const head = async (repo: TempRepo) => (await repo.git(["symbolic-ref", "--short", "HEAD"])).trim()

describe("git_rebase_split", () => {
  test("cuts a branch of four commits at the first and second into three layers", async () => {
    const repo = await fixture()
    await layer(repo, "feat", 4)
    const tip = await rev(repo, "feat")

    const result = await split(repo, { at: ["HEAD~3", "HEAD~2"], names: ["low", "mid"] })

    expect(result.root).toBe(repo.dir)
    expect(result.branch).toBe("feat")
    expect(result.created).toEqual(["low", "mid"])
    expect(await rev(repo, "low")).toBe(await rev(repo, "feat~3"))
    expect(await rev(repo, "mid")).toBe(await rev(repo, "feat~2"))
    expect(await rev(repo, "feat")).toBe(tip)
    expect(await head(repo)).toBe("feat")
    expect(result.layers).toEqual([
      { branches: ["low"], tip: await short(repo, "low"), count: 1 },
      { branches: ["mid"], tip: await short(repo, "mid"), count: 1 },
      { branches: ["feat"], tip: await short(repo, "feat"), count: 2 },
    ])
  })

  test("sets no upstream on the new branches", async () => {
    const repo = await fixture()
    await layer(repo, "feat", 2)

    await split(repo, { at: ["HEAD~1"], names: ["low"] })

    const merge = await repo.git(["config", "--get", "branch.low.merge"]).catch(() => "")
    expect(merge).toBe("")
  })

  test("adds a layer on top: a new branch at the same commit, checked out, uncommitted edits kept", async () => {
    const repo = await fixture()
    await layer(repo, "feat", 2)
    repo.write("feat-1.txt", "edited\n")
    repo.write("untracked.txt", "x\n")

    const result = await split(repo, { add: "next" })

    expect(result.branch).toBe("next")
    expect(result.created).toEqual(["next"])
    expect(await head(repo)).toBe("next")
    expect(await rev(repo, "next")).toBe(await rev(repo, "feat"))
    expect((await repo.git(["status", "--porcelain"])).split("\n").filter(Boolean)).toEqual([
      " M feat-1.txt",
      "?? untracked.txt",
    ])
    expect(result.layers).toEqual([{ branches: ["next", "feat"], tip: await short(repo, "feat"), count: 2 }])
  })

  test("cuts and adds together: the cuts are made below, the new layer starts on top", async () => {
    const repo = await fixture()
    await layer(repo, "feat", 3)

    const result = await split(repo, { at: ["HEAD~2"], names: ["low"], add: "next" })

    expect(result.branch).toBe("next")
    expect(result.created).toEqual(["low", "next"])
    expect(await head(repo)).toBe("next")
    expect(result.layers.map((entry) => entry.branches)).toEqual([["low"], ["next", "feat"]])
    expect(result.layers.map((entry) => entry.count)).toEqual([1, 2])
  })

  test("cuts the middle layer of a stack inside that layer only", async () => {
    const repo = await fixture()
    await layer(repo, "l1")
    await layer(repo, "l2", 3)
    await layer(repo, "l3")
    await repo.git(["switch", "l2"])

    const result = await split(repo, { at: ["l2~1"], names: ["l2-low"] })

    expect(result.branch).toBe("l2")
    expect(result.layers.map((entry) => entry.branches)).toEqual([["l1"], ["l2-low"], ["l2"], ["l3"]])
    expect(result.layers.map((entry) => entry.count)).toEqual([1, 2, 1, 1])
    expect(await rev(repo, "l2-low")).toBe(await rev(repo, "l2~1"))
  })

  test("cuts below layers that fork above, which a cut does not care about", async () => {
    const repo = await fixture()
    await layer(repo, "base", 3)
    await layer(repo, "a")
    await repo.git(["switch", "base"])
    await layer(repo, "b")
    await repo.git(["switch", "base"])

    const result = await split(repo, { at: ["HEAD~1"], names: ["low"] })

    expect(result.created).toEqual(["low"])
    expect(result.layers.map((entry) => entry.branches)).toEqual([["low"], ["base"]])
  })
})
