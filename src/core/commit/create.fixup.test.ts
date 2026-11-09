import { afterEach, describe, expect, test } from "bun:test"
import { type TempRepo, tempRepo } from "../../testing/git-repo"
import { ToolError } from "../errors"
import { invoke } from "../tool"
import { commitCreate } from "./create"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

const LONG_SUBJECT = `feat: add b with a long subject that the fixup prefix pushes it past ${"x".repeat(30)}`

async function featureBranch() {
  const repo = await tempRepo()
  repos.push(repo)
  await repo.git(["checkout", "-b", "feat"])
  const target = await repo.commit(LONG_SUBJECT, { "b.txt": "b\n" })
  await repo.commit("feat: add c", { "c.txt": "c\n" })
  return { repo, target }
}

async function stageB(repo: TempRepo, content = "b2\n") {
  repo.write("b.txt", content)
  await repo.git(["add", "b.txt"])
}

async function create(repo: TempRepo, args: Parameters<typeof commitCreate.execute>[0]) {
  return invoke(commitCreate, args, { cwd: repo.dir })
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

describe("git_commit_create fixup", () => {
  test("commits fixup! of the target's subject, with no built-in subject rule on it, and autosquash folds it", async () => {
    const { repo, target } = await featureBranch()
    await stageB(repo)

    const result = await create(repo, { fixup: "HEAD~1" })

    expect(result).toMatchObject({
      subject: `fixup! ${LONG_SUBJECT}`,
      fixup_of: target,
      next: `Fold it into ${target.slice(0, 12)} with an autosquash rebase.`,
      warnings: [],
    })
    expect(result.rewrite_warnings).toBeUndefined()

    await repo.git(["rebase", "-i", "--autosquash", "main"])
    expect((await repo.git(["log", "--format=%s", "main..HEAD"])).trim().split("\n")).toEqual([
      "feat: add c",
      LONG_SUBJECT,
    ])
    expect(await repo.git(["show", "HEAD~1:b.txt"])).toBe("b2\n")
  })

  test("takes exactly one of message and fixup", async () => {
    const { repo } = await featureBranch()
    await stageB(repo)

    const both = await failure(create(repo, { message: "feat: x", fixup: "HEAD~1" }))
    const neither = await failure(create(repo, {}))

    expect(both.code).toBe("invalid_argument")
    expect(both.message).toContain("not both")
    expect(neither.code).toBe("invalid_argument")
  })

  test("refuses a target that is not a commit of this branch", async () => {
    const { repo } = await featureBranch()
    await repo.git(["checkout", "-b", "elsewhere", "main"])
    const other = await repo.commit("elsewhere", { "e.txt": "e\n" })
    await repo.git(["checkout", "feat"])
    await stageB(repo)

    const error = await failure(create(repo, { fixup: other }))

    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("is not a commit of this branch")
  })

  test("refuses a target already on the default branch", async () => {
    const { repo } = await featureBranch()
    await stageB(repo)

    const error = await failure(create(repo, { fixup: "main" }))

    expect(error.code).toBe("rewrite_refused")
    expect(error.details).toMatchObject({ refusals: [{ rule: "merged" }] })
    expect(error.message).toEndWith("Make a new commit instead.")
  })

  test("does not know a target that is no commit", async () => {
    const { repo } = await featureBranch()
    await stageB(repo)

    const error = await failure(create(repo, { fixup: "no-such-commit" }))

    expect(error.code).toBe("not_found")
  })
})
