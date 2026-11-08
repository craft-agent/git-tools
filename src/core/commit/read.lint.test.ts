import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync } from "node:fs"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { invoke } from "../tool"
import { commitRead } from "./read"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

async function fixture(options: Parameters<typeof tempRepo>[0]) {
  const repo = await tempRepo(options)
  repos.push(repo)
  return repo
}

async function lint(repo: TempRepo, message: string) {
  const result = await invoke(commitRead, { method: "lint", message }, { cwd: repo.dir })
  return result.lint!
}

function installCommitlint(repo: TempRepo, script: string): void {
  repo.write("node_modules/.bin/commitlint", `#!/bin/sh\n${script}\n`)
  chmodSync(`${repo.dir}/node_modules/.bin/commitlint`, 0o755)
}

async function emptyCommits(repo: TempRepo, subjects: string[], author?: string): Promise<void> {
  const env = author ? ["-c", `user.name=${author}`] : []
  for (const subject of subjects) await repo.git([...env, "commit", "--allow-empty", "-m", subject])
}

/** A conventional subject exactly `width` columns wide. */
function subjectOfWidth(width: number): string {
  const prefix = "feat: "
  return prefix + "x".repeat(width - prefix.length)
}

/** A first commit and `more` empty ones, all with a conventional subject `width` columns wide. */
async function commitsOfWidth(repo: TempRepo, width: number, more: number): Promise<void> {
  await repo.commit(subjectOfWidth(width), { "a.txt": "a\n" })
  await emptyCommits(
    repo,
    Array.from({ length: more }, () => subjectOfWidth(width)),
  )
}

