import { afterEach, describe, expect, test } from "bun:test"
import { type TempRepo, tempRepo } from "../../testing/git-repo"
import { layer, pushToMain } from "../../testing/rebase-fixtures"
import { callDescription } from "../describe"
import { rebaseStart } from "./start"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

async function fixture() {
  const repo = await tempRepo()
  repos.push(repo)
  return repo
}

const describeStart = (repo: TempRepo, args: Parameters<typeof rebaseStart.execute>[0] = {}) =>
  callDescription(rebaseStart, args, { cwd: repo.dir })

const rev = async (repo: TempRepo, ref: string) => (await repo.git(["rev-parse", ref])).trim()

/** Layers `l1` and `l2` pushed to origin, with a fixup of `l1`'s commit committed on `l2` after the push. */
async function pushedStackWithFixup() {
  const repo = await fixture()
  await layer(repo, "l1")
  await layer(repo, "l2")
  await repo.git(["push", "origin", "l1", "l2"])
  await repo.commit("fixup! l1: 1", { "fix.txt": "fix\n" })
  return repo
}

/** Layers `l1`, `l2` and `l3` that nobody has pushed, checked out on `l3`. */
async function localStack() {
  const repo = await fixture()
  for (const name of ["l1", "l2", "l3"]) await layer(repo, name)
  return repo
}

describe("git_rebase_start description", () => {
  test("describes the rebase of a pushed stack with a fixup: the push, the layers, the commits and the fixups", async () => {
    const repo = await pushedStackWithFixup()

    const description = await describeStart(repo)

    expect(description!.headline).toEqual({
      text: "About to rebase {branch} onto {onto}",
      values: { branch: "l2", onto: "origin/main" },
    })
    expect(description!.facts).toEqual([
      { label: "Push", value: { text: "needs a force push" } },
      { label: "Layers", value: "l1 → l2" },
      { label: "Commits", value: { text: "{commits} commits", values: { commits: 3 } } },
      { label: "Fixups", value: { text: "{fixups} to fold", values: { fixups: 1 } } },
    ])
    expect(description!.pins).toEqual({
      layers: `l1 ${await rev(repo, "l1")}\nl2 ${await rev(repo, "l2")}`,
      top: await rev(repo, "l2"),
      onto: await rev(repo, "origin/main"),
      upstream: await rev(repo, "main"),
    })
  })

  test("describes folding the fixups on the current base, with no onto", async () => {
    const repo = await pushedStackWithFixup()

    const description = await describeStart(repo, { keep_base: true })

    expect(description!.headline).toEqual({ text: "About to fold the fixups of {branch}", values: { branch: "l2" } })
    expect(description!.facts.map((fact) => fact.label)).toEqual(["Push", "Layers", "Commits", "Fixups"])
    expect(description!.pins).toMatchObject({ onto: await rev(repo, "main"), upstream: await rev(repo, "main") })
  })

  test("names the onto as given, and the layer that landed; an unpushed stack needs no force push", async () => {
    const repo = await localStack()

    const description = await describeStart(repo, { after: "l1", onto: "main" })

    expect(description!.headline).toEqual({
      text: "About to rebase {branch} onto {onto}",
      values: { branch: "l3", onto: "main" },
    })
    expect(description!.facts).toEqual([
      { label: "Layers", value: "l2 → l3" },
      { label: "After", value: "l1" },
      { label: "Commits", value: { text: "{commits} commits", values: { commits: 2 } } },
    ])
    expect(description!.pins).toMatchObject({
      layers: `l2 ${await rev(repo, "l2")}\nl3 ${await rev(repo, "l3")}`,
      upstream: await rev(repo, "l1"),
    })
  })

  test("gives no description when the call would fail", async () => {
    const repo = await localStack()
    await repo.commit("fixup! l1: 1", { "fix.txt": "fix\n" })
    expect(await describeStart(repo)).toBeDefined()
    expect(await describeStart(repo, { onto: "nowhere" })).toBeUndefined()
    expect(await describeStart(repo, { onto: "--upload-pack=x" })).toBeUndefined()
    expect(await describeStart(repo, { keep_base: true, after: "l1" })).toBeUndefined()
    expect(await describeStart(repo, { after: "l3" })).toBeUndefined()

    repo.write("l1-1.txt", "changed\n")
    expect(await describeStart(repo)).toBeUndefined()
    await repo.git(["checkout", "--", "l1-1.txt"])

    await repo.git(["push", "origin", "l1:someone-elses"])
    expect(await describeStart(repo)).toBeUndefined()

    await repo.git(["switch", "--detach"])
    expect(await describeStart(repo)).toBeUndefined()
    await repo.git(["switch", "main"])
    expect(await describeStart(repo)).toBeUndefined()
  })

  test("changes its pins when a layer gets a new commit, and not otherwise", async () => {
    const repo = await pushedStackWithFixup()
    const first = await describeStart(repo)
    expect(await describeStart(repo)).toEqual(first)

    await repo.commit("l2: more", { "more.txt": "more\n" })
    const second = await describeStart(repo)

    expect(second!.pins!.layers).not.toBe(first!.pins!.layers)
    expect(second!.pins!.top).not.toBe(first!.pins!.top)
    expect(second!.pins!.onto).toBe(first!.pins!.onto)
    expect(second!.facts[2]).toEqual({ label: "Commits", value: { text: "{commits} commits", values: { commits: 4 } } })
  })

  test("changes nothing and fetches nothing", async () => {
    const repo = await pushedStackWithFixup()
    await pushToMain(repo, "main: add b", { "b.txt": "b\n" })
    const state = async () => [
      await repo.git(["for-each-ref", "--format=%(refname) %(objectname)"]),
      await repo.git(["reflog", "--all"]),
      await repo.git(["status", "--porcelain"]),
      await repo.git(["rev-parse", "HEAD"]),
    ]
    const before = await state()

    await describeStart(repo)
    await describeStart(repo, { keep_base: true })

    expect(await state()).toEqual(before)
  })
})
