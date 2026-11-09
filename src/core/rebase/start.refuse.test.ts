import { afterEach, describe, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { dirname, join } from "node:path"
import { conflictingStack, layer, pushToMain, startStoppedRebase } from "../../testing/rebase-fixtures"
import { type TempRepo, tempRepo } from "../../testing/git-repo"
import { invoke } from "../tool"
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

/** A two-layer stack on `l2` whose `origin/main` has moved, so a rebase has something to do. */
async function movedStack() {
  const repo = await fixture()
  await layer(repo, "l1")
  await layer(repo, "l2")
  await pushToMain(repo, "main: add b", { "b.txt": "b\n" })
  return repo
}

const start = (repo: TempRepo, args: Parameters<typeof rebaseStart.execute>[0] = {}) =>
  invoke(rebaseStart, args, { cwd: repo.dir })

/** HEAD and the local branches: the fetch of a refused call may still move `origin/main`. */
const state = async (repo: TempRepo) => [
  await repo.git(["rev-parse", "HEAD"]),
  await repo.git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]),
]

/** The call is refused with `code`, and no local branch moved. */
async function expectRefused(repo: TempRepo, args: Parameters<typeof rebaseStart.execute>[0], code: string) {
  const before = await state(repo)
  await expect(start(repo, args)).rejects.toMatchObject({ code })
  expect(await state(repo)).toEqual(before)
}

describe("git_rebase_start refusals", () => {
  test("refuses uncommitted changes to tracked files, not untracked ones", async () => {
    const repo = await movedStack()
    repo.write("untracked.txt", "x\n")
    await expect(start(repo, { keep_base: true })).resolves.toMatchObject({ status: "up_to_date" })

    repo.write("l1-1.txt", "changed\n")
    await expectRefused(repo, {}, "dirty_tree")
  })

  test("refuses while another rebase is in progress, though HEAD is detached then", async () => {
    const repo = await fixture()
    await conflictingStack(repo)
    await startStoppedRebase(repo)

    await expect(start(repo)).rejects.toMatchObject({ code: "operation_in_progress" })
  })

  test("refuses a detached HEAD", async () => {
    const repo = await movedStack()
    await repo.git(["switch", "--detach"])
    await expectRefused(repo, {}, "invalid_argument")
  })

  test("refuses an onto that is an option, one that is unknown, and keep_base with onto or after", async () => {
    const repo = await movedStack()
    await expectRefused(repo, { onto: "--upload-pack=x" }, "invalid_argument")
    await expectRefused(repo, { onto: "nowhere" }, "not_found")
    await expectRefused(repo, { keep_base: true, onto: "origin/main" }, "invalid_argument")
    await expectRefused(repo, { keep_base: true, after: "l1" }, "invalid_argument")
  })

  test("refuses an after that is not a layer below the top", async () => {
    const repo = await movedStack()
    await expectRefused(repo, { after: "l2" }, "invalid_argument")
    await expectRefused(repo, { after: "main" }, "invalid_argument")
    await expectRefused(repo, { after: "nowhere" }, "invalid_argument")
  })

  test("refuses a layer checked out in another worktree, naming it and its path", async () => {
    const repo = await movedStack()
    const path = join(dirname(repo.dir), "other")
    await repo.git(["worktree", "add", path, "l1"])

    const error = await start(repo).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: "invalid_argument" })
    expect((error as Error).message).toContain("l1")
    expect((error as Error).message).toContain(realpathSync(path))
  })

  test("refuses a rewrite of commits another remote branch holds, with the refusals in details", async () => {
    const repo = await movedStack()
    await repo.git(["push", "origin", "l1:someone-elses"])

    const error = await start(repo).catch((caught: unknown) => caught)

    expect(error).toMatchObject({
      code: "rewrite_refused",
      details: { refusals: [{ rule: "shared" }], warnings: [] },
    })
    await expectRefused(repo, {}, "rewrite_refused")
  })

  test("refuses to rebase the default branch", async () => {
    const repo = await fixture()
    const error = await start(repo).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: "rewrite_refused", details: { refusals: [{ rule: "default_branch" }] } })
  })

  test("refuses where no remote default branch is known", async () => {
    const repo = await tempRepo({ remote: false })
    repos.push(repo)
    await layer(repo, "feat")
    await expect(start(repo)).rejects.toMatchObject({ code: "not_found" })
  })
})
