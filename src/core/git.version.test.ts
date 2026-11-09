import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isToolError } from "./errors"
import { ensureGit, requireGitVersion, resetGitCheck } from "./git"

const ORIGINAL_PATH = process.env.PATH
const tempDirs: string[] = []

function createTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  tempDirs.push(dir)
  return dir
}

function installFakeGit(versionOutput: string, exitCode = 0): string {
  const dir = createTempDir("fake-git-")
  const script = join(dir, "git")
  writeFileSync(
    script,
    `#!/bin/sh\nif [ "${exitCode}" != "0" ]; then exit ${exitCode}; fi\necho "${versionOutput}"\n`,
    {
      mode: 0o755,
    },
  )
  process.env.PATH = `${dir}:${ORIGINAL_PATH}`
  return dir
}

afterEach(() => {
  if (ORIGINAL_PATH === undefined) delete process.env.PATH
  else process.env.PATH = ORIGINAL_PATH
  resetGitCheck()
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("ensureGit", () => {
  test("throws git_missing when git is not on PATH", async () => {
    const empty = createTempDir("empty-path-")
    process.env.PATH = empty
    resetGitCheck()

    let error: unknown
    try {
      await ensureGit()
    } catch (e) {
      error = e
    }
    expect(isToolError(error)).toBe(true)
    if (isToolError(error)) {
      expect(error.code).toBe("git_missing")
      expect(error.message).toContain("git is not installed or not on PATH")
    }
  })

  test("throws git_too_old when git is older than MIN_GIT_VERSION naming both versions", async () => {
    installFakeGit("git version 2.20.0")
    resetGitCheck()

    let error: unknown
    try {
      await ensureGit()
    } catch (e) {
      error = e
    }
    expect(isToolError(error)).toBe(true)
    if (isToolError(error)) {
      expect(error.code).toBe("git_too_old")
      expect(error.message).toContain("2.20.0")
      expect(error.message).toContain("2.31.0")
    }
  })

  test("parses Apple Git, Windows git, and missing-patch versions", async () => {
    installFakeGit("git version 2.54.0 (Apple Git-157)")
    resetGitCheck()
    await expect(ensureGit()).resolves.toBeUndefined()

    resetGitCheck()
    installFakeGit("git version 2.45.1.windows.1")
    resetGitCheck()
    await expect(ensureGit()).resolves.toBeUndefined()

    resetGitCheck()
    installFakeGit("git version 2.31")
    resetGitCheck()
    await expect(ensureGit()).resolves.toBeUndefined()
  })

  test("throws git_error on unparseable output or non-zero exit", async () => {
    installFakeGit("some random output")
    resetGitCheck()
    let error: unknown
    try {
      await ensureGit()
    } catch (e) {
      error = e
    }
    expect(isToolError(error)).toBe(true)
    if (isToolError(error)) {
      expect(error.code).toBe("git_error")
      expect(error.message).toContain("Could not read the git version")
    }

    resetGitCheck()
    installFakeGit("", 1)
    resetGitCheck()
    let exitError: unknown
    try {
      await ensureGit()
    } catch (e) {
      exitError = e
    }
    expect(isToolError(exitError)).toBe(true)
    if (isToolError(exitError)) {
      expect(exitError.code).toBe("git_error")
      expect(exitError.message).toContain("Could not read the git version")
    }
  })

  test("requireGitVersion names the feature a git older than its minimum lacks", async () => {
    installFakeGit("git version 2.35.1")
    resetGitCheck()

    await expect(requireGitVersion("2.34.0", "a feature")).resolves.toBeUndefined()
    await expect(requireGitVersion("2.38.0", "--update-refs")).rejects.toMatchObject({
      code: "git_too_old",
      message: "git 2.35.1 is older than 2.38.0, which --update-refs needs; update git.",
    })
  })

  test("a failed check is retried after PATH is fixed", async () => {
    const empty = createTempDir("empty-path-")
    process.env.PATH = empty
    resetGitCheck()

    await expect(ensureGit()).rejects.toThrow()

    process.env.PATH = ORIGINAL_PATH
    await expect(ensureGit()).resolves.toBeUndefined()
  })
})
