import { afterEach, describe, expect, test } from "bun:test"
import { tempRepo, type TempRepo } from "../testing/git-repo"
import { checkRewrite, currentBranch, needsForcePush, ownRemoteRefs } from "./rewrite"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

async function fixture(options?: Parameters<typeof tempRepo>[0]) {
  const repo = await tempRepo(options)
  repos.push(repo)
  return repo
}

/** A repository on branch `feat` cut from main, with one commit of its own. */
async function withFeatCommit(options?: Parameters<typeof tempRepo>[0]) {
  const repo = await fixture(options)
  await repo.git(["switch", "-c", "feat"])
  const sha = await repo.commit("feat: one", { "one.txt": "1\n" })
  return { repo, sha }
}

describe("checkRewrite", () => {
  test("allows an unpushed branch commit without a force push", async () => {
    const { repo, sha } = await withFeatCommit()
    expect(await checkRewrite(repo.dir, sha)).toEqual({
      allowed: true,
      branch: "feat",
      published: [],
      needs_force_push: false,
      refusals: [],
      warnings: [],
    })
  })

  test("allows a pushed branch commit, which then needs a force push", async () => {
    const { repo, sha } = await withFeatCommit()
    await repo.git(["push", "-u", "origin", "feat"])
    expect(await checkRewrite(repo.dir, sha)).toMatchObject({
      allowed: true,
      published: ["origin/feat"],
      needs_force_push: true,
      refusals: [],
      warnings: [],
    })
  })

  test.each(["https://github.com/o/r.git", "git@github.com:o/r.git", "ssh://git@github.com/o/r.git"])(
    "warns that protection was not checked when the remote is on GitHub (%s)",
    async (url) => {
      const { repo, sha } = await withFeatCommit()
      await repo.git(["push", "-u", "origin", "feat"])
      await repo.git(["config", "remote.origin.url", url])
      const check = await checkRewrite(repo.dir, sha)
      expect(check.allowed).toBe(true)
      expect(check.warnings).toHaveLength(1)
      expect(check.warnings[0]).toContain("origin/feat is on GitHub")
    },
  )

  test("gives no GitHub warning for another host", async () => {
    const { repo, sha } = await withFeatCommit()
    await repo.git(["push", "-u", "origin", "feat"])
    await repo.git(["config", "remote.origin.url", "https://example.com/github.com/o/r.git"])
    expect((await checkRewrite(repo.dir, sha)).warnings).toEqual([])
  })

  test("refuses the default branch", async () => {
    const repo = await fixture()
    const sha = await repo.commit("fix: local on main", { "a.txt": "a\n" })
    const check = await checkRewrite(repo.dir, sha)
    expect(check.allowed).toBe(false)
    expect(check.refusals).toEqual([
      { rule: "default_branch", message: expect.stringContaining("main is the default branch") },
    ])
  })

  test("refuses a commit already merged into the default branch", async () => {
    const { repo } = await withFeatCommit()
    const initial = (await repo.git(["rev-parse", "main"])).trim()
    const check = await checkRewrite(repo.dir, initial)
    expect(check.allowed).toBe(false)
    expect(check.refusals[0]).toMatchObject({ rule: "merged" })
    expect(check.refusals[0]!.message).toContain(`${initial.slice(0, 12)} is already on origin/main`)
  })

  test("refuses commits another remote branch holds, naming it", async () => {
    const { repo, sha } = await withFeatCommit()
    await repo.git(["push", "origin", "feat:someone-else"])
    const check = await checkRewrite(repo.dir, sha)
    expect(check.allowed).toBe(false)
    expect(check.refusals).toHaveLength(1)
    expect(check.refusals[0]).toMatchObject({ rule: "shared" })
    expect(check.refusals[0]!.message).toContain("origin/someone-else")
  })

  test("refuses a detached HEAD", async () => {
    const { repo, sha } = await withFeatCommit()
    await repo.git(["checkout", "--detach"])
    expect(await checkRewrite(repo.dir, sha)).toMatchObject({
      allowed: false,
      branch: null,
      refusals: [{ rule: "detached" }],
    })
  })

  test("refuses when a remote exists but its default branch is unknown", async () => {
    const repo = await fixture()
    await repo.git(["switch", "-c", "develop"])
    const sha = await repo.commit("feat: one", { "one.txt": "1\n" })
    await repo.git(["push", "-u", "origin", "develop"])
    await repo.git(["update-ref", "-d", "refs/remotes/origin/main"])
    const check = await checkRewrite(repo.dir, sha)
    expect(check.allowed).toBe(false)
    expect(check.refusals[0]).toMatchObject({ rule: "default_branch" })
    expect(check.refusals[0]!.message).toContain("remote default branch is not known here")
  })

  test("with no remote at all, allows a branch and refuses main", async () => {
    const { repo, sha } = await withFeatCommit({ remote: false })
    expect(await checkRewrite(repo.dir, sha)).toMatchObject({ allowed: true, published: [], refusals: [] })

    await repo.git(["switch", "main"])
    expect(await checkRewrite(repo.dir, (await repo.git(["rev-parse", "HEAD"])).trim())).toMatchObject({
      allowed: false,
      refusals: [{ rule: "default_branch" }],
    })
  })

  test("throws not_found for a commit it cannot resolve", async () => {
    const { repo } = await withFeatCommit()
    await expect(checkRewrite(repo.dir, "no-such-commit")).rejects.toMatchObject({ code: "not_found" })
    await expect(checkRewrite(repo.dir, "HEAD", { base: "no-such-commit" })).rejects.toMatchObject({
      code: "not_found",
    })
  })

  test("checks the range after `base` when one is given", async () => {
    const { repo, sha: one } = await withFeatCommit()
    const two = await repo.commit("feat: two", { "two.txt": "2\n" })
    await repo.git(["push", "origin", `${one}:refs/heads/other`])

    expect((await checkRewrite(repo.dir, two)).allowed).toBe(true)
    expect((await checkRewrite(repo.dir, one)).refusals[0]).toMatchObject({ rule: "shared" })
    const ranged = await checkRewrite(repo.dir, two, { base: "main" })
    expect(ranged.refusals[0]).toMatchObject({ rule: "shared" })
    expect(ranged.refusals[0]!.message).toContain("origin/other")
  })
})

describe("the branch and its remote refs", () => {
  test("currentBranch is null on a detached HEAD", async () => {
    const { repo } = await withFeatCommit()
    expect(await currentBranch(repo.dir)).toBe("feat")
    await repo.git(["checkout", "--detach"])
    expect(await currentBranch(repo.dir)).toBeNull()
  })

  test("a branch tracking another name does not own that remote branch", async () => {
    const { repo } = await withFeatCommit()
    await repo.git(["push", "origin", "feat:feat-a"])
    await repo.git(["fetch", "origin"])
    await repo.git(["switch", "-c", "feat-b", "--track", "origin/feat-a"])
    expect(await ownRemoteRefs(repo.dir, "feat-b")).toEqual([])
    expect(await ownRemoteRefs(repo.dir, "feat-a")).toEqual([
      { remote: "origin", name: "feat-a", ref: "origin/feat-a" },
    ])
  })

  test("needsForcePush is true once HEAD no longer contains the pushed branch", async () => {
    const { repo } = await withFeatCommit()
    await repo.git(["push", "-u", "origin", "feat"])
    expect(await needsForcePush(repo.dir, "feat")).toBe(false)
    await repo.git(["commit", "--amend", "-m", "feat: one, reworded"])
    expect(await needsForcePush(repo.dir, "feat")).toBe(true)
  })
})
