import { afterEach, describe, expect, test } from "bun:test"
import { installFakeGh, type FakeGh } from "../../testing/fake-gh"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { asGithubRemote, previewOf, pushFromOtherClone } from "../../testing/push-fixtures"
import { conflictingStack, layer, startStoppedRebase } from "../../testing/rebase-fixtures"

const repos: TempRepo[] = []
const fakes: FakeGh[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
  for (const fake of fakes.splice(0)) fake.restore()
})

async function fixture() {
  const repo = await tempRepo()
  repos.push(repo)
  return repo
}

/** A fake `gh` that answers the protection query with `ref`, or fails when `ref` is a failure. */
function githubAnswers(rule: { ref: unknown } | { stderr: string; code: number }): FakeGh {
  const fake = installFakeGh([
    "ref" in rule
      ? { match: "api graphql", stdout: JSON.stringify({ data: { repository: { ref: rule.ref } } }) }
      : { match: "api graphql", ...rule },
  ])
  fakes.push(fake)
  return fake
}

/** `feat` with two commits pushed, then its last commit replaced, so pushing it again needs a force. */
async function forcePushNeeded(repo: TempRepo): Promise<void> {
  await layer(repo, "feat", 2)
  await repo.git(["push", "-u", "origin", "feat"])
  await repo.git(["reset", "--hard", "HEAD~1"])
  await repo.commit("feat: replacement", { "other.txt": "x\n" })
}

const rulesetBlocks = { refUpdateRule: null, rules: { nodes: [{ type: "NON_FAST_FORWARD" }] } }

describe("git_push_read preview refusals", () => {
  test("refuses the remote's default branch", async () => {
    const repo = await fixture()
    const result = await previewOf(repo, { branches: ["main"] })
    expect(result.refusals).toEqual([
      {
        rule: "default_branch",
        branch: "main",
        message: expect.stringContaining("main is the default branch of origin"),
      },
    ])
    expect(result.send).toBeNull()
  })

  test("refuses a push while an operation is in progress", async () => {
    const repo = await fixture()
    await conflictingStack(repo)
    await startStoppedRebase(repo)

    const result = await previewOf(repo, { branches: ["l1"] })
    expect(result.refusals).toEqual([
      { rule: "operation", branch: null, message: expect.stringContaining("A rebase is in progress") },
    ])
    expect(result.send).toBeNull()
  })

  test("refuses a force push over a remote commit this repository does not have", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    await repo.git(["push", "-u", "origin", "feat"])
    const theirs = await pushFromOtherClone(repo, "feat", "feat: theirs", { "theirs.txt": "t\n" })
    await repo.git(["commit", "--amend", "-m", "feat: amended"])

    const result = await previewOf(repo)
    expect(result.branches[0]).toMatchObject({ kind: "force", expect: theirs, drops: null })
    expect(result.refusals).toEqual([
      {
        rule: "unknown_remote_commit",
        branch: "feat",
        message: `origin/feat is at ${theirs.slice(0, 12)}, which is not here: someone else may have pushed it; fetch and rebase first.`,
      },
    ])
    expect(result.send).toBeNull()
  })

  test("a fetched remote commit is no refusal: it is a force push that drops it", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    await repo.git(["push", "-u", "origin", "feat"])
    await pushFromOtherClone(repo, "feat", "feat: theirs", { "theirs.txt": "t\n" })
    await repo.git(["fetch", "origin"])
    await repo.git(["commit", "--amend", "-m", "feat: amended"])

    const result = await previewOf(repo)
    expect(result.refusals).toEqual([])
    expect(result.branches[0]!.drops).toMatchObject({ count: 1, items: [{ subject: "feat: theirs" }] })
  })

  test("refuses a force push onto a branch GitHub protects, and reads it once", async () => {
    const repo = await fixture()
    await forcePushNeeded(repo)
    await asGithubRemote(repo)
    const fake = githubAnswers({ ref: rulesetBlocks })

    const result = await previewOf(repo)
    expect(result.refusals).toEqual([
      {
        rule: "protected",
        branch: "feat",
        message: "origin/feat cannot be force-pushed: a ruleset blocks force pushes. Make a new commit instead.",
      },
    ])
    expect(result.send).toBeNull()
    expect(fake.calls()).toHaveLength(1)
    expect(fake.calls()[0]).toEqual(expect.arrayContaining(["owner=o", "name=r", "ref=refs/heads/feat"]))
  })

  test("a protection read that fails is a warning, and the push stays possible", async () => {
    const repo = await fixture()
    await forcePushNeeded(repo)
    await asGithubRemote(repo)
    githubAnswers({ stderr: "To get started with GitHub CLI, please run:  gh auth login", code: 4 })

    const result = await previewOf(repo)
    expect(result.refusals).toEqual([])
    expect(
      result.warnings.some((warning) => warning.startsWith("Could not read whether origin/feat is protected")),
    ).toBe(true)
    expect(result.send?.branches).toHaveLength(1)
  })

  test("reads GitHub for a force push only", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    await repo.git(["push", "-u", "origin", "feat"])
    await repo.commit("feat: more", { "more.txt": "1\n" })
    await asGithubRemote(repo)
    const fake = githubAnswers({ ref: rulesetBlocks })

    const result = await previewOf(repo)
    expect(result.branches[0]!.kind).toBe("fast_forward")
    expect(result.refusals).toEqual([])
    expect(fake.calls()).toEqual([])
  })

  test("sends nothing whenever something is refused", async () => {
    const repo = await fixture()
    await layer(repo, "feat")

    const result = await previewOf(repo, { branches: ["feat", "main"] })
    expect(result.branches[0]).toMatchObject({ branch: "feat", kind: "create" })
    expect(result.refusals.map(({ rule }) => rule)).toEqual(["default_branch"])
    expect(result.send).toBeNull()
  })
})
