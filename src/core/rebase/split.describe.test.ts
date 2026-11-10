import { afterEach, describe, expect, test } from "bun:test"
import { type TempRepo, tempRepo } from "../../testing/git-repo"
import { layer } from "../../testing/rebase-fixtures"
import { callDescription } from "../describe"
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

const describeSplit = (repo: TempRepo, args: Parameters<typeof rebaseSplit.execute>[0]) =>
  callDescription(rebaseSplit, args, { cwd: repo.dir })

const rev = async (repo: TempRepo, ref: string) => (await repo.git(["rev-parse", ref])).trim()

/** A branch `feat` of four commits. */
async function feat() {
  const repo = await fixture()
  await layer(repo, "feat", 4)
  return repo
}

const COMMITS_FACT = { label: "Commits", value: { text: "{commits} commits", values: { commits: 4 } } }

describe("git_rebase_split description", () => {
  test("describes a cut: the new branches with where they start, the commits, the pins", async () => {
    const repo = await feat()
    const first = await rev(repo, "feat~3")
    const second = await rev(repo, "feat~2")

    const description = await describeSplit(repo, { at: ["feat~3", "feat~2"], names: ["low", "mid"] })

    expect(description!.headline).toEqual({
      text: "About to cut {branch} into {layers} layers",
      values: { branch: "feat", layers: "3" },
    })
    expect(description!.facts).toEqual([
      {
        label: "New branches",
        value: `low at ${first.slice(0, 12)} feat: 1; mid at ${second.slice(0, 12)} feat: 2`,
      },
      COMMITS_FACT,
    ])
    expect(description!.pins).toEqual({ head: await rev(repo, "feat"), cut_1: first, cut_2: second })
  })

  test("describes adding a layer: the name, no commits, HEAD as the only pin", async () => {
    const repo = await feat()

    const description = await describeSplit(repo, { add: "next" })

    expect(description!.headline).toEqual({
      text: "About to add the layer {name} on {branch}",
      values: { name: "next", branch: "feat" },
    })
    expect(description!.facts).toEqual([
      { label: "New branches", value: { text: "{name} on top", values: { name: "next" } } },
    ])
    expect(description!.pins).toEqual({ head: await rev(repo, "feat") })
  })

  test("describes a cut with an added layer", async () => {
    const repo = await feat()
    const cut = await rev(repo, "feat~2")

    const description = await describeSplit(repo, { at: ["feat~2"], names: ["low"], add: "next" })

    expect(description!.headline).toEqual({
      text: "About to cut {branch} into {layers} layers and add {name} on top",
      values: { branch: "feat", layers: "2", name: "next" },
    })
    expect(description!.facts).toEqual([
      {
        label: "New branches",
        value: {
          text: "{cuts}; {name} on top",
          values: { cuts: `low at ${cut.slice(0, 12)} feat: 2`, name: "next" },
        },
      },
      COMMITS_FACT,
    ])
    expect(description!.pins).toEqual({ head: await rev(repo, "feat"), cut_1: cut })
  })

  test("gives no description when the call would fail", async () => {
    const repo = await feat()
    expect(await describeSplit(repo, { add: "next" })).toBeDefined()
    expect(await describeSplit(repo, {})).toBeUndefined()
    expect(await describeSplit(repo, { at: ["HEAD"], names: ["a"] })).toBeUndefined()
    expect(await describeSplit(repo, { at: ["HEAD~1"], names: [] })).toBeUndefined()
    expect(await describeSplit(repo, { add: "feat" })).toBeUndefined()
    expect(await describeSplit(repo, { at: ["--upload-pack=x"], names: ["a"] })).toBeUndefined()

    await repo.git(["switch", "--detach"])
    expect(await describeSplit(repo, { add: "next" })).toBeUndefined()
    await repo.git(["switch", "main"])
    expect(await describeSplit(repo, { add: "next" })).toBeUndefined()
  })

  test("changes its pins when the branch gets a commit, and creates nothing", async () => {
    const repo = await feat()
    const refs = () => repo.git(["for-each-ref", "--format=%(refname) %(objectname)"])
    const before = await refs()
    const first = await describeSplit(repo, { at: ["HEAD~1"], names: ["low"], add: "next" })
    expect(await describeSplit(repo, { at: ["HEAD~1"], names: ["low"], add: "next" })).toEqual(first)
    expect(await refs()).toBe(before)
    expect((await repo.git(["symbolic-ref", "--short", "HEAD"])).trim()).toBe("feat")

    await repo.commit("feat: 5", { "feat-5.txt": "5\n" })

    expect((await describeSplit(repo, { at: ["HEAD~2"], names: ["low"], add: "next" }))!.pins!.head).not.toBe(
      first!.pins!.head,
    )
  })
})
