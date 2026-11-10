import { afterEach, describe, expect, test } from "bun:test"
import { installFakeGh, type FakeGh } from "../testing/fake-gh"
import { tempRepo, type TempRepo } from "../testing/git-repo"
import { commitAmend } from "./commit/amend"
import { commitCreate } from "./commit/create"
import { commitRead } from "./commit/read"
import { checkRewrite } from "./rewrite"
import { invoke } from "./tool"

const repos: TempRepo[] = []
const fakes: FakeGh[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
  for (const fake of fakes.splice(0)) fake.restore()
})

/** A stack l1 < l2 < l3 of one commit each, all pushed, with l3 checked out; returns the commit of each layer. */
async function stackOf() {
  const repo = await tempRepo()
  repos.push(repo)
  const commits: string[] = []
  for (const name of ["l1", "l2", "l3"]) {
    await repo.git(["switch", "-c", name])
    commits.push(await repo.commit(`${name}: change`, { [`${name}.txt`]: `${name}\n` }))
  }
  await repo.git(["push", "origin", "l1", "l2", "l3"])
  return { repo, c1: commits[0]!, c3: commits[2]! }
}

/** Two lines l3a and l3b above l2, with l1 checked out. */
async function forkedStack() {
  const { repo, c1 } = await stackOf()
  await repo.git(["switch", "-c", "l3b", "l2"])
  await repo.commit("l3b: change", { "l3b.txt": "l3b\n" })
  await repo.git(["switch", "l1"])
  return { repo, c1 }
}

const rules = (check: Awaited<ReturnType<typeof checkRewrite>>) => check.refusals.map((refusal) => refusal.rule)

describe("checkRewrite on a stack", () => {
  test("rewrites a lower layer from the top, the layers' remote branches counting as the branch's own", async () => {
    const { repo, c1 } = await stackOf()
    expect(await checkRewrite(repo.dir, c1)).toEqual({
      allowed: true,
      branch: "l3",
      published: ["origin/l1", "origin/l2", "origin/l3"],
      needs_force_push: true,
      refusals: [],
      warnings: [],
    })
  })

  test("still refuses a pushed branch that is not a layer", async () => {
    const { repo, c1 } = await stackOf()
    await repo.git(["update-ref", "refs/remotes/origin/unrelated", c1])
    const check = await checkRewrite(repo.dir, c1)
    expect(rules(check)).toEqual(["shared"])
    expect(check.refusals[0]!.message).toContain("origin/unrelated")
  })

  test("refuses from a lower layer, naming the layers above and the top", async () => {
    const { repo, c1 } = await stackOf()
    await repo.git(["switch", "l1"])
    const check = await checkRewrite(repo.dir, c1)
    expect(check.allowed).toBe(false)
    expect(rules(check)).toEqual(["layers_above"])
    expect(check.refusals[0]!.message).toContain("l2, l3")
    expect(check.refusals[0]!.message).toContain("Check out l3")
    expect(check.published).toEqual(["origin/l1", "origin/l2", "origin/l3"])
  })

  test("refuses amending a commit another branch points at, but not a fixup committed there", async () => {
    const { repo, c1 } = await stackOf()
    await repo.git(["switch", "l1"])
    await repo.git(["branch", "twin"])
    await repo.git(["branch", "-D", "l2", "l3"])
    for (const name of ["l2", "l3"]) await repo.git(["update-ref", "-d", `refs/remotes/origin/${name}`])

    expect((await checkRewrite(repo.dir, c1)).allowed).toBe(true)
    const check = await checkRewrite(repo.dir, c1, { amending: true })
    expect(check.refusals).toEqual([
      {
        rule: "layers_above",
        message: `twin point at this commit too; amending it would leave them on the old one. Commit the fix as a fixup of ${c1.slice(0, 12)} instead, then rebase the stack.`,
      },
    ])
    expect((await checkRewrite(repo.dir, c1, { amending: true, wholeStack: true })).allowed).toBe(true)
  })

  test("refuses a line that forks above with that alone, naming the candidate tops", async () => {
    const { repo, c1 } = await forkedStack()
    const check = await checkRewrite(repo.dir, c1)
    expect(check.refusals).toEqual([{ rule: "layers_above", message: expect.stringContaining("l3, l3b") }])
    expect(check.published).toEqual(["origin/l1", "origin/l2", "origin/l3"])
  })

  test("a whole-stack rewrite from a lower layer is allowed", async () => {
    const { repo, c1 } = await stackOf()
    await repo.git(["switch", "l1"])
    expect(await checkRewrite(repo.dir, c1, { wholeStack: true })).toMatchObject({
      allowed: true,
      branch: "l1",
      published: ["origin/l1", "origin/l2", "origin/l3"],
      needs_force_push: true,
      refusals: [],
    })
  })

  test("a whole-stack rewrite takes its commits from the top and refuses what another branch holds", async () => {
    const { repo, c1 } = await stackOf()
    await repo.git(["switch", "-c", "side", "main"])
    const side = await repo.commit("side: change", { "side.txt": "side\n" })
    await repo.git(["switch", "l3"])
    await repo.git(["merge", "--no-ff", "-m", "merge side", "side"])
    await repo.git(["update-ref", "refs/remotes/origin/other", side])
    await repo.git(["switch", "l1"])

    const check = await checkRewrite(repo.dir, c1, { wholeStack: true })
    expect(rules(check)).toEqual(["shared"])
    expect(check.refusals[0]!.message).toContain("origin/other")
  })

  test("a whole-stack rewrite cannot tell the line of a fork", async () => {
    const { repo, c1 } = await forkedStack()
    await expect(checkRewrite(repo.dir, c1, { wholeStack: true })).rejects.toMatchObject({
      code: "invalid_argument",
    })
  })

  test("reads whether GitHub protects the remote branch of every layer", async () => {
    const ref = { refUpdateRule: null, rules: { nodes: [{ type: "NON_FAST_FORWARD" }] } }
    fakes.push(installFakeGh([{ match: "api graphql", stdout: JSON.stringify({ data: { repository: { ref } } }) }]))
    const { repo, c1 } = await stackOf()
    await repo.git(["config", "remote.origin.url", "https://github.com/o/r.git"])

    const check = await checkRewrite(repo.dir, c1)
    expect(check.allowed).toBe(false)
    expect(rules(check)).toEqual(["protected", "protected", "protected"])
    expect(check.refusals.map((refusal) => refusal.message.split(" cannot")[0])).toEqual([
      "origin/l1",
      "origin/l2",
      "origin/l3",
    ])
  })
})

