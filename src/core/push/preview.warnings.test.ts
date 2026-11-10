import { afterEach, describe, expect, test } from "bun:test"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { previewOf } from "../../testing/push-fixtures"
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

/** Moves `origin/main` ahead of the branches, and fetches it. */
async function moveMain(repo: TempRepo): Promise<void> {
  await pushToMain(repo, "main: moves", { "main.txt": "m\n" })
  await repo.git(["fetch", "origin", "main"])
}

describe("git_push_read preview warnings", () => {
  test("warns of uncommitted changes to tracked files, which are not pushed", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    repo.write("README.md", "# Changed\n")
    repo.write("untracked.txt", "u\n")

    const result = await previewOf(repo)
    expect(result.warnings).toEqual(["1 tracked file(s) have uncommitted changes; they are not pushed."])
    expect(result.send).not.toBeNull()
  })

  test("warns of a line that does not contain the remote's default branch, once for all its branches", async () => {
    const repo = await fixture()
    await layer(repo, "l1")
    await layer(repo, "l2")
    await moveMain(repo)

    const result = await previewOf(repo)
    expect(result.warnings).toEqual([
      "l1, l2 are behind origin/main; rebase them first if a pull request should be current.",
    ])
  })

  test("does not warn of a branch that is up to date, or of one that contains the default branch", async () => {
    const repo = await fixture()
    await layer(repo, "l1")
    await repo.git(["push", "origin", "l1"])
    await moveMain(repo)
    await layer(repo, "l2")
    await repo.git(["rebase", "origin/main"])

    const result = await previewOf(repo, { branches: ["l1", "l2"] })
    expect(result.warnings).toEqual([])
  })

  test("warns of a layer with no commits of its own over the default branch", async () => {
    const repo = await fixture()
    await repo.git(["branch", "empty"])

    const result = await previewOf(repo, { branches: ["empty"] })
    expect(result.warnings).toEqual(["empty has no commits of its own over origin/main."])
  })

  test("warns of a branch that sits on the same commit as the one of its layer", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    await repo.git(["switch", "-c", "feat-next"])

    const result = await previewOf(repo)
    expect(result.branches.map(({ branch }) => branch)).toEqual(["feat-next", "feat"])
    expect(result.warnings).toEqual(["feat is at the same commit as feat-next, so it has no commits of its own."])
  })
})
