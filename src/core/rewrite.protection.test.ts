import { afterEach, describe, expect, test } from "bun:test"
import { installFakeGh, type FakeGh, type GhRule } from "../testing/fake-gh"
import { tempRepo, type TempRepo } from "../testing/git-repo"
import { checkRewrite } from "./rewrite"

const URLS = ["https://github.com/o/r.git", "git@github.com:o/r.git", "ssh://git@github.com/o/r.git"]

const BRANCH_PROTECTION_REASON = "branch protection blocks force pushes"
const RULESET_REASON = "a ruleset blocks force pushes"

const repos: TempRepo[] = []
const fakes: FakeGh[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
  for (const fake of fakes.splice(0)) fake.restore()
})

/** A fake `gh` that answers the protection query with `ref` (the `ref` field of GitHub's reply) or with a raw rule. */
function githubAnswers(answer: GhRule | { ref: unknown }): FakeGh {
  const rule: GhRule =
    "ref" in answer
      ? { match: "api graphql", stdout: JSON.stringify({ data: { repository: { ref: answer.ref } } }) }
      : answer
  const fake = installFakeGh([rule])
  fakes.push(fake)
  return fake
}

/** A repository whose branch `feat` (one commit of its own) is pushed to a remote at `url`. */
async function pushedTo(url: string) {
  const repo = await tempRepo()
  repos.push(repo)
  await repo.git(["switch", "-c", "feat"])
  const sha = await repo.commit("feat: one", { "one.txt": "1\n" })
  await repo.git(["push", "-u", "origin", "feat"])
  await repo.git(["config", "remote.origin.url", url])
  return { repo, sha }
}

const rulesetBlocks = { refUpdateRule: null, rules: { nodes: [{ type: "NON_FAST_FORWARD" }] } }
const classicBlocks = { refUpdateRule: { allowsForcePushes: false }, rules: { nodes: [] } }

