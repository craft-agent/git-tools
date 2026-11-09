import { afterEach, describe, expect, test } from "bun:test"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { invoke } from "../tool"
import { commitRead } from "./read"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

async function fixture() {
  const repo = await tempRepo()
  repos.push(repo)
  return repo
}

/** Built at run time, so this file never holds a token-shaped string. */
const TOKEN = ["gh", "p_"].join("") + "a1B2".repeat(9)

describe("git_commit_read secrets", () => {
  test("scans the staged changes by default, with the value redacted", async () => {
    const repo = await fixture()
    repo.write("config.txt", `first line\nvalue ${TOKEN}\n`)
    await repo.git(["add", "config.txt"])
    const { secrets } = await invoke(commitRead, { method: "secrets" }, { cwd: repo.dir })
    expect(secrets).toMatchObject({ pass: false, target: "staged", count: 1 })
    expect(secrets!.findings[0]).toMatchObject({
      file: "config.txt",
      line: 2,
      rule: "github-pat",
      source: "builtin",
      fingerprint: "config.txt:2:github-pat",
    })
    expect(JSON.stringify(secrets)).not.toContain(TOKEN)
  })

  test("passes when the scanned changes hold nothing", async () => {
    const repo = await fixture()
    repo.write("config.txt", `value ${TOKEN}\n`)
    const { secrets } = await invoke(commitRead, { method: "secrets" }, { cwd: repo.dir })
    expect(secrets).toMatchObject({ pass: true, count: 0, findings: [] })
  })

  test("scans a commit range and only the paths asked for", async () => {
    const repo = await fixture()
    await repo.commit("feat: add both", { "a.txt": `${TOKEN}\n`, "b.txt": `${TOKEN}\n` })
    const { secrets } = await invoke(
      commitRead,
      { method: "secrets", target: "range", range: "HEAD~1..HEAD", paths: ["b.txt"] },
      { cwd: repo.dir },
    )
    expect(secrets!.findings.map((finding) => finding.file)).toEqual(["b.txt"])
  })

  test("refuses a lint argument and a range without the range target", async () => {
    const repo = await fixture()
    const call = (args: object) => invoke(commitRead, { method: "secrets", ...args }, { cwd: repo.dir })
    await expect(call({ message: "feat: x" })).rejects.toMatchObject({ code: "invalid_argument" })
    await expect(call({ range: "HEAD~1..HEAD" })).rejects.toMatchObject({ code: "invalid_argument" })
  })
})
