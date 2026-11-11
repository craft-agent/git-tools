import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import {
  layoutDirectory,
  pushFromAnotherClone,
  REMOTE_REPOSITORY,
  repositoryState,
  revision,
  worktreeContext,
  worktreeRootOf,
} from "../../testing/worktree-fixtures"
import { callDescription } from "../describe"
import { worktreeAdd } from "./add"
import type { AddRequest } from "./add-plan"

type Args = Pick<AddRequest, "branch" | "from">

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

async function open(options?: Parameters<typeof tempRepo>[0]): Promise<TempRepo> {
  const repo = await tempRepo(options)
  repos.push(repo)
  return repo
}

const describeAdd = (repo: TempRepo, args: Args) => callDescription(worktreeAdd, args, worktreeContext(repo))

const HEADLINE_TEXT = "About to add a worktree for {branch}"

/** The only fact of a description of a new branch `branch` cut from `base`. */
function newBranchFacts(branch: string, base: string) {
  return [{ label: "New branches", value: { text: "{name} from {base}", values: { name: branch, base } } }]
}

describe("git_worktree_add description", () => {
  test("describes a new branch cut from origin's default branch as last recorded", async () => {
    const repo = await open()

    const description = await describeAdd(repo, { branch: "task/x" })

    expect(description).toEqual({
      headline: { text: HEADLINE_TEXT, values: { branch: "task/x" } },
      facts: newBranchFacts("task/x", "origin/main"),
    })
  })

  test("names the default branch origin/HEAD records, before main", async () => {
    const repo = await open()
    await repo.git(["push", "origin", "main:release"])
    await repo.git(["remote", "set-head", "origin", "release"])

    const description = await describeAdd(repo, { branch: "task/x" })

    expect(description!.facts).toEqual(newBranchFacts("task/x", "origin/release"))
  })

  test("names from as it was given", async () => {
    const repo = await open()
    const description = await describeAdd(repo, { branch: "task/x", from: "v1.2" })
    expect(description!.facts).toEqual(newBranchFacts("task/x", "v1.2"))
  })

  test("starts from HEAD with no origin, or an origin with no known default branch", async () => {
    const local = await open({ remote: false })
    expect((await describeAdd(local, { branch: "task/x" }))!.facts).toEqual(newBranchFacts("task/x", "HEAD"))

    const unknown = await open({ initialCommit: false })
    expect((await describeAdd(unknown, { branch: "task/x" }))!.facts).toEqual(newBranchFacts("task/x", "HEAD"))
  })

  test("describes an existing branch with the Branch fact", async () => {
    const repo = await open()
    await repo.git(["branch", "feat/old"])

    const description = await describeAdd(repo, { branch: "feat/old" })

    expect(description).toEqual({
      headline: { text: HEADLINE_TEXT, values: { branch: "feat/old" } },
      facts: [{ label: "Branch", value: "feat/old" }],
    })
    expect(description!.pins).toBeUndefined()
  })

  test("gives no description when a local check fails", async () => {
    const repo = await open()
    mkdirSync(layoutDirectory(repo, REMOTE_REPOSITORY, "taken"), { recursive: true })
    await repo.git(["branch", "feat"])
    await repo.git(["worktree", "add", "-b", "other", join(repo.home, "elsewhere")])

    expect(await describeAdd(repo, { branch: "task/ok" })).toBeDefined()
    for (const args of [
      { branch: "bad..name" },
      { branch: "-x" },
      { branch: "" },
      { branch: "task/x", from: "--upload-pack=x" },
      { branch: "taken" },
      { branch: "feat", from: "main" },
      { branch: "main" },
      { branch: "other" },
    ]) {
      expect(await describeAdd(repo, args), JSON.stringify(args)).toBeUndefined()
    }
  })

  test("reads this repository alone: no fetch, nothing created, and the same answer twice", async () => {
    const repo = await open()
    const known = await revision(repo, "origin/main")
    await pushFromAnotherClone(repo, "pushed meanwhile")
    await repo.git(["remote", "set-url", "origin", join(repo.home, "unreachable.git")])
    const before = await repositoryState(repo)

    const first = await describeAdd(repo, { branch: "task/x" })

    expect(first!.facts).toEqual(newBranchFacts("task/x", "origin/main"))
    expect(await describeAdd(repo, { branch: "task/x" })).toEqual(first)
    expect(await revision(repo, "origin/main")).toBe(known)
    expect(await repositoryState(repo)).toBe(before)
    expect(existsSync(worktreeRootOf(repo))).toBe(false)
  })
})
