import { afterEach, describe, expect, test } from "bun:test"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { fullSha, previewOf, shortOf } from "../../testing/push-fixtures"
import { layer, pushToMain } from "../../testing/rebase-fixtures"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

async function fixture() {
  const repo = await tempRepo()
  repos.push(repo)
  return repo
}

describe("git_push_read preview", () => {
  test("a branch the remote lacks is created, with its commits and the send arguments", async () => {
    const repo = await fixture()
    await layer(repo, "feat", 2)
    const tip = await fullSha(repo, "feat")

    const result = await previewOf(repo)
    expect(result).toMatchObject({
      root: repo.dir,
      remote: "origin",
      default_branch: "main",
      refusals: [],
      warnings: [],
    })
    expect(result.branches).toEqual([
      {
        branch: "feat",
        sha: tip,
        expect: null,
        kind: "create",
        commits: {
          count: 2,
          items: [
            { sha: await shortOf(repo, "feat~1"), subject: "feat: 1" },
            { sha: await shortOf(repo, "feat"), subject: "feat: 2" },
          ],
        },
        drops: null,
      },
    ])
    expect(result.send).toEqual({ remote: "origin", branches: [{ branch: "feat", sha: tip, expect: null }] })
  })

  test("a pushed branch with one more commit is a fast-forward leased on the remote tip", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    await repo.git(["push", "-u", "origin", "feat"])
    const remoteTip = await fullSha(repo, "feat")
    await repo.commit("feat: more", { "more.txt": "1\n" })

    const result = await previewOf(repo)
    expect(result.branches).toEqual([
      {
        branch: "feat",
        sha: await fullSha(repo, "feat"),
        expect: remoteTip,
        kind: "fast_forward",
        commits: { count: 1, items: [{ sha: await shortOf(repo, "feat"), subject: "feat: more" }] },
        drops: null,
      },
    ])
    expect(result.send?.branches).toEqual([{ branch: "feat", sha: await fullSha(repo, "feat"), expect: remoteTip }])
  })

  test("a branch the remote already holds is up to date and sends nothing", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    await repo.git(["push", "-u", "origin", "feat"])

    const result = await previewOf(repo)
    expect(result.branches).toEqual([
      {
        branch: "feat",
        sha: await fullSha(repo, "feat"),
        expect: await fullSha(repo, "feat"),
        kind: "none",
        commits: { count: 0, items: [] },
        drops: null,
      },
    ])
    expect(result.refusals).toEqual([])
    expect(result.send).toBeNull()
  })

  test("a rebase onto a moved main is a force push that drops nothing, since its changes are kept", async () => {
    const repo = await fixture()
    await layer(repo, "feat", 2)
    await repo.git(["push", "-u", "origin", "feat"])
    const remoteTip = await fullSha(repo, "feat")
    await pushToMain(repo, "main: moves", { "main.txt": "m\n" })
    await repo.git(["fetch", "origin", "main"])
    await repo.git(["rebase", "origin/main"])

    const result = await previewOf(repo)
    expect(result.branches[0]).toMatchObject({
      branch: "feat",
      expect: remoteTip,
      kind: "force",
      commits: { count: 2 },
      drops: { count: 0, items: [] },
    })
    expect(result.warnings).toEqual([])
    expect(result.send?.branches).toEqual([{ branch: "feat", sha: await fullSha(repo, "feat"), expect: remoteTip }])
  })

  test("a force push lists the remote commit whose change is gone, and warns", async () => {
    const repo = await fixture()
    await layer(repo, "feat", 2)
    await repo.git(["push", "-u", "origin", "feat"])
    const dropped = await shortOf(repo, "feat")
    await repo.git(["reset", "--hard", "HEAD~1"])
    await repo.commit("feat: replacement", { "other.txt": "x\n" })

    const result = await previewOf(repo)
    expect(result.branches[0]).toMatchObject({
      kind: "force",
      commits: { count: 1, items: [{ subject: "feat: replacement" }] },
      drops: { count: 1, items: [{ sha: dropped, subject: "feat: 2" }] },
    })
    expect(result.warnings).toEqual([
      "The force push of feat drops 1 commit(s) of origin/feat whose change is not on it; see drops.",
    ])
    expect(result.refusals).toEqual([])
  })

  test("a line of three layers pushes the ones the remote lacks, bottom to top", async () => {
    const repo = await fixture()
    await layer(repo, "l1")
    await layer(repo, "l2")
    await layer(repo, "l3")
    await repo.git(["push", "origin", "l1"])

    const result = await previewOf(repo)
    expect(result.branches.map(({ branch, kind, commits }) => [branch, kind, commits.count])).toEqual([
      ["l1", "none", 0],
      ["l2", "create", 1],
      ["l3", "create", 2],
    ])
    expect(result.send).toEqual({
      remote: "origin",
      branches: [
        { branch: "l2", sha: await fullSha(repo, "l2"), expect: null },
        { branch: "l3", sha: await fullSha(repo, "l3"), expect: null },
      ],
    })
  })

  test("branches picks some of them, once each, in the given order", async () => {
    const repo = await fixture()
    await layer(repo, "l1")
    await layer(repo, "l2")
    await layer(repo, "l3")

    const result = await previewOf(repo, { branches: ["l2", "l1", "l2"] })
    expect(result.branches.map(({ branch }) => branch)).toEqual(["l2", "l1"])
    expect(result.send?.branches.map(({ branch }) => branch)).toEqual(["l2", "l1"])
  })

  test("the commits of a created branch leave out what another remote branch holds", async () => {
    const repo = await fixture()
    await layer(repo, "l1", 2)
    await repo.git(["push", "origin", "l1:other"])
    await layer(repo, "l2")

    const result = await previewOf(repo, { branches: ["l2"] })
    expect(result.branches[0]!.commits).toMatchObject({ count: 1, items: [{ subject: "l2: 1" }] })
  })

  test("lists at most thirty commits and counts them all", async () => {
    const repo = await fixture()
    await layer(repo, "feat", 32)

    const { commits } = (await previewOf(repo)).branches[0]!
    expect(commits.count).toBe(32)
    expect(commits.items).toHaveLength(30)
    expect(commits.items[0]!.subject).toBe("feat: 1")
  })
})