describe("the commit tools on a stack", () => {
  test("git_commit_read amend recommends a fixup on the top for a commit of a lower layer", async () => {
    const { repo, c1 } = await stackOf()
    await repo.git(["switch", "l1"])
    const result = (await invoke(commitRead, { method: "amend", sha: c1 }, { cwd: repo.dir })).amend!
    expect(result).toMatchObject({ recommendation: "fixup", needs_force_push: true, refusals: [] })
    expect(result.reason).toContain("check out l3")
    expect(result.reason).toContain(`fixup: ${c1.slice(0, 12)}`)
    expect(result.reason).toContain("rebase of the stack")
    expect(result.reason).toContain("force-push")
  })

  test("git_commit_read amend recommends a new commit when the stack forks above", async () => {
    const { repo, c1 } = await forkedStack()
    const result = (await invoke(commitRead, { method: "amend", sha: c1 }, { cwd: repo.dir })).amend!
    expect(result.recommendation).toBe("new_commit")
    expect(result.refusals).toEqual([{ rule: "layers_above", message: expect.stringContaining("l3, l3b") }])
  })

  test("git_commit_read amend on HEAD with another branch on it recommends a fixup committed here", async () => {
    const { repo, c3 } = await stackOf()
    await repo.git(["branch", "twin"])
    const result = (await invoke(commitRead, { method: "amend" }, { cwd: repo.dir })).amend!
    expect(result).toMatchObject({ sha: c3, recommendation: "fixup", refusals: [] })
    expect(result.reason).toContain("commit the fix here")
    expect(result.reason).not.toContain("check out")
    expect(result.reason).toContain(`fixup: ${c3.slice(0, 12)}`)
  })

  test("git_commit_amend refuses a commit another branch points at", async () => {
    const { repo, c3 } = await stackOf()
    await repo.git(["branch", "twin"])
    const error = await invoke(commitAmend, { message: "l3: reword" }, { cwd: repo.dir }).catch(
      (caught: unknown) => caught,
    )
    expect(error).toMatchObject({ code: "rewrite_refused", details: { refusals: [{ rule: "layers_above" }] } })
    expect((error as Error).message).toContain("twin point at this commit too")
    expect((await repo.git(["rev-parse", "HEAD"])).trim()).toBe(c3)
  })

  test("git_commit_create fixup is committed on a branch another branch points at", async () => {
    const { repo, c3 } = await stackOf()
    await repo.git(["branch", "twin"])
    repo.write("l3.txt", "l3 fixed\n")
    await repo.git(["add", "l3.txt"])
    const result = await invoke(commitCreate, { fixup: c3 }, { cwd: repo.dir })
    expect(result).toMatchObject({ fixup_of: c3, subject: "fixup! l3: change" })
  })

  test("git_commit_amend refuses below the top and leaves HEAD alone", async () => {
    const { repo, c1 } = await stackOf()
    await repo.git(["switch", "l1"])
    const error = await invoke(commitAmend, { message: "l1: reword" }, { cwd: repo.dir }).catch(
      (caught: unknown) => caught,
    )
    expect(error).toMatchObject({ code: "rewrite_refused", details: { refusals: [{ rule: "layers_above" }] } })
    expect((await repo.git(["rev-parse", "HEAD"])).trim()).toBe(c1)
  })

  test("git_commit_create fixup refuses below the top", async () => {
    const { repo, c1 } = await stackOf()
    await repo.git(["switch", "l1"])
    repo.write("l1.txt", "l1 fixed\n")
    await repo.git(["add", "l1.txt"])
    const error = await invoke(commitCreate, { fixup: c1 }, { cwd: repo.dir }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: "rewrite_refused", details: { refusals: [{ rule: "layers_above" }] } })
  })

  test("git_commit_create fixup of a lower layer's commit is committed on the top", async () => {
    const { repo, c1 } = await stackOf()
    repo.write("l1.txt", "l1 fixed\n")
    await repo.git(["add", "l1.txt"])
    const result = await invoke(commitCreate, { fixup: c1 }, { cwd: repo.dir })
    expect(result).toMatchObject({ fixup_of: c1, subject: "fixup! l1: change" })
  })
})
