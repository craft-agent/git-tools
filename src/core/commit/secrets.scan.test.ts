import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { ToolError } from "../errors"
import { PREFIXED, randomish } from "../../testing/secret-fixtures"
import { scanSecrets } from "./secrets"

const SECRET_LINE = `const v = "${PREFIXED["github-pat"]}"\n`
const NPM_LINE = `const w = "${PREFIXED["npm-token"]}"\n`

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

/** Installs a fake `gitleaks` that records its arguments and prints `stdout`, then exits with `code`. */
function fakeGitleaks(stdout: string, code = 0): string {
  const argsFile = join(binDir, "args.txt")
  const reportFile = join(binDir, "report.txt")
  writeFileSync(reportFile, stdout)
  writeExecutable("gitleaks", `printf '%s\\n' "$@" > '${argsFile}'\n/bin/cat '${reportFile}'\nexit ${code}`)
  return argsFile
}

async function fixture() {
  const repo = await tempRepo({ remote: false })
  repos.push(repo)
  return repo
}

/** Writes `content` to `path` and stages it. */
async function stage(repo: TempRepo, path: string, content: string): Promise<void> {
  repo.write(path, content)
  await repo.git(["add", path])
}

async function scanFiles(repo: TempRepo, scope: Parameters<typeof scanSecrets>[1]) {
  const { findings, gitleaks } = await scanSecrets(repo.dir, scope)
  return { gitleaks, files: findings.map((finding) => `${finding.file}:${finding.rule}`) }
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

describe("scanSecrets targets", () => {
  test("staged, worktree and range each see only their own changes", async () => {
    const repo = await fixture()
    await repo.commit("add committed", { "committed.ts": NPM_LINE })
    await stage(repo, "staged.ts", SECRET_LINE)
    repo.write("README.md", `# Test\n${SECRET_LINE}`)

    expect(await scanFiles(repo, { target: "staged" })).toEqual({
      gitleaks: "not_installed",
      files: ["staged.ts:github-pat"],
    })
    expect((await scanFiles(repo, { target: "worktree" })).files).toEqual(["README.md:github-pat"])
    expect((await scanFiles(repo, { target: "range", range: "HEAD~1..HEAD" })).files).toEqual([
      "committed.ts:npm-token",
    ])
  })

  test("reports the new-side line number", async () => {
    const repo = await fixture()
    await stage(repo, "a.ts", `one\ntwo\n${SECRET_LINE}`)
    const { findings } = await scanSecrets(repo.dir, { target: "staged" })
    expect(findings.map((finding) => finding.fingerprint)).toEqual(["a.ts:3:github-pat"])
  })

  test("finds nothing in a clean tree", async () => {
    const repo = await fixture()
    expect(await scanSecrets(repo.dir, { target: "staged" })).toEqual({ gitleaks: "not_installed", findings: [] })
  })

  test("works before the first commit", async () => {
    const repo = await tempRepo({ remote: false, initialCommit: false })
    repos.push(repo)
    await stage(repo, "a.ts", SECRET_LINE)
    expect((await scanFiles(repo, { target: "staged" })).files).toEqual(["a.ts:github-pat"])
  })

  test("paths limit the scan to files and directories", async () => {
    const repo = await fixture()
    repo.write("src/a.ts", SECRET_LINE)
    repo.write("docs/b.ts", NPM_LINE)
    await repo.git(["add", "-A"])
    expect((await scanFiles(repo, { target: "staged", paths: ["src"] })).files).toEqual(["src/a.ts:github-pat"])
    expect((await scanFiles(repo, { target: "staged", paths: ["docs/b.ts"] })).files).toEqual(["docs/b.ts:npm-token"])
    expect((await scanFiles(repo, { target: "staged", paths: [] })).files).toEqual([
      "docs/b.ts:npm-token",
      "src/a.ts:github-pat",
    ])
  })
})

describe("scanSecrets arguments", () => {
  async function refusal(scope: Parameters<typeof scanSecrets>[1]): Promise<ToolError> {
    const repo = await fixture()
    const error = await scanSecrets(repo.dir, scope).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ToolError)
    return error as ToolError
  }

  test("the range target needs a range", async () => {
    expect((await refusal({ target: "range" })).code).toBe("invalid_argument")
    expect((await refusal({ target: "range", range: "  " })).code).toBe("invalid_argument")
  })

  test("a range is refused with the other targets", async () => {
    expect((await refusal({ target: "staged", range: "HEAD~1..HEAD" })).code).toBe("invalid_argument")
    expect((await refusal({ target: "worktree", range: "HEAD" })).code).toBe("invalid_argument")
  })

  test("a range that starts with a dash is refused", async () => {
    expect((await refusal({ target: "range", range: "--output=/tmp/x" })).code).toBe("invalid_argument")
  })
})

