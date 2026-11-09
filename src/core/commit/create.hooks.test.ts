import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { type TempRepo, tempRepo } from "../../testing/git-repo"
import { PREFIXED } from "../../testing/secret-fixtures"
import { ToolError } from "../errors"
import { invoke } from "../tool"
import { commitCreate } from "./create"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

async function fixture() {
  const repo = await tempRepo()
  repos.push(repo)
  return repo
}

async function create(repo: TempRepo, message: string) {
  return invoke(commitCreate, { message }, { cwd: repo.dir })
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

async function stage(repo: TempRepo, path: string, content: string): Promise<void> {
  repo.write(path, content)
  await repo.git(["add", path])
}

function installHook(repo: TempRepo, name: string, script: string, mode = 0o755): void {
  repo.write(`.git/hooks/${name}`, `#!/bin/sh\n${script}\n`)
  chmodSync(join(repo.dir, ".git", "hooks", name), mode)
}

describe("git_commit_create hooks", () => {
  test("reports a rejecting hook with its output and exit code", async () => {
    const repo = await fixture()
    const before = (await repo.git(["rev-parse", "HEAD"])).trim()
    installHook(repo, "pre-commit", 'echo "tests are red" >&2\nexit 1')
    await stage(repo, "a.txt", "a\n")

    const error = await failure(create(repo, "feat: add a"))

    expect(error.code).toBe("check_failed")
    expect(error.details).toMatchObject({ check: "hook", hooks: ["pre-commit"], exit_code: 1, left_modified: [] })
    expect((error.details as { output: string }).output).toContain("tests are red")
    expect((await repo.git(["rev-parse", "HEAD"])).trim()).toBe(before)
  })

  test("keeps only the last lines of a long hook output", async () => {
    const repo = await fixture()
    installHook(repo, "pre-commit", "i=1\nwhile [ $i -le 100 ]; do echo line-$i; i=$((i+1)); done\nexit 1")
    await stage(repo, "a.txt", "a\n")

    const error = await failure(create(repo, "feat: add a"))

    const lines = (error.details as { output: string }).output.split("\n")
    expect(lines).toHaveLength(40)
    expect(lines.at(-1)).toBe("line-100")
    expect(lines[0]).toBe("line-61")
  })

  test("names the files a rejecting hook left modified", async () => {
    const repo = await fixture()
    installHook(repo, "pre-commit", "echo touched >> README.md\nexit 1")
    await stage(repo, "a.txt", "a\n")

    const error = await failure(create(repo, "feat: add a"))

    expect(error.details).toMatchObject({ check: "hook", left_modified: ["README.md"] })
  })

  test("does not count a file that was modified before the commit as left modified", async () => {
    const repo = await fixture()
    repo.write("README.md", "# Edited\n")
    installHook(repo, "pre-commit", "exit 1")
    await stage(repo, "a.txt", "a\n")

    const error = await failure(create(repo, "feat: add a"))

    expect(error.details).toMatchObject({ left_modified: [] })
  })

  test("ignores a hook that is not executable", async () => {
    const repo = await fixture()
    installHook(repo, "pre-commit", "exit 1", 0o644)
    await stage(repo, "a.txt", "a\n")

    const result = await create(repo, "feat: add a")

    expect(result.subject).toBe("feat: add a")
  })

  test("reports files a passing hook left modified", async () => {
    const repo = await fixture()
    installHook(repo, "pre-commit", "echo touched >> README.md")
    await stage(repo, "a.txt", "a\n")

    const result = await create(repo, "feat: add a")

    expect(result).toMatchObject({ left_modified: ["README.md"], changed_by_hook: [] })
    expect(result.remaining.unstaged).toBe(1)
  })

  test("reports a file a hook staged, and scans what it staged", async () => {
    const repo = await fixture()
    installHook(repo, "pre-commit", `echo "id ${PREFIXED["github-pat"]}" > secret.txt\ngit add secret.txt`)
    await stage(repo, "a.txt", "a\n")

    const result = await create(repo, "feat: add a")

    expect(result.changed_by_hook).toEqual(["secret.txt"])
    expect(result.hook_findings).toEqual([expect.objectContaining({ file: "secret.txt", rule: "github-pat" })])
    expect(result.files.map((file) => file.file).sort()).toEqual(["a.txt", "secret.txt"])
  })

  test("reports a file a hook staged that holds no credential", async () => {
    const repo = await fixture()
    installHook(repo, "pre-commit", "echo extra > extra.txt\ngit add extra.txt")
    await stage(repo, "a.txt", "a\n")

    const result = await create(repo, "feat: add a")

    expect(result).toMatchObject({ changed_by_hook: ["extra.txt"], hook_findings: [] })
  })

  test("shows a commit-msg hook the exact message that was checked", async () => {
    const repo = await fixture()
    const seen = join(repo.home, "seen.txt")
    installHook(repo, "commit-msg", `cp "$1" "${seen}"`)
    await stage(repo, "a.txt", "a\n")

    const result = await create(repo, "feat: add a  \r\n\r\n\r\nWhy it is needed.  \n\n")

    expect(readFileSync(seen, "utf8")).toBe("feat: add a\n\nWhy it is needed.\n")
    expect(result.message_matches).toBe(true)
  })

  test("reports a commit-msg hook that rewrote the message", async () => {
    const repo = await fixture()
    installHook(repo, "commit-msg", 'echo "Signed-off-by: hook" >> "$1"')
    await stage(repo, "a.txt", "a\n")

    const result = await create(repo, "feat: add a")

    expect(result.message_matches).toBe(false)
    expect(result.subject).toBe("feat: add a")
  })
})
