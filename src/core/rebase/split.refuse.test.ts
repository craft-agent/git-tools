import { afterEach, describe, expect, test } from "bun:test"
import { conflictingStack, layer, startStoppedRebase } from "../../testing/rebase-fixtures"
import { type TempRepo, tempRepo } from "../../testing/git-repo"
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

type Args = Parameters<typeof rebaseSplit.execute>[0]

const split = (repo: TempRepo, args: Args) => invoke(rebaseSplit, args, { cwd: repo.dir })

/** HEAD and the local branches. */
const state = async (repo: TempRepo) => [
  await repo.git(["rev-parse", "HEAD"]),
  await repo.git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]),
]

/** The call is refused with `code`, and no branch was created or moved. */
async function expectRefused(repo: TempRepo, args: Args, code: string) {
  const before = await state(repo)
  await expect(split(repo, args)).rejects.toMatchObject({ code })
  expect(await state(repo)).toEqual(before)
}

/** A branch `feat` of four commits. */
async function feat() {
  const repo = await fixture()
  await layer(repo, "feat", 4)
  return repo
}

describe("git_rebase_split refusals", () => {
  test("refuses cuts and names that differ in number, and a call that does nothing", async () => {
    const repo = await feat()
    await expectRefused(repo, { at: ["HEAD~2", "HEAD~1"], names: ["a"] }, "invalid_argument")
    await expectRefused(repo, { at: ["HEAD~2"], names: ["a", "b"] }, "invalid_argument")
    await expectRefused(repo, { names: ["a"] }, "invalid_argument")
    await expectRefused(repo, {}, "invalid_argument")
  })

  test("refuses the tip as a cut", async () => {
    const repo = await feat()
    await expectRefused(repo, { at: ["HEAD"], names: ["a"] }, "invalid_argument")
    await expectRefused(repo, { at: ["feat"], names: ["a"] }, "invalid_argument")
  })

  test("refuses cuts out of order, and the same commit twice", async () => {
    const repo = await feat()
    await expectRefused(repo, { at: ["HEAD~1", "HEAD~2"], names: ["a", "b"] }, "invalid_argument")
    await expectRefused(repo, { at: ["HEAD~2", "HEAD~2"], names: ["a", "b"] }, "invalid_argument")
  })

  test("refuses a commit of the layer below or of main", async () => {
    const repo = await fixture()
    await layer(repo, "l1", 2)
    await layer(repo, "l2", 3)
    await expectRefused(repo, { at: ["l1"], names: ["a"] }, "invalid_argument")
    await expectRefused(repo, { at: ["main"], names: ["a"] }, "invalid_argument")
  })

  test("refuses an unknown commit as not found, and an option as a cut", async () => {
    const repo = await feat()
    await expectRefused(repo, { at: ["nowhere"], names: ["a"] }, "not_found")
    await expectRefused(repo, { at: ["--upload-pack=x"], names: ["a"] }, "invalid_argument")
  })

  test("refuses cutting a layer that holds a merge commit", async () => {
    const repo = await fixture()
    await repo.git(["switch", "-c", "feat"])
    await repo.commit("feat: 1", { "one.txt": "1\n" })
    await repo.git(["switch", "-c", "side", "main"])
    await repo.commit("side: 1", { "side.txt": "1\n" })
    await repo.git(["switch", "feat"])
    await repo.git(["merge", "--no-ff", "-m", "merge side", "side"])
    await repo.commit("feat: 2", { "two.txt": "2\n" })
    await expectRefused(repo, { at: ["HEAD~2"], names: ["a"] }, "invalid_argument")
  })

  test("refuses names that are options, malformed, taken, on origin only, repeated or the current branch", async () => {
    const repo = await feat()
    await repo.git(["branch", "taken"])
    await repo.git(["push", "origin", "feat:remote-only"])
    await repo.git(["fetch", "origin"])
    const at = ["HEAD~2"]
    for (const name of ["--force", "a..b", "taken", "remote-only", "feat", "", "@{-1}"]) {
      await expectRefused(repo, { at, names: [name] }, "invalid_argument")
    }
    await expectRefused(repo, { at: ["HEAD~2", "HEAD~1"], names: ["same", "same"] }, "invalid_argument")
    await expectRefused(repo, { at, names: ["same"], add: "same" }, "invalid_argument")
    await expectRefused(repo, { add: "taken" }, "invalid_argument")
    await expectRefused(repo, { add: "remote-only" }, "invalid_argument")
  })

  test("refuses adding a layer from a layer with layers above it", async () => {
    const repo = await fixture()
    await layer(repo, "l1")
    await layer(repo, "l2")
    await repo.git(["switch", "l1"])
    await expectRefused(repo, { add: "next" }, "invalid_argument")
  })

  test("refuses adding a layer where the branches above fork", async () => {
    const repo = await fixture()
    await layer(repo, "base")
    await layer(repo, "a")
    await repo.git(["switch", "base"])
    await layer(repo, "b")
    await repo.git(["switch", "base"])
    await expectRefused(repo, { add: "next" }, "invalid_argument")
  })

  test("refuses a detached HEAD and the default branch", async () => {
    const repo = await feat()
    await repo.git(["switch", "--detach"])
    await expectRefused(repo, { at: ["HEAD~1"], names: ["a"] }, "invalid_argument")
    await repo.git(["switch", "main"])
    await expectRefused(repo, { add: "next" }, "invalid_argument")
  })

  test("refuses while another operation is in progress", async () => {
    const repo = await fixture()
    await conflictingStack(repo)
    await startStoppedRebase(repo)
    await expect(split(repo, { add: "next" })).rejects.toMatchObject({ code: "operation_in_progress" })
  })
})
