import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { type TempRepo, tempRepo } from "../../testing/git-repo"
import { callDescription } from "../describe"
import { shortSha } from "../rewrite"
import { commitVerify } from "./verify"

const TIMEOUT_DEFAULT_SEC = 600
const COMMITS_OVER_LIMIT = 31

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

/** A branch `feat` off main with two commits of its own. */
async function featureBranch() {
  const repo = await tempRepo()
  repos.push(repo)
  const base = (await repo.git(["rev-parse", "HEAD"])).trim()
  await repo.git(["switch", "-c", "feat"])
  const first = await repo.commit("feat: add a", { "sub/a.txt": "a\n" })
  const second = await repo.commit("feat: add b", { "b.txt": "b\n" })
  return { repo, base, first, second }
}

type Args = Parameters<typeof commitVerify.execute>[0]

const describeVerify = (repo: TempRepo, args: Partial<Args> & { command: string }) =>
  callDescription(commitVerify, { timeout_sec: TIMEOUT_DEFAULT_SEC, ...args }, { cwd: repo.dir })

const labels = (description: Awaited<ReturnType<typeof describeVerify>>) => description!.facts.map((fact) => fact.label)

describe("git_commit_verify description", () => {
  test("describes the commits after the base with the defaults and the command as the text", async () => {
    const { repo, base, second } = await featureBranch()

    const description = await describeVerify(repo, { command: "pnpm test", base })

    expect(description!.headline).toEqual({
      text: "About to run a check at each commit of {branch}",
      values: { branch: "feat" },
    })
    expect(description!.facts).toEqual([
      { label: "Commits", value: { text: "{commits} commits", values: { commits: 2 } } },
      { label: "Base", value: `${shortSha(base)} initial` },
      { label: "On failure", value: { text: "stop at the first failure" } },
      { label: "Time limit", value: { text: "{seconds} s per run", values: { seconds: TIMEOUT_DEFAULT_SEC } } },
    ])
    expect(description!.text).toEqual({ label: "Command", body: "pnpm test" })
    expect(description!.pins).toEqual({ head: second, base })
  })

  test("adds the setup and the directory, and says it checks every commit with keep_going", async () => {
    const { repo, base } = await featureBranch()

    const description = await describeVerify(repo, {
      command: "pnpm test",
      base,
      setup: "pnpm install",
      dir: "sub",
      keep_going: true,
      timeout_sec: 30,
    })

    expect(labels(description)).toEqual(["Commits", "Base", "Setup", "Directory", "On failure", "Time limit"])
    expect(description!.facts.slice(2)).toEqual([
      { label: "Setup", value: "pnpm install" },
      { label: "Directory", value: "sub" },
      { label: "On failure", value: { text: "check every commit" } },
      { label: "Time limit", value: { text: "{seconds} s per run", values: { seconds: 30 } } },
    ])
  })

  test("gives no description when the call would fail before it runs", async () => {
    const { repo, base, second } = await featureBranch()
    expect(await describeVerify(repo, { command: "true", base: second })).toBeUndefined()
    expect(await describeVerify(repo, { command: "true", base, dir: "../x" })).toBeUndefined()
    expect(await describeVerify(repo, { command: "true", base: "no-such-ref" })).toBeUndefined()

    for (let index = 0; index < COMMITS_OVER_LIMIT; index++) {
      await repo.commit(`feat: n${index}`, { [`n${index}.txt`]: "n\n" })
    }
    expect(await describeVerify(repo, { command: "true", base: second })).toBeUndefined()
  })

  test("gives an equal description for the same state, and another one after a new commit", async () => {
    const { repo, base } = await featureBranch()
    const before = await describeVerify(repo, { command: "true", base })
    expect(await describeVerify(repo, { command: "true", base })).toEqual(before)

    const head = await repo.commit("feat: add c", { "c.txt": "c\n" })
    const after = await describeVerify(repo, { command: "true", base })

    expect(after!.pins).toEqual({ head, base })
    expect(after!.pins!.head).not.toBe(before!.pins!.head)
    expect(after!.facts[0]).toEqual({ label: "Commits", value: { text: "{commits} commits", values: { commits: 3 } } })
  })

  test("describes without running the command or adding a worktree", async () => {
    const { repo, base } = await featureBranch()
    const worktrees = () => repo.git(["worktree", "list", "--porcelain"])
    const before = await worktrees()

    await describeVerify(repo, { command: "touch marker", base, setup: "touch setup-marker" })

    expect(existsSync(join(repo.dir, "marker"))).toBe(false)
    expect(existsSync(join(repo.dir, "setup-marker"))).toBe(false)
    expect(await worktrees()).toBe(before)
  })
})
