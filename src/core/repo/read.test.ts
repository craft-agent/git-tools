import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ToolError } from "../errors"
import { annotations, invoke } from "../tool"
import { repoRead } from "./read"

describe("git_repo_read", () => {
  test("annotations give readOnlyHint: true, openWorldHint: false", () => {
    const ann = annotations(repoRead)
    expect(ann.readOnlyHint).toBe(true)
    expect(ann.openWorldHint).toBe(false)
  })

  test("rejects an unknown argument as invalid_argument through invoke", async () => {
    let error: unknown
    try {
      await invoke(repoRead, { method: "status", bogus: 123 }, { cwd: process.cwd() })
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe("invalid_argument")
  })

  test("rejects a cwd outside any repository with not_a_repository", async () => {
    const plainDir = realpathSync(mkdtempSync(join(tmpdir(), "outside-repo-")))
    try {
      let error: unknown
      try {
        await invoke(repoRead, { method: "status" }, { cwd: plainDir })
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
