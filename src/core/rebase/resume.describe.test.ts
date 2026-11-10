import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { type TempRepo, tempRepo } from "../../testing/git-repo"
import { CONFLICT_FILE, conflictingStack, layer, startStoppedRebase } from "../../testing/rebase-fixtures"
import { callDescription } from "../describe"
import { PIN_PATTERN } from "../pin"
import { shortSha } from "../rewrite"
import { rebaseResume } from "./resume"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

/** A stack of three layers stopped on the conflict of the middle one. */
async function stoppedStack() {
  const repo = await tempRepo()
  repos.push(repo)
  await conflictingStack(repo)
  await startStoppedRebase(repo)
  return repo
}

const describeResume = (repo: TempRepo, action: "continue" | "skip" | "abort") =>
  callDescription(rebaseResume, { action }, { cwd: repo.dir })

const rev = async (repo: TempRepo, ref: string) => (await repo.git(["rev-parse", ref])).trim()

describe("git_rebase_resume description", () => {
  test("describes a continue with the pins of the stop and of the files, and no file count while markers are left", async () => {
    const repo = await stoppedStack()

    const description = await describeResume(repo, "continue")

    expect(description!.headline).toEqual({
      text: "About to continue the rebase of {branch}",
      values: { branch: "l3" },
    })
    expect(description!.facts).toEqual([])
    expect(description!.pins).toEqual({
      rebase_head: await rev(repo, "REBASE_HEAD"),
      head: await rev(repo, "HEAD"),
      unmerged: expect.stringMatching(PIN_PATTERN),
    })
  })

  test("counts the files it would stage once they are resolved, and pins their contents", async () => {
    const repo = await stoppedStack()
    const marked = await describeResume(repo, "continue")

    writeFileSync(join(repo.dir, CONFLICT_FILE), "# Test\nresolved\n")
    const resolved = await describeResume(repo, "continue")

    expect(resolved!.facts).toEqual([{ label: "Files", value: { text: "{files} file", values: { files: 1 } } }])
    expect(resolved!.pins!.unmerged).not.toBe(marked!.pins!.unmerged)
    expect(resolved!.pins!.head).toBe(marked!.pins!.head)

    writeFileSync(join(repo.dir, CONFLICT_FILE), "# Test\nresolved differently\n")
    expect((await describeResume(repo, "continue"))!.pins!.unmerged).not.toBe(resolved!.pins!.unmerged)
  })

  test("names the commit a skip drops", async () => {
    const repo = await stoppedStack()

    const description = await describeResume(repo, "skip")

    expect(description!.headline).toEqual({
      text: "About to skip {commit} in the rebase of {branch}",
      values: { commit: `${shortSha(await rev(repo, "REBASE_HEAD"))} l2: change the readme`, branch: "l3" },
    })
    expect(description!.facts).toEqual([])
    expect(description!.pins).not.toHaveProperty("unmerged")
  })

  test("names the branches an abort puts back, bottom to top", async () => {
    const repo = await stoppedStack()

    const description = await describeResume(repo, "abort")

    expect(description!.headline).toEqual({ text: "About to abort the rebase of {branch}", values: { branch: "l3" } })
    expect(description!.facts).toEqual([{ label: "Layers", value: "l1 → l2 → l3" }])
  })

  test("gives no description when no rebase is in progress, or a merge stands in the way", async () => {
    const repo = await tempRepo()
    repos.push(repo)
    await layer(repo, "feat")
    expect(await describeResume(repo, "continue")).toBeUndefined()

    writeFileSync(join(repo.dir, ".git", "MERGE_HEAD"), `${await rev(repo, "main")}\n`)
    expect(await describeResume(repo, "abort")).toBeUndefined()
  })

  test("changes nothing", async () => {
    const repo = await stoppedStack()
    const state = async () => [
      await repo.git(["for-each-ref", "--format=%(refname) %(objectname)"]),
      await repo.git(["reflog", "--all"]),
      await repo.git(["status", "--porcelain"]),
      await repo.git(["ls-files", "--stage"]),
    ]
    const before = await state()

    for (const action of ["continue", "skip", "abort"] as const) await describeResume(repo, action)

    expect(await state()).toEqual(before)
  })
})