describe("scanSecrets gitleaks", () => {
  const item = { File: "src/x.ts", StartLine: 3, RuleID: "fake-rule", Secret: randomish(30) }

  test("is not_installed when the program is not on the PATH", async () => {
    const repo = await fixture()
    await stage(repo, "a.ts", SECRET_LINE)
    const result = await scanSecrets(repo.dir, { target: "staged" })
    expect(result.gitleaks).toBe("not_installed")
    expect(result.findings.map((finding) => finding.source)).toEqual(["builtin"])
  })

  test("ran: its findings are merged with the builtin ones", async () => {
    const repo = await fixture()
    await stage(repo, "a.ts", SECRET_LINE)
    const argsFile = fakeGitleaks(JSON.stringify([item]))
    const result = await scanSecrets(repo.dir, { target: "staged" })
    expect(result.gitleaks).toBe("ran")
    expect(result.findings).toEqual([
      expect.objectContaining({ file: "a.ts", rule: "github-pat", source: "builtin" }),
      {
        file: "src/x.ts",
        line: 3,
        rule: "fake-rule",
        redacted: item.Secret.slice(0, 16),
        source: "gitleaks",
        fingerprint: "src/x.ts:3:fake-rule",
      },
    ])
    expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual([
      "git",
      "--no-banner",
      "--redact",
      "--report-format",
      "json",
      "--report-path",
      "-",
      "--exit-code",
      "0",
      "--staged",
      repo.dir,
    ])
  })

  test("the target picks the gitleaks mode", async () => {
    const repo = await fixture()
    const argsFile = fakeGitleaks("[]")
    await scanSecrets(repo.dir, { target: "worktree" })
    expect(readFileSync(argsFile, "utf8")).toContain("--pre-commit\n")
    await scanSecrets(repo.dir, { target: "range", range: "main..HEAD" })
    expect(readFileSync(argsFile, "utf8")).toContain("--log-opts=main..HEAD\n")
  })

  test("paths filter its findings too", async () => {
    const repo = await fixture()
    const other = { ...item, File: "other/y.ts", RuleID: "other-rule" }
    fakeGitleaks(JSON.stringify([item, other]))
    const result = await scanSecrets(repo.dir, { target: "staged", paths: ["./src/"] })
    expect(result.findings.map((finding) => finding.rule)).toEqual(["fake-rule"])
  })

  test("failed: a non-zero exit still returns the builtin findings", async () => {
    const repo = await fixture()
    await stage(repo, "a.ts", SECRET_LINE)
    fakeGitleaks(JSON.stringify([item]), 1)
    const result = await scanSecrets(repo.dir, { target: "staged" })
    expect(result.gitleaks).toBe("failed")
    expect(result.findings.map((finding) => finding.rule)).toEqual(["github-pat"])
  })

  test("failed: output that is not a JSON array of findings", async () => {
    const repo = await fixture()
    for (const output of ["not json", "{}", "", '[{"File":1}]']) {
      fakeGitleaks(output)
      expect((await scanSecrets(repo.dir, { target: "staged" })).gitleaks).toBe("failed")
    }
  })

  test("an empty array is ran with no findings", async () => {
    const repo = await fixture()
    fakeGitleaks("[]")
    expect(await scanSecrets(repo.dir, { target: "staged" })).toEqual({ gitleaks: "ran", findings: [] })
  })
})
