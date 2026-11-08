import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tempRepo, type TempRepo } from "../testing/git-repo"
import { ToolError } from "./errors"
import { gitResult } from "./git"
import { defaultBranchRef, gitPath, operationInProgress, workingTree } from "./tree"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) {
    repo.cleanup()
  }
})

describe("workingTree", () => {
  test("refuses a cwd inside ownDir with not_a_repository and runs no git", async () => {
    const repo = await tempRepo()
    repos.push(repo)

    let error: unknown
    try {
      await workingTree({ cwd: repo.dir, ownDir: repo.dir })
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(ToolError)
    const toolErr = error as ToolError
    expect(toolErr.code).toBe("not_a_repository")
    expect(toolErr.message).toContain("where these tools are installed")
  })

  test("returns the realpath top level from a subdirectory", async () => {
    const repo = await tempRepo()
    repos.push(repo)

    repo.write("sub/nested/file.txt", "content")
    const top = await workingTree({ cwd: join(repo.dir, "sub", "nested") })
    expect(top).toBe(repo.dir)
  })

  test("fails with not_a_repository for a plain directory outside any repo", async () => {
    const plainDir = realpathSync(mkdtempSync(join(tmpdir(), "plain-dir-")))
    try {
      let error: unknown
      try {
        await workingTree({ cwd: plainDir })
      } catch (err) {
        error = err
      }
      expect(error).toBeInstanceOf(ToolError)
      expect((error as ToolError).code).toBe("not_a_repository")
    } finally {
      rmSync(plainDir, { recursive: true, force: true })
    }
  })
})

describe("operationInProgress", () => {
  test("is null when idle", async () => {
    const repo = await tempRepo()
    repos.push(repo)
    expect(await operationInProgress(repo.dir)).toBe(null)
  })

  test("detects merge during a conflicted merge", async () => {
    const repo = await tempRepo()
    repos.push(repo)

    repo.write("a.txt", "base\n")
    await repo.commit("base")
    await repo.git(["switch", "-c", "topic"])
    repo.write("a.txt", "topic change\n")
    await repo.commit("topic change")
    await repo.git(["switch", "main"])
    repo.write("a.txt", "main change\n")
    await repo.commit("main change")

    const res = await gitResult(["merge", "topic"], { cwd: repo.dir })
    expect(res.code).not.toBe(0)
    expect(await operationInProgress(repo.dir)).toBe("merge")
  })

  test("detects rebase during a stopped rebase", async () => {
    const repo = await tempRepo()
    repos.push(repo)

    repo.write("a.txt", "base\n")
    await repo.commit("base")
    await repo.git(["switch", "-c", "topic"])
    repo.write("a.txt", "topic change\n")
    await repo.commit("topic change")
    await repo.git(["switch", "main"])
    repo.write("a.txt", "main change\n")
    await repo.commit("main change")

    await repo.git(["switch", "topic"])
    const res = await gitResult(["rebase", "main"], { cwd: repo.dir })
    expect(res.code).not.toBe(0)
    expect(await operationInProgress(repo.dir)).toBe("rebase")
  })

  test("detects cherry-pick during a conflicted cherry-pick", async () => {
    const repo = await tempRepo()
    repos.push(repo)

    repo.write("a.txt", "base\n")
    await repo.commit("base")
    await repo.git(["switch", "-c", "topic"])
    repo.write("a.txt", "topic change\n")
    const topicSha = await repo.commit("topic change")
    await repo.git(["switch", "main"])
    repo.write("a.txt", "main change\n")
    await repo.commit("main change")

    const res = await gitResult(["cherry-pick", topicSha], { cwd: repo.dir })
    expect(res.code).not.toBe(0)
    expect(await operationInProgress(repo.dir)).toBe("cherry-pick")
  })
})

describe("defaultBranchRef and gitPath", () => {
  test("finds origin/HEAD when configured", async () => {
    const repo = await tempRepo()
    repos.push(repo)

    await repo.git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"])
    expect(await defaultBranchRef(repo.dir)).toBe("origin/main")
  })

  test("falls back to origin/main when origin/HEAD is not set", async () => {
    const repo = await tempRepo()
    repos.push(repo)

    expect(await defaultBranchRef(repo.dir)).toBe("origin/main")
  })

  test("returns null when there is no remote", async () => {
    const repo = await tempRepo({ remote: false })
    repos.push(repo)

    expect(await defaultBranchRef(repo.dir)).toBe(null)
  })

  test("resolves gitPath for a known git file", async () => {
    const repo = await tempRepo()
    repos.push(repo)

    const headPath = await gitPath(repo.dir, "HEAD")
    expect(headPath.endsWith("HEAD")).toBe(true)
  })
})
