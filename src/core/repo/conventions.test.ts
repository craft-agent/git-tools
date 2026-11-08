import { afterEach, describe, expect, test } from "bun:test"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { invoke } from "../tool"
import { repoRead } from "./read"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

async function fixture(options: Parameters<typeof tempRepo>[0]) {
  const repo = await tempRepo(options)
  repos.push(repo)
  return repo
}

describe("git_repo_read conventions", () => {
  test("returns an empty sample for unborn HEAD", async () => {
    const repo = await fixture({ remote: false, initialCommit: false })
    const result = await invoke(repoRead, { method: "conventions" }, { cwd: repo.dir })
    expect(result.conventions).toEqual({
      sample_size: 0,
      conventional_ratio: 0,
      type_frequency: {},
      scopes: [],
      config_files: [],
      subjects: [],
      pr_template: null,
    })
  })

  test("summarizes subjects, convention files and the pull request template", async () => {
    const repo = await fixture({ initialCommit: false })
    await repo.commit("feat(api): one", {
      "commitlint.config.js": "module.exports = {}\n",
      ".github/PULL_REQUEST_TEMPLATE.md": "## x\n",
    })
    for (const subject of ["fix(api): two", "fix(web): three", "plain subject"]) {
      await repo.git(["commit", "--allow-empty", "-m", subject])
    }
    const result = await invoke(repoRead, { method: "conventions", limit: 10 }, { cwd: repo.dir })
    expect(result.conventions).toEqual({
      sample_size: 4,
      conventional_ratio: 0.75,
      type_frequency: { feat: 1, fix: 2 },
      scopes: ["web", "api"],
      config_files: ["commitlint.config.js"],
      subjects: ["plain subject", "fix(web): three", "fix(api): two", "feat(api): one"],
      pr_template: ".github/PULL_REQUEST_TEMPLATE.md",
    })
  })

  test("does not sample merge commits", async () => {
    const repo = await fixture({ remote: false })
    await repo.git(["switch", "-c", "topic"])
    await repo.commit("feat: topic", { "topic.txt": "topic\n" })
    await repo.git(["switch", "main"])
    await repo.commit("fix: main", { "main.txt": "main\n" })
    await repo.git(["merge", "--no-ff", "topic", "-m", "merge subject"])
    const result = await invoke(repoRead, { method: "conventions" }, { cwd: repo.dir })
    expect(result.conventions!.sample_size).toBe(3)
    expect(result.conventions!.subjects).not.toContain("merge subject")
  })

  test("refuses a sample limit above 200", async () => {
    const repo = await fixture({ remote: false })
    await expect(invoke(repoRead, { method: "conventions", limit: 201 }, { cwd: repo.dir })).rejects.toMatchObject({
      code: "invalid_argument",
    })
  })
})
