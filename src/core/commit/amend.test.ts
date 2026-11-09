import { afterEach, describe, expect, test } from "bun:test"
import { type TempRepo, tempRepo } from "../../testing/git-repo"
import { ToolError } from "../errors"
import { invoke } from "../tool"
import { commitAmend } from "./amend"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

async function fixture(options?: Parameters<typeof tempRepo>[0]) {
  const repo = await tempRepo(options)
  repos.push(repo)
  return repo
}

async function featureBranch() {
  const repo = await fixture()
  await repo.git(["checkout", "-b", "feat"])
  const first = await repo.commit("feat: change a\n\nWhy it changes.", { "a.txt": "a\n" })
  return { repo, first }
}

async function amend(repo: TempRepo, args: Parameters<typeof commitAmend.execute>[0]) {
  return invoke(commitAmend, args, { cwd: repo.dir })
}

async function failure(attempt: Promise<unknown>): Promise<ToolError> {
  const error = await attempt.then(
    () => {
      throw new Error("expected the call to fail")
    },
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(ToolError)
  return error as ToolError
}

async function head(repo: TempRepo): Promise<string> {
  return (await repo.git(["rev-parse", "HEAD"])).trim()
}

describe("git_commit_amend", () => {
  test("rewords HEAD with nothing staged, keeping its tree and landing the message byte for byte", async () => {
    const { repo, first } = await featureBranch()
    const tree = (await repo.git(["rev-parse", "HEAD^{tree}"])).trim()

    const result = await amend(repo, { message: "feat: rework a\n\nWhy it changes.  \n\n\n" })

    expect(result).toMatchObject({
      root: repo.dir,
      amended: first,
      needs_force_push: false,
      rewrite_warnings: [],
      subject: "feat: rework a",
      message_matches: true,
    })
    expect(result.sha).toBe(await head(repo))
    expect(result.sha).not.toBe(first)
    expect((await repo.git(["rev-parse", "HEAD^{tree}"])).trim()).toBe(tree)
    expect(await repo.git(["cat-file", "commit", "HEAD"])).toEndWith("\n\nfeat: rework a\n\nWhy it changes.\n")
    expect((await repo.git(["rev-list", "--count", "main..HEAD"])).trim()).toBe("1")
  })

  test("folds the staged changes into HEAD and keeps its message", async () => {
    const { repo, first } = await featureBranch()
    const message = await repo.git(["log", "-1", "--format=%B"])
    repo.write("a.txt", "a2\n")
    await repo.git(["add", "a.txt"])

    const result = await amend(repo, {})

    expect(result).toMatchObject({ amended: first, subject: "feat: change a", files: [{ file: "a.txt" }] })
    expect(await repo.git(["log", "-1", "--format=%B"])).toBe(message)
    expect(await repo.git(["show", "HEAD:a.txt"])).toBe("a2\n")
  })

  test("says a pushed branch needs a force push", async () => {
    const { repo } = await featureBranch()
    await repo.git(["push", "-u", "origin", "feat"])

    const result = await amend(repo, { message: "feat: rework a" })

    expect(result.needs_force_push).toBe(true)
  })

  test("refuses to amend the default branch and leaves HEAD alone", async () => {
    const repo = await fixture()
    const before = await head(repo)

    const error = await failure(amend(repo, { message: "chore: reword" }))

    expect(error.code).toBe("rewrite_refused")
    expect(error.details).toMatchObject({ refusals: [{ rule: "default_branch" }] })
    expect(await head(repo)).toBe(before)
  })

  test("stops on a lint error", async () => {
    const { repo, first } = await featureBranch()

    const error = await failure(amend(repo, { message: `feat: ${"x".repeat(100)}` }))

    expect(error.code).toBe("check_failed")
    expect(error.details).toMatchObject({ check: "lint" })
    expect(await head(repo)).toBe(first)
  })

  test("needs staged changes, a message, or both", async () => {
    const { repo } = await featureBranch()

    const error = await failure(amend(repo, {}))

    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("Nothing is staged and no new message was given")
  })

  test("has nothing to amend before the first commit", async () => {
    const repo = await fixture({ initialCommit: false })

    const error = await failure(amend(repo, { message: "feat: first" }))

    expect(error.code).toBe("not_found")
    expect(error.message).toBe("There is no commit to amend yet.")
  })
})
