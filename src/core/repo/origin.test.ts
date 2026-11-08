import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { invoke } from "../tool"
import type { OriginAnchor } from "./origin"
import { repoRead } from "./read"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

async function fixture() {
  const repo = await tempRepo({ remote: false })
  repos.push(repo)
  return repo
}

function traceOrigin(repo: TempRepo, anchor: OriginAnchor, cwd = repo.dir) {
  return invoke(repoRead, { method: "origin", ...anchor }, { cwd })
}

describe("git_repo_read origin", () => {
  test("reads a short sha and preserves the full message and trailer", async () => {
    const repo = await fixture()
    const message = "feat: add (#7)\n\nA detailed explanation.\n\nRefs: #9"
    const sha = await repo.commit(message, { "a.txt": "a\n" })
    const result = await traceOrigin(repo, { sha: sha.slice(0, 8) })
    expect(result.origin).toEqual({
      commit: {
        sha,
        subject: "feat: add (#7)",
        message,
        author: "Test",
        author_email: "test@example.com",
        date: (await repo.git(["show", "-s", "--format=%aI", sha])).trim(),
      },
      located_by: "sha",
      pickaxe: null,
    })
  })

  test("blames the range's first line from the working tree root", async () => {
    const repo = await fixture()
    await repo.commit("feat: add", { "a.txt": "one\ntwo\n" })
    const sha = await repo.commit("fix: change", { "a.txt": "changed\ntwo\n" })
    mkdirSync(join(repo.dir, "nested"))
    const result = await traceOrigin(repo, { file: "a.txt", lines: "1,1" }, join(repo.dir, "nested"))
    expect(result.origin).toMatchObject({ commit: { sha }, located_by: "blame a.txt:1,1", pickaxe: null })
  })

  test("returns the oldest token hit when a string is added then removed", async () => {
    const repo = await fixture()
    const oldest = await repo.commit("feat: needle", { "a.txt": "needle\nrest\n" })
    const newest = await repo.commit("fix: remove", { "a.txt": "rest\n" })
    const result = await traceOrigin(repo, { token: "needle" })
    expect(result.origin).toMatchObject({
      commit: { sha: oldest },
      located_by: 'pickaxe -S "needle"',
      pickaxe: { hits: 2, newest, oldest },
    })
  })

  test("locates the oldest regex hit", async () => {
    const repo = await fixture()
    const sha = await repo.commit("feat: number", { "a.txt": "item42\n" })
    const result = await traceOrigin(repo, { regex: "item[0-9]+" })
    expect(result.origin).toMatchObject({
      commit: { sha },
      located_by: 'pickaxe -G "item[0-9]+"',
      pickaxe: { hits: 1, newest: sha, oldest: sha },
    })
  })

  test("scopes pickaxe by file", async () => {
    const repo = await fixture()
    await repo.commit("feat: other", { "other.txt": "needle\n" })
    const sha = await repo.commit("feat: selected", { "a.txt": "needle\n" })
    const result = await traceOrigin(repo, { token: "needle", file: "a.txt" })
    expect(result.origin).toMatchObject({
      commit: { sha },
      located_by: 'pickaxe -S "needle" in a.txt',
      pickaxe: { hits: 1, newest: sha, oldest: sha },
    })
  })

  test("searches for a string that starts with a dash", async () => {
    const repo = await fixture()
    const sha = await repo.commit("feat: flag", { "a.txt": "--all\n" })
    const result = await traceOrigin(repo, { token: "--all" })
    expect(result.origin!.commit.sha).toBe(sha)
  })

  const invalidAnchors: OriginAnchor[] = [
    {},
    { sha: "abcd", file: "a.txt" },
    { lines: "1,1" },
    { file: "a.txt" },
    { token: "needle", regex: "needle" },
    { file: "a.txt", lines: "1,1", token: "needle" },
    { file: "a.txt", lines: "bad range" },
    { sha: "not-hex" },
    { sha: "0".repeat(40) },
  ]
  for (const anchor of invalidAnchors) {
    test(`refuses an invalid anchor ${JSON.stringify(anchor)}`, async () => {
      const repo = await fixture()
      await expect(traceOrigin(repo, anchor)).rejects.toMatchObject({
        code: "invalid_argument",
      })
    })
  }

  test("refuses an unknown sha", async () => {
    const repo = await fixture()
    await expect(traceOrigin(repo, { sha: "f".repeat(40) })).rejects.toMatchObject({
      code: "not_found",
      message: expect.stringContaining("is not a commit in this clone"),
    })
  })

  test("refuses a file not in HEAD", async () => {
    const repo = await fixture()
    repo.write("a.txt", "untracked\n")
    await expect(traceOrigin(repo, { file: "a.txt", lines: "1,1" })).rejects.toMatchObject({
      code: "not_found",
      message: expect.stringContaining("is not in HEAD"),
    })
  })

  test("refuses an uncommitted first line", async () => {
    const repo = await fixture()
    await repo.commit("feat: add", { "a.txt": "one\ntwo\n" })
    repo.write("a.txt", "changed\ntwo\n")
    await expect(traceOrigin(repo, { file: "a.txt", lines: "1,1" })).rejects.toMatchObject({
      code: "not_found",
      message: expect.stringContaining("not committed yet"),
    })
  })

  test("refuses a pickaxe with no hit", async () => {
    const repo = await fixture()
    await expect(traceOrigin(repo, { token: "absent needle" })).rejects.toMatchObject({
      code: "not_found",
      message: expect.stringContaining("No commit in HEAD's history adds or removes"),
    })
  })

  test("refuses another method's limit argument", async () => {
    const repo = await fixture()
    await expect(
      invoke(repoRead, { method: "origin", token: "needle", limit: 10 }, { cwd: repo.dir }),
    ).rejects.toMatchObject({
      code: "invalid_argument",
      message: expect.stringContaining('"limit" is an argument of method "conventions"'),
    })
  })
})