describe("git_commit_read lint", () => {
  test("uses defaults in an unborn repository", async () => {
    const repo = await fixture({ remote: false, initialCommit: false })
    expect(await lint(repo, "Add the thing\n\nWhy.\n")).toEqual({
      pass: true,
      commitlint: "not_configured",
      hook: null,
      subject_target: { target: 50, source: "default", sample: 0 },
      conventional: false,
      errors: [],
      warnings: [],
    })
  })

  test("fails an empty message", async () => {
    const repo = await fixture({ remote: false, initialCommit: false })
    const result = await lint(repo, "\n")
    expect(result.pass).toBe(false)
    expect(result.errors.map((finding) => finding.rule)).toEqual(["empty"])
  })

  test("infers the target and the conventional shape from the history", async () => {
    const repo = await fixture({ remote: false, initialCommit: false })
    await commitsOfWidth(repo, 55, 22)
    const result = await lint(repo, "fix: tidy")
    expect(result.subject_target).toEqual({ target: 55, source: "history", sample: 23 })
    expect(result.conventional).toBe(true)
    const plain = await lint(repo, "Tidy things")
    expect(plain.warnings.map((finding) => finding.rule)).toEqual(["conventional"])
  })

  test("clamps the target to 50..60", async () => {
    const repo = await fixture({ remote: false, initialCommit: false })
    await commitsOfWidth(repo, 70, 24)
    expect((await lint(repo, "fix: tidy")).subject_target.target).toBe(60)
  })

  test("does not count squash-merge titles, autosquash commits or bots", async () => {
    const repo = await fixture({ remote: false, initialCommit: false })
    await commitsOfWidth(repo, 52, 19)
    await emptyCommits(repo, [`${subjectOfWidth(58)} (#12)`, "fixup! feat: x", "squash! feat: x"])
    await emptyCommits(repo, [subjectOfWidth(59)], "release[bot]")
    const result = await lint(repo, "fix: tidy")
    expect(result.subject_target).toEqual({ target: 52, source: "history", sample: 20 })
  })

  test("keeps the default target below 20 usable subjects", async () => {
    const repo = await fixture({ remote: false, initialCommit: false })
    await commitsOfWidth(repo, 58, 11)
    const result = await lint(repo, "fix: tidy")
    expect(result.subject_target).toEqual({ target: 50, source: "default", sample: 12 })
    expect(result.conventional).toBe(true)
  })

  test("runs an installed commitlint and reports its failure", async () => {
    const repo = await fixture({ remote: false })
    installCommitlint(repo, "cat > /dev/null")
    expect(await lint(repo, "Add it")).toMatchObject({ pass: true, commitlint: "ran", errors: [] })

    installCommitlint(repo, 'cat > /dev/null\necho "subject may not be empty"\nexit 1')
    const result = await lint(repo, "Add it")
    expect(result.pass).toBe(false)
    expect(result.commitlint).toBe("ran")
    expect(result.errors).toEqual([{ rule: "commitlint", message: "subject may not be empty" }])
  })

  test("passes the message to commitlint on stdin", async () => {
    const repo = await fixture({ remote: false })
    installCommitlint(repo, 'read first\ncase "$first" in "Add it") exit 0 ;; esac\necho "got $first"\nexit 1')
    expect((await lint(repo, "Add it")).pass).toBe(true)
    expect((await lint(repo, "Other")).errors[0]?.message).toBe("got Other")
  })

  test("reports a generic commitlint error when it prints nothing", async () => {
    const repo = await fixture({ remote: false })
    installCommitlint(repo, "exit 1")
    expect((await lint(repo, "Add it")).errors).toEqual([
      { rule: "commitlint", message: "commitlint reported problems." },
    ])
  })

  test("errors when a commit-msg hook runs a missing commitlint", async () => {
    const repo = await fixture({ remote: false })
    repo.write(".git/hooks/commit-msg", '#!/bin/sh\n# commitlint is mentioned here\nnpx commitlint --edit "$1"\n')
    const result = await lint(repo, "Add it")
    expect(result.pass).toBe(false)
    expect(result.commitlint).toBe("not_installed")
    expect(result.hook).toBe('npx commitlint --edit "$1"')
    expect(result.errors.map((finding) => finding.rule)).toEqual(["commitlint-not-installed"])
  })

  test("reads the husky hook when the git hook is absent", async () => {
    const repo = await fixture({ remote: false })
    repo.write(".husky/commit-msg", "pnpm commitlint --edit $1\n")
    const result = await lint(repo, "Add it")
    expect(result.hook).toBe("pnpm commitlint --edit $1")
    expect(result.pass).toBe(false)
  })

  test("only warns when a commitlint configuration exists without the binary", async () => {
    const repo = await fixture({ remote: false })
    repo.write("commitlint.config.js", "module.exports = {}\n")
    const result = await lint(repo, "Add it")
    expect(result.pass).toBe(true)
    expect(result.commitlint).toBe("not_installed")
    expect(result.warnings).toEqual([
      {
        rule: "commitlint-not-installed",
        message: "A commitlint configuration exists but commitlint is not installed, so only the built-in rules ran.",
      },
    ])
  })

  test("treats a commitlint key in package.json as a configuration", async () => {
    const repo = await fixture({ remote: false })
    repo.write("package.json", '{ "commitlint": { "extends": [] } }\n')
    expect((await lint(repo, "Add it")).commitlint).toBe("not_installed")
  })

  test("refuses lint without a message", async () => {
    const repo = await fixture({ remote: false })
    await expect(invoke(commitRead, { method: "lint" }, { cwd: repo.dir })).rejects.toMatchObject({
      code: "invalid_argument",
      message: "Pass message: the full commit message to check.",
    })
  })

  test("refuses an unknown argument", async () => {
    const repo = await fixture({ remote: false })
    await expect(
      invoke(commitRead, { method: "lint", message: "x", bogus: 1 } as never, { cwd: repo.dir }),
    ).rejects.toMatchObject({ code: "invalid_argument" })
  })

  test("takes the subject and body limits from the arguments", async () => {
    const repo = await fixture({ remote: false })
    const result = await invoke(
      commitRead,
      { method: "lint", message: `${"x".repeat(30)}\n\n${"w".repeat(40)}`, subject_max: 20, body_wrap: 30 },
      { cwd: repo.dir },
    )
    expect(result.lint!.errors.map((finding) => finding.rule)).toEqual(["subject-hard-max"])
    expect(result.lint!.warnings.map((finding) => finding.rule)).toEqual(["body-wrap"])
  })
})
