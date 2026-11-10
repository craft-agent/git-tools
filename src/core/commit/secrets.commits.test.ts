import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { PREFIXED } from "../../testing/secret-fixtures"
import { scanCommits } from "./secrets"

const SECRET_LINE = `const v = "${PREFIXED["github-pat"]}"\n`

const originalPath = process.env.PATH
const repos: TempRepo[] = []
let binDir = ""

function realGit(): string {
  for (const dir of (originalPath ?? "").split(delimiter)) {
    if (existsSync(join(dir, "git"))) return join(dir, "git")
  }
  throw new Error("git is not on PATH")
}

function writeExecutable(name: string, body: string): void {
  const path = join(binDir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

/** Installs a fake `gitleaks` that records its arguments and prints an empty report. */
function fakeGitleaks(): string {
  const argsFile = join(binDir, "args.txt")
  writeExecutable("gitleaks", `printf '%s\\n' "$@" > '${argsFile}'\necho '[]'`)
  return argsFile
}

async function fixture() {
  const repo = await tempRepo({ remote: false })
  repos.push(repo)
  return repo
}

beforeEach(() => {
  // A PATH with git and no gitleaks, so a gitleaks installed on this machine never takes part.
  binDir = mkdtempSync(join(tmpdir(), "secrets-bin-"))
  writeExecutable("git", `exec '${realGit()}' "$@"`)
  process.env.PATH = binDir
})

afterEach(() => {
  process.env.PATH = originalPath
  for (const repo of repos.splice(0)) repo.cleanup()
  rmSync(binDir, { recursive: true, force: true })
})

describe("scanCommits", () => {
  test("scans each commit's own patch, so a secret a later commit removes is found", async () => {
    const repo = await fixture()
    await repo.commit("add", { "a.ts": SECRET_LINE })
    await repo.git(["rm", "--quiet", "a.ts"])
    await repo.commit("remove")

    const result = await scanCommits(repo.dir, ["HEAD", "--not", "HEAD~2"])
    expect(result.gitleaks).toBe("not_installed")
    expect(result.findings.map((finding) => finding.fingerprint)).toEqual(["a.ts:1:github-pat"])
  })

  test("finds nothing in the commits a revision expression leaves out", async () => {
    const repo = await fixture()
    await repo.commit("add", { "a.ts": SECRET_LINE })
    await repo.commit("clean", { "b.ts": "const w = 1\n" })

    expect((await scanCommits(repo.dir, ["HEAD", "--not", "HEAD~1"])).findings).toEqual([])
  })

  test("gives gitleaks the same expression as its log options", async () => {
    const repo = await fixture()
    await repo.commit("add", { "a.ts": SECRET_LINE })
    const argsFile = fakeGitleaks()

    const result = await scanCommits(repo.dir, ["HEAD", "--not", "HEAD~1", "--remotes=origin"])
    expect(result.gitleaks).toBe("ran")
    expect(result.findings.map((finding) => finding.source)).toEqual(["builtin"])
    expect(readFileSync(argsFile, "utf8").trim().split("\n")).toContain("--log-opts=HEAD --not HEAD~1 --remotes=origin")
  })
})
