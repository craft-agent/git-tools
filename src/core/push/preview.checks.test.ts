import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { previewOf } from "../../testing/push-fixtures"
import { layer } from "../../testing/rebase-fixtures"
import { PREFIXED } from "../../testing/secret-fixtures"
import { PUBLISHED_TEXT_RULES_OPTION } from "./published-text"

const repos: TempRepo[] = []
const dirs: string[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function fixture() {
  const repo = await tempRepo()
  repos.push(repo)
  return repo
}

const TOKEN = PREFIXED["github-pat"]!

/** The findings of the builtin rules, which a gitleaks on this machine does not change. */
const builtin = (result: Awaited<ReturnType<typeof previewOf>>) =>
  result.secrets.findings.filter((finding) => finding.source === "builtin")

/** The option that names a rules file holding `content`. */
function rulesFile(content: string) {
  const dir = mkdtempSync(join(tmpdir(), "push-rules-"))
  dirs.push(dir)
  const path = join(dir, "rules.json")
  writeFileSync(path, content)
  return { [PUBLISHED_TEXT_RULES_OPTION]: path }
}

describe("git_push_read preview secrets", () => {
  test("finds a secret one commit adds and the next removes, and never returns its value", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    await repo.commit("feat: add", { "secret.ts": `const v = "${TOKEN}"\n` })
    await repo.git(["rm", "--quiet", "secret.ts"])
    await repo.commit("feat: remove")

    const result = await previewOf(repo)
    expect(builtin(result)).toEqual([
      expect.objectContaining({
        file: "secret.ts",
        line: 1,
        rule: "github-pat",
        fingerprint: "secret.ts:1:github-pat",
      }),
    ])
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })

  test("scans the commits of every branch that is pushed", async () => {
    const repo = await fixture()
    await layer(repo, "l1")
    await layer(repo, "l2")
    await repo.commit("l2: secret", { "l2.ts": `const v = "${TOKEN}"\n` })
    await layer(repo, "l3")

    expect(builtin(await previewOf(repo)).map((finding) => finding.file)).toEqual(["l2.ts"])
  })

  test("leaves out commits the remote already has", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    await repo.commit("feat: add", { "secret.ts": `const v = "${TOKEN}"\n` })
    await repo.git(["push", "-u", "origin", "feat"])
    await repo.commit("feat: clean", { "clean.ts": "const v = 1\n" })

    const result = await previewOf(repo)
    expect(result.branches[0]!.kind).toBe("fast_forward")
    expect(builtin(result)).toEqual([])
  })

  test("finds nothing in a clean push, and has nothing to scan when everything is up to date", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    await repo.git(["push", "-u", "origin", "feat"])

    const result = await previewOf(repo)
    expect(result.branches[0]!.kind).toBe("none")
    expect(result.secrets.findings).toEqual([])
  })
})

describe("git_push_read preview published text", () => {
  const rules = JSON.stringify([{ rule: "no-wip", pattern: "wip", flags: "i", hint: "Name the change." }])

  test("finds a branch name and a commit subject the rules match", async () => {
    const repo = await fixture()
    await repo.git(["switch", "-c", "wip-login"])
    await repo.commit("WIP: try it", { "try.txt": "1\n" })

    const result = await previewOf(repo, {}, rulesFile(rules))
    expect(result.published_text.rules).toBe(1)
    expect(result.published_text.findings).toEqual([
      expect.objectContaining({ rule: "no-wip", field: "branch", branch: "wip-login", sha: null, match: "wip" }),
      expect.objectContaining({ rule: "no-wip", field: "subject", branch: "wip-login", match: "WIP" }),
    ])
    expect(result.published_text.findings[1]!.sha).toBe((await repo.git(["rev-parse", "HEAD"])).trim().slice(0, 12))
  })

  test("checks only what is pushed", async () => {
    const repo = await fixture()
    await layer(repo, "wip-login")
    await repo.git(["push", "-u", "origin", "wip-login"])

    const result = await previewOf(repo, {}, rulesFile(rules))
    expect(result.branches[0]!.kind).toBe("none")
    expect(result.published_text.findings).toEqual([])
  })

  test("with no rules set, nothing is checked", async () => {
    const repo = await fixture()
    await layer(repo, "wip-login")

    expect((await previewOf(repo)).published_text).toEqual({ rules: 0, findings: [] })
  })

  test("a rules file that cannot be used fails the call", async () => {
    const repo = await fixture()
    await layer(repo, "feat")

    const error = await previewOf(repo, {}, rulesFile("not json")).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: "invalid_argument" })
  })
})
