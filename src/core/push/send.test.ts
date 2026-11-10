import { afterEach, describe, expect, test } from "bun:test"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { fullSha, previewedSend, remoteHead, sendOf } from "../../testing/push-fixtures"
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

const FULL_SHA = /^[0-9a-f]{40}$/

describe("git_push_send", () => {
  test("pushes a new branch as previewed, sets its upstream and returns the full commit", async () => {
    const repo = await fixture()
    await layer(repo, "feat", 2)
    const tip = await fullSha(repo, "feat")

    const result = await sendOf(repo, await previewedSend(repo))

    expect(result).toMatchObject({
      root: repo.dir,
      remote: "origin",
      branches: [{ branch: "feat", sha: tip, kind: "create", pushed: true }],
      accepted: [],
      warnings: [],
    })
    expect(result.branches[0]!.sha).toMatch(FULL_SHA)
    expect(result.output).toContain("refs/heads/feat")
    expect(await remoteHead(repo, "feat")).toBe(tip)
    expect((await repo.git(["rev-parse", "--abbrev-ref", "feat@{upstream}"])).trim()).toBe("origin/feat")
  })

  test("keeps the upstream a created branch already has", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    await repo.git(["config", "branch.feat.remote", "origin"])
    await repo.git(["config", "branch.feat.merge", "refs/heads/elsewhere"])

    await sendOf(repo, await previewedSend(repo))

    expect((await repo.git(["config", "branch.feat.merge"])).trim()).toBe("refs/heads/elsewhere")
  })

  test("pushes a fast-forward leased on the remote tip", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    await repo.git(["push", "-u", "origin", "feat"])
    await repo.commit("feat: more", { "more.txt": "1\n" })
    const tip = await fullSha(repo, "feat")

    const result = await sendOf(repo, await previewedSend(repo))

    expect(result.branches).toEqual([{ branch: "feat", sha: tip, kind: "fast_forward", pushed: true }])
    expect(await remoteHead(repo, "feat")).toBe(tip)
  })

  test("pushes a force after a rebase, leased on the old remote commit", async () => {
    const repo = await fixture()
    await layer(repo, "feat", 2)
    await repo.git(["push", "-u", "origin", "feat"])
    const old = await fullSha(repo, "feat")
    await pushToMain(repo, "main: moves", { "main.txt": "m\n" })
    await repo.git(["fetch", "origin", "main"])
    await repo.git(["rebase", "origin/main"])
    const send = await previewedSend(repo)
    expect(send.branches[0]!.expect).toBe(old)

    const result = await sendOf(repo, send)

    expect(result.branches).toEqual([{ branch: "feat", sha: await fullSha(repo, "feat"), kind: "force", pushed: true }])
    expect(await remoteHead(repo, "feat")).toBe(await fullSha(repo, "feat"))
    expect(await remoteHead(repo, "feat")).not.toBe(old)
  })

  test("pushes a line of three layers in one atomic push", async () => {
    const repo = await fixture()
    await layer(repo, "l1")
    await layer(repo, "l2")
    await layer(repo, "l3")
    const send = await previewedSend(repo)
    expect(send.branches.map(({ branch }) => branch)).toEqual(["l1", "l2", "l3"])

    const result = await sendOf(repo, send)

    expect(result.branches.map(({ branch, kind, pushed }) => [branch, kind, pushed])).toEqual([
      ["l1", "create", true],
      ["l2", "create", true],
      ["l3", "create", true],
    ])
    for (const name of ["l1", "l2", "l3"]) {
      expect(await remoteHead(repo, name)).toBe(await fullSha(repo, name))
      expect(result.output).toContain(`refs/heads/${name}`)
    }
  })

  test("returns the preview's warnings", async () => {
    const repo = await fixture()
    await layer(repo, "feat", 2)
    await repo.git(["push", "-u", "origin", "feat"])
    await repo.git(["reset", "--hard", "HEAD~1"])
    await repo.commit("feat: replacement", { "other.txt": "x\n" })

    const result = await sendOf(repo, await previewedSend(repo))

    expect(result.warnings).toEqual([
      "The force push of feat drops 1 commit(s) of origin/feat whose change is not on it; see drops.",
    ])
  })
})
