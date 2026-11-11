import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import {
  layoutDirectory,
  REMOTE_REPOSITORY,
  repositoryState,
  worktreeContext,
  worktreeRootOf,
} from "../../testing/worktree-fixtures"
import { ToolError, type ErrorCode } from "../errors"
import { invoke } from "../tool"
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

/** The error the call throws; fails the test when it succeeds. */
async function refusal(repo: TempRepo, args: Args): Promise<ToolError> {
  const error = await invoke(worktreeAdd, args, worktreeContext(repo)).then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(ToolError)
  return error as ToolError
}

/** Refuses the call with `code` and leaves the repository and the worktree root as they were. */
async function expectRefused(repo: TempRepo, args: Args, code: ErrorCode) {
  const before = await repositoryState(repo)
  const existed = existsSync(worktreeRootOf(repo))
  const error = await refusal(repo, args)
  expect(error.code).toBe(code)
  expect(await repositoryState(repo)).toBe(before)
  expect(existsSync(worktreeRootOf(repo))).toBe(existed)
  return error
}

describe("git_worktree_add refusals", () => {
  test("refuses a branch name git does not accept, a blank one and one that looks like an option", async () => {
    const repo = await open()
    for (const branch of ["bad..name", "-x", "--detach", "", "   ", "a b", "@{-1}", "HEAD", "x.lock", "x/"]) {
      const error = await expectRefused(repo, { branch }, "invalid_argument")
      expect(error.message, branch).toContain("is not a valid branch name; use something like task/short-name")
    }
  })

  test("refuses a from that is blank or looks like an option", async () => {
    const repo = await open()
    for (const from of ["", "  ", "--upload-pack=x"]) {
      await expectRefused(repo, { branch: "task/x", from }, "invalid_argument")
    }
  })

  test("refuses a target that already exists, a folder or a file", async () => {
    const repo = await open()
    const folder = layoutDirectory(repo, REMOTE_REPOSITORY, "task/folder")
    mkdirSync(folder, { recursive: true })
    const error = await expectRefused(repo, { branch: "task/folder" }, "invalid_argument")
    expect(error.message).toBe(`${folder} already exists; pick another branch name, or remove that worktree first.`)

    const file = layoutDirectory(repo, REMOTE_REPOSITORY, "task/file")
    writeFileSync(file, "x")
    await expectRefused(repo, { branch: "task/file" }, "invalid_argument")
  })

  test("refuses a from for a branch that already exists", async () => {
    const repo = await open()
    await repo.git(["branch", "feat"])
    const error = await expectRefused(repo, { branch: "feat", from: "main" }, "invalid_argument")
    expect(error.message).toContain("leave from out")
  })

  test("refuses a branch checked out in the main working tree, naming where", async () => {
    const repo = await open()
    const error = await expectRefused(repo, { branch: "main" }, "invalid_argument")
    expect(error.message).toContain(`already checked out in ${repo.dir}`)
  })

  test("refuses a branch checked out in another worktree, naming where", async () => {
    const repo = await open()
    const elsewhere = join(repo.home, "elsewhere")
    await repo.git(["worktree", "add", "-b", "other", elsewhere])
    const error = await expectRefused(repo, { branch: "other" }, "invalid_argument")
    expect(error.message).toContain(`already checked out in ${elsewhere}`)
  })

  test("refuses a from that is no commit as not_found", async () => {
    const repo = await open()
    await expectRefused(repo, { branch: "task/x", from: "no-such-ref" }, "not_found")
    await repo.git(["tag", "-a", "-m", "tree tag", "tree-tag", "HEAD^{tree}"])
    await expectRefused(repo, { branch: "task/x", from: "tree-tag" }, "not_found")
  })

  test("refuses when origin's default branch is unknown here", async () => {
    const repo = await open({ initialCommit: false })
    await repo.commit("first", { "a.txt": "a\n" })
    await repo.git(["push", "origin", "HEAD:dev"])
    await repo.git(["branch", "-m", "work"])

    const error = await expectRefused(repo, { branch: "task/x" }, "invalid_argument")

    expect(error.message).toBe("origin's default branch is unknown here; pass from.")
    const added = await invoke(worktreeAdd, { branch: "task/x", from: "origin/dev" }, worktreeContext(repo))
    expect(added.base!.ref).toBe("origin/dev")
  })

  test("refuses to cut from a HEAD with no commit", async () => {
    const repo = await open({ remote: false, initialCommit: false })
    await expectRefused(repo, { branch: "task/x" }, "invalid_argument")
  })
})
