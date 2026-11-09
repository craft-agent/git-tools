import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { type TempRepo, tempRepo } from "../../testing/git-repo"
import { CONFLICT_FILE, conflictingStack, layer, startStoppedRebase } from "../../testing/rebase-fixtures"
import { shortSha } from "../rewrite"
import { invoke } from "../tool"
import { operationInProgress } from "../tree"
import { rebaseResume } from "./resume"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

async function fixture() {
  const repo = await tempRepo()
  repos.push(repo)
  return repo
}

/** A stack stopped on the conflict of its middle layer, with the tips it had before. */
async function stoppedStack() {
  const repo = await fixture()
  const { before } = await conflictingStack(repo)
  await startStoppedRebase(repo)
  return { repo, before }
}

const resume = (repo: TempRepo, action: "continue" | "skip" | "abort") =>
  invoke(rebaseResume, { action }, { cwd: repo.dir })

const rev = async (repo: TempRepo, ref: string) => (await repo.git(["rev-parse", ref])).trim()

describe("git_rebase_resume", () => {
  test("continue with conflict markers left runs nothing and names the unresolved files", async () => {
    const { repo, before } = await stoppedStack()

    const result = await resume(repo, "continue")

    expect(result).toMatchObject({ status: "paused", branch: null, top: "l3" })
    expect(result.paused).toMatchObject({
      reason: "conflicts",
      unresolved: [CONFLICT_FILE],
      conflicts: { count: 1 },
      stopped_on: { subject: "l2: change the readme" },
    })
    expect(result.layers.map((item) => item.branch)).toEqual(["l1", "l2", "l3"])
    expect(await operationInProgress(repo.dir)).toBe("rebase")
    expect(await repo.git(["diff", "--name-only", "--diff-filter=U"])).toBe(`${CONFLICT_FILE}\n`)
    expect(await rev(repo, "l2")).toBe(before.l2)
  })

  test("continue stages the file that was resolved by editing it, and finishes the rebase", async () => {
    const { repo, before } = await stoppedStack()
    writeFileSync(join(repo.dir, CONFLICT_FILE), "# Test\nmain line\nl2 line\n")

    const result = await resume(repo, "continue")

    expect(result).toMatchObject({ status: "done", branch: "l3", top: "l3", folded: 0, needs_force_push: [] })
    expect(result.layers.map((item) => [item.branch, item.before])).toEqual([
      ["l1", shortSha(before.l1!)],
      ["l2", shortSha(before.l2!)],
      ["l3", shortSha(before.l3!)],
    ])
    for (const item of result.layers) expect(item.after).not.toBe(item.before)
    expect(await operationInProgress(repo.dir)).toBeNull()
    expect(await repo.git(["show", `l2:${CONFLICT_FILE}`])).toBe("# Test\nmain line\nl2 line\n")
    expect(await rev(repo, "l2~1")).toBe(await rev(repo, "l1"))
    expect(await rev(repo, "l3~1")).toBe(await rev(repo, "l2"))
    expect(await rev(repo, "l1~1")).toBe(await rev(repo, "origin/main"))
  })

  test("skip drops the conflicting commit and finishes", async () => {
    const { repo } = await stoppedStack()

    const result = await resume(repo, "skip")

    expect(result).toMatchObject({ status: "done", branch: "l3" })
    expect(await operationInProgress(repo.dir)).toBeNull()
    expect((await repo.git(["log", "--format=%s", "origin/main..l3"])).split("\n").filter(Boolean)).toEqual([
      "l3: 1",
      "l1: 1",
    ])
    expect(await rev(repo, "l2")).toBe(await rev(repo, "l1"))
  })

  test("abort puts every layer back where it was, the lower ones that were not in conflict included", async () => {
    const { repo, before } = await stoppedStack()

    const result = await resume(repo, "abort")

    expect(result).toMatchObject({ status: "aborted", branch: "l3", top: "l3", needs_force_push: [] })
    expect(result.layers).toEqual(
      ["l1", "l2", "l3"].map((branch) => ({
        branch,
        before: shortSha(before[branch]!),
        after: shortSha(before[branch]!),
      })),
    )
    expect(await operationInProgress(repo.dir)).toBeNull()
    for (const branch of ["l1", "l2", "l3"]) expect(await rev(repo, branch)).toBe(before[branch]!)
    expect(await repo.git(["status", "--porcelain"])).toBe("")
  })

  test("says no rebase is in progress, or that a merge is in the way", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    await expect(resume(repo, "continue")).rejects.toMatchObject({
      code: "not_found",
      message: "No rebase is in progress.",
    })

    writeFileSync(join(repo.dir, ".git", "MERGE_HEAD"), `${await rev(repo, "main")}\n`)
    await expect(resume(repo, "abort")).rejects.toMatchObject({ code: "operation_in_progress" })
  })

  test("pauses again on a step that fails but is no conflict, as a stop", async () => {
    const repo = await fixture()
    await layer(repo, "feat", 2)
    await repo.git(["rebase", "-i", "--exec", "false", "origin/main"]).catch(() => undefined)

    const result = await resume(repo, "continue")

    expect(result).toMatchObject({ status: "paused", branch: null, top: "feat" })
    expect(result.paused).toMatchObject({ reason: "stopped", conflicts: null })
    expect(result.paused!.output).toContain("false")
    expect(result.paused!.next).toContain("git_rebase_resume")
  })
})
