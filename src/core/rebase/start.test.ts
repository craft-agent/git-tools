import { afterEach, describe, expect, test } from "bun:test"
import { CONFLICT_FILE, layer, pushToMain } from "../../testing/rebase-fixtures"
import { type TempRepo, tempRepo } from "../../testing/git-repo"
import { shortSha } from "../rewrite"
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

const start = (repo: TempRepo, args: Parameters<typeof rebaseStart.execute>[0] = {}) =>
  invoke(rebaseStart, args, { cwd: repo.dir })

const rev = async (repo: TempRepo, ref: string) => (await repo.git(["rev-parse", ref])).trim()

const subjects = async (repo: TempRepo, range: string) =>
  (await repo.git(["log", "--format=%s", range])).split("\n").filter(Boolean)

const isAncestor = (repo: TempRepo, ancestor: string, descendant: string) =>
  repo
    .git(["merge-base", "--is-ancestor", ancestor, descendant])
    .then(() => true)
    .catch(() => false)

describe("git_rebase_start", () => {
  test("rebases one branch onto an origin/main that moved, fetching it first, and is then up to date", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    const before = await rev(repo, "feat")
    await pushToMain(repo, "main: add b", { "b.txt": "b\n" })

    const result = await start(repo)

    expect(result).toMatchObject({
      status: "done",
      branch: "feat",
      top: "feat",
      onto: { ref: "origin/main", sha: shortSha(await rev(repo, "origin/main")) },
      layers: [{ branch: "feat", before: shortSha(before), after: shortSha(await rev(repo, "feat")) }],
      folded: 0,
      needs_force_push: [],
      warnings: [],
    })
    expect(await rev(repo, "feat~1")).toBe(await rev(repo, "origin/main"))
    expect(await subjects(repo, "feat")).toEqual(["feat: 1", "main: add b", "initial"])

    expect(await start(repo)).toMatchObject({ status: "up_to_date", branch: "feat", layers: [], folded: 0 })
  })

  test("moves every layer of a stack called from the middle one, each still on the one below, and returns to it", async () => {
    const repo = await fixture()
    await layer(repo, "l1")
    await layer(repo, "l2", 2)
    await layer(repo, "l3")
    await repo.git(["switch", "l2"])
    await pushToMain(repo, "main: add b", { "b.txt": "b\n" })

    const result = await start(repo)

    expect(result).toMatchObject({ status: "done", branch: "l2", top: "l3" })
    expect(result.layers.map((item) => item.branch)).toEqual(["l1", "l2", "l3"])
    for (const item of result.layers) expect(item.after).not.toBe(item.before)
    expect(await repo.git(["branch", "--show-current"])).toBe("l2\n")
    expect(await rev(repo, "l1~1")).toBe(await rev(repo, "origin/main"))
    expect(await isAncestor(repo, "l1", "l2")).toBe(true)
    expect(await isAncestor(repo, "l2", "l3")).toBe(true)
    expect(await subjects(repo, "origin/main..l3")).toEqual(["l3: 1", "l2: 2", "l2: 1", "l1: 1"])
  })

  test("folds a fixup committed on the top into the layer it fixes, and names the pushed branches to force-push", async () => {
    const repo = await fixture()
    await layer(repo, "l1")
    await layer(repo, "l2")
    await layer(repo, "l3")
    await repo.git(["push", "origin", "l1", "l2", "l3"])
    await repo.commit("fixup! l1: 1", { "fix.txt": "fix\n" })
    const base = await rev(repo, "main")

    const result = await start(repo, { keep_base: true })

    expect(result).toMatchObject({ status: "done", branch: "l3", top: "l3", onto: { ref: null }, folded: 1 })
    expect(result.layers.map((item) => item.branch)).toEqual(["l1", "l2", "l3"])
    expect([...result.needs_force_push].sort()).toEqual(["origin/l1", "origin/l2", "origin/l3"])
    expect(await repo.git(["show", "l1:fix.txt"])).toBe("fix\n")
    expect(await subjects(repo, `${base}..l3`)).toEqual(["l3: 1", "l2: 1", "l1: 1"])
    expect(await isAncestor(repo, "l1", "l2")).toBe(true)
    expect(await isAncestor(repo, "l2", "l3")).toBe(true)
    expect(await start(repo, { keep_base: true })).toMatchObject({ status: "up_to_date" })
  })

  test("stops on a conflict with the conflict map and the commit it stopped on", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    await repo.commit("feat: change the readme", { [CONFLICT_FILE]: "# Test\nfeat line\n" })
    await pushToMain(repo, "main: change the readme", { [CONFLICT_FILE]: "# Test\nmain line\n" })

    const result = await start(repo)

    expect(result).toMatchObject({ status: "paused", branch: null, top: "feat", folded: 0, needs_force_push: [] })
    expect(result.paused).toMatchObject({
      reason: "conflicts",
      stopped_on: { subject: "feat: change the readme" },
      conflicts: { operation: "rebase", count: 1, files: [{ path: CONFLICT_FILE }] },
    })
    expect(result.paused!.next).toContain("git_rebase_resume")
    expect(result.paused!.stopped_on!.sha).toMatch(/^[0-9a-f]{12}$/)
  })

  test("drops a commit whose change the base already has instead of stopping on it", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    await repo.commit("feat: add the line", { [CONFLICT_FILE]: "# Test\nline\n" })
    await pushToMain(repo, "main: add another line", { [CONFLICT_FILE]: "# Test\nother\n" })
    await pushToMain(repo, "main: add the line", { [CONFLICT_FILE]: "# Test\nline\n" })

    const result = await start(repo)

    expect(result).toMatchObject({ status: "done", branch: "feat" })
    expect(await subjects(repo, "origin/main..feat")).toEqual(["feat: 1"])
    expect(await repo.git(["show", `feat:${CONFLICT_FILE}`])).toBe("# Test\nline\n")
  })

  test("replays only the layers above `after` when the layers below landed as a squash commit", async () => {
    const repo = await fixture()
    await layer(repo, "l1")
    await layer(repo, "l2")
    await layer(repo, "l3")
    const l1 = await rev(repo, "l1")
    await pushToMain(repo, "feat: l1 (#1)", { "l1-1.txt": "1\n" })

    const result = await start(repo, { after: "l1" })

    expect(result).toMatchObject({ status: "done", branch: "l3", top: "l3" })
    expect(result.layers.map((item) => item.branch)).toEqual(["l2", "l3"])
    expect(await rev(repo, "l1")).toBe(l1)
    expect(await rev(repo, "l2~1")).toBe(await rev(repo, "origin/main"))
    expect(await isAncestor(repo, "l2", "l3")).toBe(true)
    expect(await subjects(repo, "origin/main..l3")).toEqual(["l3: 1", "l2: 1"])
    expect(await start(repo)).toMatchObject({ status: "up_to_date" })
  })

  test("returns to the branch it started on when that branch is below `after`", async () => {
    const repo = await fixture()
    await layer(repo, "l1")
    await layer(repo, "l2")
    await repo.git(["switch", "l1"])
    await pushToMain(repo, "feat: l1 (#1)", { "l1-1.txt": "1\n" })

    const result = await start(repo, { after: "l1" })

    expect(result).toMatchObject({ status: "done", branch: "l1", top: "l2" })
    expect(result.layers.map((item) => item.branch)).toEqual(["l2"])
    expect(await repo.git(["branch", "--show-current"])).toBe("l1\n")
  })
})
