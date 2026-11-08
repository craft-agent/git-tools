import { afterEach, describe, expect, test } from "bun:test"
import { execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isToolError } from "./errors"
import {
  classifyGitFailure,
  classifyRepositoryRootFailure,
  git,
  gitEnv,
  gitResult,
  repositoryRoot,
  resetGitCheck,
} from "./git"

const tempDirs: string[] = []

function createTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  tempDirs.push(dir)
  return dir
}

function createRepo(): string {
  const dir = createTempDir("git-repo-")
  execSync("git init", { cwd: dir, env: gitEnv() })
  return dir
}

afterEach(() => {
  delete process.env.GIT_DIR
  delete process.env.GIT_WORK_TREE
  delete process.env.GIT_TOOLS_TEST_SECRET
  delete process.env.GIT_EDITOR
  delete process.env.LC_ALL
  resetGitCheck()
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("gitEnv", () => {
  test("passes allowlisted variables, drops others, forces defaults", () => {
    process.env.GIT_DIR = "/nonexistent"
    process.env.GIT_WORK_TREE = "/nonexistent"
    process.env.GIT_TOOLS_TEST_SECRET = "secret"
    process.env.GIT_EDITOR = "vim"
    delete process.env.LC_ALL

    const env = gitEnv()
    expect(env.GIT_DIR).toBeUndefined()
    expect(env.GIT_WORK_TREE).toBeUndefined()
    expect(env.GIT_TOOLS_TEST_SECRET).toBeUndefined()
    expect(env.GIT_EDITOR).toBe("true")
    expect(env.GIT_TERMINAL_PROMPT).toBe("0")
    expect(env.GIT_SEQUENCE_EDITOR).toBe("true")
    expect(env.GIT_PAGER).toBe("cat")
    expect(env.NO_COLOR).toBe("1")
    expect(env.LC_ALL).toBeUndefined()
  })

  test("a stray GIT_DIR=/nonexistent does not redirect git", async () => {
    const repo = createRepo()
    process.env.GIT_DIR = "/nonexistent"
    const top = await git(["rev-parse", "--show-toplevel"], { cwd: repo })
    expect(top.trim()).toBe(repo)
  })
})

describe("git execution and results", () => {
  test("git returns stdout; gitResult returns non-zero exit without throwing", async () => {
    const repo = createRepo()
    const output = await git(["rev-parse", "--show-toplevel"], { cwd: repo })
    expect(output.trim()).toBe(repo)

    const result = await gitResult(["rev-parse", "--verify", "--quiet", "refs/heads/nope"], { cwd: repo })
    expect(result.code).toBe(1)
  })

  test("git with a failing command throws git_error carrying git text", async () => {
    const repo = createRepo()
    let error: unknown
    try {
      await git(["rev-parse", "--verify", "refs/heads/nope"], { cwd: repo })
    } catch (e) {
      error = e
    }
    expect(isToolError(error)).toBe(true)
    if (isToolError(error)) {
      expect(error.code).toBe("git_error")
      expect(error.message).toMatch(/^git rev-parse failed \(exit \d+\): .+/s)
    }
  })

  test("classifyGitFailure handles subcommands, fallbacks and truncation", () => {
    expect(classifyGitFailure(["-c", "foo=bar", "commit"], { code: 1, stdout: "", stderr: "err" }).message).toBe(
      "git commit failed (exit 1): err",
    )
    expect(classifyGitFailure(["-C", "/tmp", "status"], { code: 1, stdout: "", stderr: "err" }).message).toBe(
      "git status failed (exit 1): err",
    )
    expect(classifyGitFailure(["diff"], { code: 1, stdout: "out", stderr: "" }).message).toBe(
      "git diff failed (exit 1): out",
    )
    expect(classifyGitFailure(["fetch"], { code: 2, stdout: "", stderr: "" }).message).toBe(
      "git fetch failed (exit 2).",
    )

    const long = "a".repeat(2005)
    const classified = classifyGitFailure(["push"], { code: 1, stdout: "", stderr: long })
    expect(classified.message).toBe(`git push failed (exit 1): ${"a".repeat(2000)}…`)
  })
})

describe("repositoryRoot", () => {
  test("returns realpath top level for repo and subdirectories", async () => {
    const repo = createRepo()
    const sub = join(repo, "subdir")
    mkdirSync(sub)
    expect(await repositoryRoot({ cwd: repo })).toBe(repo)
    expect(await repositoryRoot({ cwd: sub })).toBe(repo)
  })

  test("throws not_a_repository in a plain directory", async () => {
    const plain = createTempDir("plain-dir-")
    let error: unknown
    try {
      await repositoryRoot({ cwd: plain })
    } catch (e) {
      error = e
    }
    expect(isToolError(error)).toBe(true)
    if (isToolError(error)) {
      expect(error.code).toBe("not_a_repository")
      expect(error.message).toContain(`${plain} is not inside a git working tree.`)
    }
  })

  test("safe.directory stderr is classified as git_error", () => {
    const error = classifyRepositoryRootFailure("/some/dir", {
      code: 128,
      stdout: "",
      stderr: "fatal: detected dubious ownership in repository at '/some/dir'\nadd safe.directory",
    })
    expect(error.code).toBe("git_error")
    expect(error.message).toMatch(/^git rev-parse failed \(exit 128\):/)
  })
})

describe("working directory validation", () => {
  test("missing cwd throws not_found", async () => {
    const missing = join(tmpdir(), `missing-${Math.random().toString(36).slice(2)}`)
    await expect(gitResult(["status"], { cwd: missing })).rejects.toThrow(
      `The working directory ${missing} does not exist.`,
    )
  })

  test("file as cwd throws not_found", async () => {
    const dir = createTempDir("file-cwd-")
    const file = join(dir, "a-file")
    writeFileSync(file, "content")
    await expect(gitResult(["status"], { cwd: file })).rejects.toThrow(
      `The working directory ${file} is not a directory.`,
    )
    const below = join(file, "sub")
    await expect(gitResult(["status"], { cwd: below })).rejects.toThrow(
      `The working directory ${below} does not exist.`,
    )
  })
})

describe("hooks, timeout, and stdin", () => {
  test("hooks run by default and are skipped with hooks: false", async () => {
    const repo = createRepo()
    const hooksDir = join(repo, ".git", "hooks")
    mkdirSync(hooksDir, { recursive: true })
    const hook = join(hooksDir, "pre-commit")
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 })
    // A global core.hooksPath would otherwise bypass .git/hooks; the repository's own setting wins over it.
    await git(["config", "core.hooksPath", hooksDir], { cwd: repo })

    const commitArgs = [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "x",
    ]
    const refused = await git(commitArgs, { cwd: repo }).catch((error: unknown) => error)
    expect(isToolError(refused) && refused.code).toBe("git_error")
    await git(commitArgs, { cwd: repo, hooks: false })
    expect((await git(["rev-list", "--count", "HEAD"], { cwd: repo })).trim()).toBe("1")
  })

  test("timeout throws git_error and aborted signal rejects with AbortError", async () => {
    const repo = createRepo()
    let error: unknown
    try {
      await gitResult(["-c", "alias.slow=!sleep 5", "slow"], { cwd: repo, timeoutMs: 200 })
    } catch (e) {
      error = e
    }
    expect(isToolError(error)).toBe(true)
    if (isToolError(error)) {
      expect(error.code).toBe("git_error")
      expect(error.message).toContain("timed out")
    }

    const controller = new AbortController()
    controller.abort()
    const aborted = await gitResult(["status"], { cwd: repo, signal: controller.signal }).catch((e: unknown) => e)
    expect((aborted as Error).name).toBe("AbortError")
  })

  test("stdin is passed to git", async () => {
    const repo = createRepo()
    const hash = await git(["hash-object", "--stdin"], { cwd: repo, stdin: "hello\n" })
    expect(hash.trim()).toBe("ce013625030ba8dba906f756967f9e9ca394464a")
  })
})
