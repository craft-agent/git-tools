import { afterEach, describe, expect, test } from "bun:test"
import { type TempRepo, tempRepo } from "../../testing/git-repo"
import { PREFIXED } from "../../testing/secret-fixtures"
import { ToolError } from "../errors"
import { invoke } from "../tool"
import { commitCreate } from "./create"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

async function fixture(options?: Parameters<typeof tempRepo>[0]) {
  const repo = await tempRepo(options)
  repos.push(repo)
  return repo
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

async function head(repo: TempRepo): Promise<string> {
  return (await repo.git(["rev-parse", "HEAD"])).trim()
}

async function stage(repo: TempRepo, path: string, content: string): Promise<void> {
  repo.write(path, content)
  await repo.git(["add", path])
}

describe("git_commit_create", () => {
  test("commits the staged changes with the message normalized once, byte for byte", async () => {
    const repo = await fixture()
    await stage(repo, "a.txt", "a\n")
    repo.write("README.md", "# Changed\n")
    repo.write("untracked.txt", "u\n")

    const result = await create(repo, { message: "feat: add a  \r\n\r\n\r\n\r\nWhy it is needed.   \n\n\n" })

    expect(result).toMatchObject({
      root: repo.dir,
      subject: "feat: add a",
      message_matches: true,
      files: [{ file: "a.txt", added: 1, removed: 0 }],
      changed_by_hook: [],
      hook_findings: [],
      left_modified: [],
      remaining: { staged: 0, unstaged: 1, untracked: 1 },
      accepted: [],
      warnings: [],
    })
    expect(result.sha).toBe(await head(repo))
    expect(await repo.git(["cat-file", "commit", "HEAD"])).toEndWith("\n\nfeat: add a\n\nWhy it is needed.\n")
    expect((await repo.git(["log", "-1", "--format=%B"])).trimEnd()).toBe("feat: add a\n\nWhy it is needed.")
    expect(await repo.git(["show", "--name-only", "--format=", "HEAD"])).toBe("a.txt\n")
  })

  test("lands the normalized message whatever commit.cleanup says", async () => {
    const repo = await fixture()
    await repo.git(["config", "commit.cleanup", "strip"])
    await stage(repo, "a.txt", "a\n")

    const result = await create(repo, { message: "feat: add a\n\n#123 stays a line\n" })

    expect(result.message_matches).toBe(true)
    expect(await repo.git(["cat-file", "commit", "HEAD"])).toEndWith("\n\nfeat: add a\n\n#123 stays a line\n")
  })

  test("reports renames, binary files and counts of what is left", async () => {
    const repo = await fixture()
    await repo.git(["mv", "README.md", "GUIDE.md"])
    repo.write("blob.bin", "a\0b\0")
    await repo.git(["add", "blob.bin"])
    repo.write("other.txt", "o\n")
    await repo.git(["add", "-N", "other.txt"])

    const result = await create(repo, { message: "chore: move the readme" })

    expect(result.files).toEqual([
      { file: "GUIDE.md", added: 0, removed: 0 },
      { file: "blob.bin", added: 0, removed: 0 },
    ])
    expect(result.remaining).toEqual({ staged: 0, unstaged: 1, untracked: 0 })
  })

  test("refuses when nothing is staged", async () => {
    const repo = await fixture()
    const before = await head(repo)
    repo.write("README.md", "# Changed\n")

    const error = await failure(create(repo, { message: "feat: nothing" }))

    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("Nothing is staged")
    expect(await head(repo)).toBe(before)
  })

  test("refuses an empty message", async () => {
    const repo = await fixture()
    await stage(repo, "a.txt", "a\n")

    const error = await failure(create(repo, { message: " \r\n\n  \n" }))

    expect(error).toMatchObject({ code: "invalid_argument", message: "The message is empty." })
  })

  test("fails the lint errors as check_failed and commits nothing", async () => {
    const repo = await fixture()
    await stage(repo, "a.txt", "a\n")
    const before = await head(repo)

    const long = await failure(create(repo, { message: `feat: ${"x".repeat(80)}` }))
    const body = await failure(create(repo, { message: "feat: add a\nbody without a blank line" }))
    const narrow = await failure(create(repo, { message: "feat: add a very small thing", subject_max: 20 }))

    for (const error of [long, body, narrow]) {
      expect(error.code).toBe("check_failed")
      expect(error.details).toMatchObject({ check: "lint", pass: false })
    }
    expect(long.details).toMatchObject({ errors: [{ rule: "subject-hard-max" }] })
    expect(body.details).toMatchObject({ errors: [{ rule: "blank-line" }] })
    expect(narrow.details).toMatchObject({ errors: [{ rule: "subject-hard-max" }] })
    expect(await head(repo)).toBe(before)
  })

  test("returns the lint warnings of a commit that landed", async () => {
    const repo = await fixture()
    await stage(repo, "a.txt", "a\n")

    const result = await create(repo, { message: `feat: ${"x".repeat(60)}` })

    expect(result.warnings).toEqual([expect.objectContaining({ rule: "subject-target" })])
  })

  test("commits the first commit of an unborn repository", async () => {
    const repo = await fixture({ remote: false, initialCommit: false })
    await stage(repo, "a.txt", "a\n")

    const result = await create(repo, { message: "feat: first" })

    expect(result).toMatchObject({ subject: "feat: first", files: [{ file: "a.txt", added: 1, removed: 0 }] })
    expect(result.sha).toBe(await head(repo))
  })

  test("fails a git refusal that no hook explains as git_error", async () => {
    const repo = await fixture()
    await stage(repo, "a.txt", "a\n")
    const before = await head(repo)
    await repo.git(["config", "commit.gpgsign", "true"])
    await repo.git(["config", "gpg.program", `${repo.dir}/no-such-gpg`])

    const error = await failure(create(repo, { message: "feat: add a" }))

    expect(error.code).toBe("git_error")
    expect(await head(repo)).toBe(before)
  })
})

describe("git_commit_create secrets", () => {
  const token = PREFIXED["github-pat"]!
  const fingerprint = "a.txt:1:github-pat"

  test("fails on a staged credential, names its fingerprint and never returns the value", async () => {
    const repo = await fixture()
    await stage(repo, "a.txt", `id ${token}\n`)
    const before = await head(repo)

    const error = await failure(create(repo, { message: "feat: add a" }))

    expect(error.code).toBe("check_failed")
    expect(error.details).toMatchObject({
      check: "secrets",
      findings: [{ fingerprint, file: "a.txt", line: 1, rule: "github-pat" }],
      accepted: [],
    })
    expect(JSON.stringify(error.details)).not.toContain(token)
    expect(await head(repo)).toBe(before)
  })

  test("commits when the finding's fingerprint is accepted", async () => {
    const repo = await fixture()
    await stage(repo, "a.txt", `id ${token}\n`)

    const result = await create(repo, { message: "feat: add a", accept_findings: [fingerprint] })

    expect(result.accepted).toEqual([fingerprint])
    expect(result.sha).toBe(await head(repo))
  })

  test("still fails when another fingerprint is accepted", async () => {
    const repo = await fixture()
    await stage(repo, "a.txt", `id ${token}\n`)
    await stage(repo, "b.txt", `id ${token}\n`)

    const error = await failure(create(repo, { message: "feat: add a", accept_findings: [fingerprint, "c.txt:1:x"] }))

    expect(error.details).toMatchObject({
      check: "secrets",
      findings: [{ fingerprint: "b.txt:1:github-pat" }],
      accepted: [fingerprint],
    })
  })
})
