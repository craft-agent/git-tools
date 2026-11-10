import { afterEach, describe, expect, test } from "bun:test"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { addRemote, previewOf } from "../../testing/push-fixtures"
import { layer } from "../../testing/rebase-fixtures"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

/** A repository with the branch `feat` and a second, empty remote `mirror`. */
async function fixture() {
  const repo = await tempRepo()
  repos.push(repo)
  await layer(repo, "feat")
  await addRemote(repo, "mirror")
  return repo
}

const remoteOf = async (repo: TempRepo, args: Parameters<typeof previewOf>[1] = {}) =>
  (await previewOf(repo, args)).remote

describe("git_push_read preview remote", () => {
  test("is origin when git config names none", async () => {
    expect(await remoteOf(await fixture())).toBe("origin")
  })

  test("is the push remote of the branch, then the default push remote, then the remote the branch tracks", async () => {
    const repo = await fixture()
    await repo.git(["config", "branch.feat.remote", "mirror"])
    expect(await remoteOf(repo)).toBe("mirror")

    await repo.git(["remote", "add", "third", repo.remote!])
    await repo.git(["config", "remote.pushDefault", "third"])
    expect(await remoteOf(repo)).toBe("third")

    await repo.git(["config", "branch.feat.pushRemote", "origin"])
    expect(await remoteOf(repo)).toBe("origin")
  })

  test("ignores a branch that tracks a local branch", async () => {
    const repo = await fixture()
    await repo.git(["config", "branch.feat.remote", "."])
    expect(await remoteOf(repo)).toBe("origin")
  })

  test("is the argument when one is given", async () => {
    const repo = await fixture()
    await repo.git(["config", "branch.feat.pushRemote", "origin"])
    expect(await remoteOf(repo, { remote: "mirror" })).toBe("mirror")
  })

  test("reads that remote: an empty one has no default branch and creates the branch", async () => {
    const repo = await fixture()
    const result = await previewOf(repo, { remote: "mirror" })
    expect(result.default_branch).toBeNull()
    expect(result.branches[0]).toMatchObject({ branch: "feat", expect: null, kind: "create" })
    expect(result.send).toMatchObject({ remote: "mirror" })
  })

  test("falls back to the default branch this repository recorded when the remote does not say", async () => {
    const repo = await fixture()
    await repo.git(["symbolic-ref", "refs/remotes/mirror/HEAD", "refs/remotes/mirror/main"])
    expect((await previewOf(repo, { remote: "mirror" })).default_branch).toBe("main")
  })

  test("branches that go to different remotes are refused, naming them", async () => {
    const repo = await fixture()
    await layer(repo, "next")
    await repo.git(["config", "branch.next.pushRemote", "mirror"])

    const error = await previewOf(repo).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: "invalid_argument" })
    expect((error as Error).message).toContain("origin: feat; mirror: next")
    expect((error as Error).message).toContain("pass remote")
    expect((await previewOf(repo, { remote: "origin" })).branches.map(({ branch }) => branch)).toEqual(["feat", "next"])
  })
})
