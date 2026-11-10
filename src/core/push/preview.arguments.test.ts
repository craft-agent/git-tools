import { afterEach, describe, expect, test } from "bun:test"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { previewOf } from "../../testing/push-fixtures"
import { conflictingStack, layer, startStoppedRebase } from "../../testing/rebase-fixtures"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

async function fixture() {
  const repo = await tempRepo()
  repos.push(repo)
  await layer(repo, "feat")
  return repo
}

/** The error a preview with these arguments fails with. */
async function failure(repo: TempRepo, args: Parameters<typeof previewOf>[1]) {
  const error = await previewOf(repo, args).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(Error)
  return error as Error & { code: string }
}

describe("git_push_read preview arguments", () => {
  test("a branch name that starts with a dash is refused", async () => {
    expect(await failure(await fixture(), { branches: ["--force"] })).toMatchObject({ code: "invalid_argument" })
  })

  test("a remote name that starts with a dash is refused", async () => {
    expect(await failure(await fixture(), { remote: "--mirror" })).toMatchObject({ code: "invalid_argument" })
  })

  test("a blank branch name is refused", async () => {
    expect(await failure(await fixture(), { branches: [" "] })).toMatchObject({ code: "invalid_argument" })
  })

  test("a branch that does not exist is not found", async () => {
    expect(await failure(await fixture(), { branches: ["feat", "nope"] })).toMatchObject({ code: "not_found" })
  })

  test("a remote that does not exist is not found", async () => {
    expect(await failure(await fixture(), { remote: "nope" })).toMatchObject({ code: "not_found" })
  })

  test("a remote that cannot be read keeps git's code and names the remote", async () => {
    const repo = await fixture()
    await repo.git(["remote", "add", "broken", "/nonexistent/remote.git"])
    const error = await failure(repo, { remote: "broken" })
    expect(error.code).toBe("git_error")
    expect(error.message).toStartWith("Could not read broken: git ls-remote failed")
  })

  test("top does not go with branches", async () => {
    expect(await failure(await fixture(), { top: "feat", branches: ["feat"] })).toMatchObject({
      code: "invalid_argument",
    })
  })

  test("a detached HEAD needs branches", async () => {
    const repo = await tempRepo()
    repos.push(repo)
    await conflictingStack(repo)
    await startStoppedRebase(repo)

    expect(await failure(repo, {})).toMatchObject({ code: "invalid_argument" })
    expect((await previewOf(repo, { branches: ["l1"] })).branches).toHaveLength(1)
  })

  test("a line that forks above the branch needs top", async () => {
    const repo = await tempRepo()
    repos.push(repo)
    await layer(repo, "l1")
    await layer(repo, "l2a")
    await repo.git(["switch", "l1"])
    await layer(repo, "l2b")
    await repo.git(["switch", "l1"])

    expect(await failure(repo, {})).toMatchObject({ code: "invalid_argument" })
    expect((await previewOf(repo, { top: "l2a" })).branches.map(({ branch }) => branch)).toEqual(["l1", "l2a"])
  })

  test("a repository that knows no remote default branch pushes the current branch alone", async () => {
    const repo = await fixture()
    await repo.git(["update-ref", "-d", "refs/remotes/origin/main"])
    expect((await previewOf(repo)).branches.map(({ branch }) => branch)).toEqual(["feat"])
  })
})