describe("checkRewrite on a GitHub remote", () => {
  test.each(URLS)("refuses a branch a ruleset protects (%s)", async (url) => {
    githubAnswers({ ref: rulesetBlocks })
    const { repo, sha } = await pushedTo(url)
    expect(await checkRewrite(repo.dir, sha)).toEqual({
      allowed: false,
      branch: "feat",
      published: ["origin/feat"],
      needs_force_push: true,
      refusals: [
        {
          rule: "protected",
          message: `origin/feat cannot be force-pushed: ${RULESET_REASON}. Make a new commit instead.`,
        },
      ],
      warnings: [],
    })
  })

  test.each(URLS)("refuses a branch classic branch protection protects (%s)", async (url) => {
    githubAnswers({ ref: classicBlocks })
    const { repo, sha } = await pushedTo(url)
    const check = await checkRewrite(repo.dir, sha)
    expect(check.allowed).toBe(false)
    expect(check.refusals).toEqual([
      {
        rule: "protected",
        message: `origin/feat cannot be force-pushed: ${BRANCH_PROTECTION_REASON}. Make a new commit instead.`,
      },
    ])
  })

  test("names the ruleset when both it and branch protection block force pushes", async () => {
    githubAnswers({ ref: { refUpdateRule: { allowsForcePushes: false }, rules: rulesetBlocks.rules } })
    const { repo, sha } = await pushedTo(URLS[0]!)
    const check = await checkRewrite(repo.dir, sha)
    expect(check.refusals).toHaveLength(1)
    expect(check.refusals[0]!.message).toContain(RULESET_REASON)
  })

  test.each(URLS)("allows a branch that allows force pushes, with no warning (%s)", async (url) => {
    githubAnswers({ ref: { refUpdateRule: { allowsForcePushes: true }, rules: { nodes: [] } } })
    const { repo, sha } = await pushedTo(url)
    expect(await checkRewrite(repo.dir, sha)).toMatchObject({
      allowed: true,
      published: ["origin/feat"],
      needs_force_push: true,
      refusals: [],
      warnings: [],
    })
  })

  test("allows a branch with no protection rule and no ruleset", async () => {
    githubAnswers({ ref: { refUpdateRule: null, rules: { nodes: [] } } })
    const { repo, sha } = await pushedTo(URLS[0]!)
    expect(await checkRewrite(repo.dir, sha)).toMatchObject({ allowed: true, refusals: [], warnings: [] })
  })

  test("allows with a warning when GitHub has no such branch", async () => {
    githubAnswers({ ref: null })
    const { repo, sha } = await pushedTo(URLS[0]!)
    const check = await checkRewrite(repo.dir, sha)
    expect(check.allowed).toBe(true)
    expect(check.warnings).toEqual([
      "Could not read whether origin/feat is protected against force pushes on GitHub (feat is not on GitHub); a force push may still be refused there.",
    ])
  })

  test("allows with a warning when gh fails", async () => {
    githubAnswers({
      match: "api graphql",
      stderr: "To get started with GitHub CLI, please run:  gh auth login",
      code: 4,
    })
    const { repo, sha } = await pushedTo(URLS[1]!)
    const check = await checkRewrite(repo.dir, sha)
    expect(check.allowed).toBe(true)
    expect(check.refusals).toEqual([])
    expect(check.warnings).toHaveLength(1)
    expect(check.warnings[0]).toStartWith(
      "Could not read whether origin/feat is protected against force pushes on GitHub (",
    )
    expect(check.warnings[0]).toContain("gh auth login")
  })

  test("queries the owner, the repository and the branch's full ref once", async () => {
    const fake = githubAnswers({ ref: { refUpdateRule: null, rules: { nodes: [] } } })
    const { repo, sha } = await pushedTo(URLS[2]!)
    await checkRewrite(repo.dir, sha)
    const calls = fake.calls()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.slice(0, 5)).toEqual(["api", "graphql", "--hostname", "github.com", "-f"])
    expect(calls[0]).toEqual(expect.arrayContaining(["owner=o", "name=r", "ref=refs/heads/feat"]))
  })

  test("reads a repository and branch once, however many remotes hold it", async () => {
    const fake = githubAnswers({ ref: rulesetBlocks })
    const { repo, sha } = await pushedTo(URLS[0]!)
    await repo.git(["remote", "add", "mirror", repo.remote!])
    await repo.git(["push", "mirror", "feat"])
    await repo.git(["config", "remote.mirror.url", URLS[1]!])
    const check = await checkRewrite(repo.dir, sha)
    expect(fake.calls()).toHaveLength(1)
    expect(check.refusals.map((refusal) => refusal.message.split(" cannot")[0]).sort()).toEqual([
      "mirror/feat",
      "origin/feat",
    ])
  })

  test("does not read GitHub for a remote on another host", async () => {
    const fake = githubAnswers({ ref: rulesetBlocks })
    const { repo, sha } = await pushedTo("https://example.com/github.com/o/r.git")
    expect(await checkRewrite(repo.dir, sha)).toMatchObject({ allowed: true, refusals: [], warnings: [] })
    expect(fake.calls()).toEqual([])
  })

  test("does not read GitHub for a branch that was never pushed", async () => {
    const fake = githubAnswers({ ref: rulesetBlocks })
    const { repo, sha } = await pushedTo(URLS[0]!)
    await repo.git(["update-ref", "-d", "refs/remotes/origin/feat"])
    expect(await checkRewrite(repo.dir, sha)).toMatchObject({ allowed: true, published: [] })
    expect(fake.calls()).toEqual([])
  })

  test("does not read GitHub when another rule already refuses", async () => {
    const fake = githubAnswers({ ref: rulesetBlocks })
    const { repo, sha } = await pushedTo(URLS[0]!)
    await repo.git(["update-ref", "refs/remotes/origin/someone-else", sha])
    const check = await checkRewrite(repo.dir, sha)
    expect(check.refusals.map((refusal) => refusal.rule)).toEqual(["shared"])
    expect(fake.calls()).toEqual([])
  })

  test("propagates an abort", async () => {
    githubAnswers({ match: "api graphql", stdout: "{}", delayMs: 2_000 })
    const { repo, sha } = await pushedTo(URLS[0]!)
    const controller = new AbortController()
    const pending = checkRewrite(repo.dir, sha, { signal: controller.signal })
    setTimeout(() => controller.abort(), 300)
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })
})
