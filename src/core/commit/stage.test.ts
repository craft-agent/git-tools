import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { invoke } from "../tool"
import { commitRead } from "./read"
import { commitStage } from "./stage"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

async function fixture(options?: Parameters<typeof tempRepo>[0]) {
  const repo = await tempRepo(options)
  repos.push(repo)
  return repo
}

/** `count` numbered lines, with the 1-based line numbers in `changes` replaced. */
function numbered(count: number, changes: Record<number, string> = {}): string {
  return Array.from({ length: count }, (_, i) => changes[i + 1] ?? `line ${i + 1}`).join("\n") + "\n"
}

const list = async (repo: TempRepo, paths?: string[]) =>
  (await invoke(commitRead, { method: "hunks", paths }, { cwd: repo.dir })).hunks!

const stage = (repo: TempRepo, args: { digest: string; hunks: number[]; paths?: string[] }) =>
  invoke(commitStage, args, { cwd: repo.dir })

/** A 30-line file changed at lines 2, 15 and 29: three hunks. */
async function threeHunks() {
  const repo = await fixture()
  await repo.commit("add a", { "a.txt": numbered(30) })
  const edited = numbered(30, { 2: "first change", 15: "second change", 29: "third change" })
  repo.write("a.txt", edited)
  return { repo, edited }
}

describe("git_commit_read hunks", () => {
  test("lists the hunks with ids, counts, a preview and a digest, and leaves untracked files out", async () => {
    const { repo } = await threeHunks()
    repo.write("untracked.txt", "new\n")
    const listing = await list(repo)
    expect(listing.count).toBe(3)
    expect(listing.truncated).toBe(false)
    expect(listing.digest).toMatch(/^[0-9a-f]{16}$/)
    expect(listing.hunks.map(({ id, file, added, removed, binary }) => ({ id, file, added, removed, binary }))).toEqual(
      [
        { id: 1, file: "a.txt", added: 1, removed: 1, binary: false },
        { id: 2, file: "a.txt", added: 1, removed: 1, binary: false },
        { id: 3, file: "a.txt", added: 1, removed: 1, binary: false },
      ],
    )
    expect(listing.hunks[0]!.preview).toContain("+first change")
    expect(listing.hunks[0]!.preview.length).toBeLessThanOrEqual(8)
    expect(listing.hunks.some((hunk) => hunk.file === "untracked.txt")).toBe(false)
  })

  test("refuses an argument of another method and a path outside the working tree", async () => {
    const { repo } = await threeHunks()
    const call = (args: object) => invoke(commitRead, { method: "hunks", ...args }, { cwd: repo.dir })
    await expect(call({ message: "feat: x" })).rejects.toMatchObject({ code: "invalid_argument" })
    await expect(call({ target: "worktree" })).rejects.toMatchObject({ code: "invalid_argument" })
    await expect(call({ paths: ["../elsewhere.txt"] })).rejects.toMatchObject({ code: "invalid_argument" })
    await expect(call({ paths: ["/etc/hosts"] })).rejects.toMatchObject({ code: "invalid_argument" })
    await expect(call({ paths: ["sub/../a.txt"] })).resolves.toBeDefined()
  })
})

describe("git_commit_stage", () => {
  test("stages the middle hunk only and leaves the working tree as it was", async () => {
    const { repo, edited } = await threeHunks()
    const listing = await list(repo)
    const result = await stage(repo, { digest: listing.digest, hunks: [2] })
    expect(result).toEqual({ root: repo.dir, staged: [2], files: [{ file: "a.txt", added: 1, removed: 1 }] })
    const cached = await repo.git(["diff", "--cached"])
    expect(cached).toContain("+second change")
    expect(cached).not.toContain("first change")
    expect(cached).not.toContain("third change")
    expect(await repo.git(["show", ":a.txt"])).toBe(numbered(30, { 15: "second change" }))
    expect(readFileSync(join(repo.dir, "a.txt"), "utf8")).toBe(edited)
  })

  test("stages the file's last hunk and several hunks once each, ids ascending", async () => {
    const { repo } = await threeHunks()
    const listing = await list(repo)
    await stage(repo, { digest: listing.digest, hunks: [3] })
    expect(await repo.git(["show", ":a.txt"])).toBe(numbered(30, { 29: "third change" }))
    const again = await list(repo)
    const result = await stage(repo, { digest: again.digest, hunks: [2, 1, 2] })
    expect(result.staged).toEqual([1, 2])
    expect(await repo.git(["show", ":a.txt"])).toBe(
      numbered(30, { 2: "first change", 15: "second change", 29: "third change" }),
    )
  })

  test("stages the second of two identical blocks at its own place", async () => {
    const block = (n: number) => ["ctx a", "ctx b", "ctx c", "value = old", "ctx d", "ctx e", "ctx f", `unique ${n}`]
    const filler = (n: number) => Array.from({ length: n }, (_, i) => `filler ${n}.${i}`)
    const base = [...filler(20), ...block(1), ...filler(12), ...block(2)]
    const repo = await fixture()
    await repo.commit("add a", { "a.txt": base.join("\n") + "\n" })
    const edited = [...base]
    edited.splice(2, 0, ...Array.from({ length: 16 }, (_, i) => `inserted ${i}`))
    repo.write("a.txt", edited.map((line) => (line === "value = old" ? "value = new" : line)).join("\n") + "\n")
    const listing = await list(repo)
    expect(listing.count).toBe(3)
    await stage(repo, { digest: listing.digest, hunks: [2] })
    const staged = (await repo.git(["show", ":a.txt"])).split("\n")
    expect(staged.indexOf("value = new")).toBe(base.indexOf("value = old"))
    expect(staged.filter((line) => line === "value = old")).toHaveLength(1)
    expect(staged).not.toContain("inserted 0")
  })

  test("refuses a digest of changes that moved on, and stages nothing", async () => {
    const { repo } = await threeHunks()
    const listing = await list(repo)
    repo.write("a.txt", numbered(30, { 2: "first change", 15: "other change" }))
    await expect(stage(repo, { digest: listing.digest, hunks: [1] })).rejects.toMatchObject({ code: "stale" })
    expect(await repo.git(["diff", "--cached", "--name-only"])).toBe("")
  })

  test("refuses an unknown id", async () => {
    const { repo } = await threeHunks()
    const listing = await list(repo)
    const refused = stage(repo, { digest: listing.digest, hunks: [1, 4] })
    await expect(refused).rejects.toMatchObject({ code: "invalid_argument" })
    await expect(refused).rejects.toThrow(/4.*3/)
    expect(await repo.git(["diff", "--cached", "--name-only"])).toBe("")
  })

  test("refuses a binary file and points to git add", async () => {
    const repo = await fixture()
    writeFileSync(join(repo.dir, "img.bin"), Buffer.from([0, 1, 2, 3]))
    await repo.git(["add", "img.bin"])
    await repo.git(["commit", "-m", "add image"])
    writeFileSync(join(repo.dir, "img.bin"), Buffer.from([0, 9, 8, 7, 0]))
    const listing = await list(repo)
    expect(listing.hunks).toMatchObject([{ id: 1, file: "img.bin", header: "(binary)", binary: true }])
    const refused = stage(repo, { digest: listing.digest, hunks: [1] })
    await expect(refused).rejects.toMatchObject({ code: "invalid_argument" })
    await expect(refused).rejects.toThrow(/git add/)
  })

  test("takes the same paths for the listing and the staging", async () => {
    const repo = await fixture()
    await repo.commit("add files", { "a.txt": numbered(5), "dir/b.txt": numbered(5), "dir/c d.txt": numbered(5) })
    for (const path of ["a.txt", "dir/b.txt", "dir/c d.txt"]) repo.write(path, numbered(5, { 3: "changed" }))
    const scoped = await list(repo, ["dir"])
    expect(scoped.hunks.map((hunk) => hunk.file)).toEqual(["dir/b.txt", "dir/c d.txt"])
    await expect(stage(repo, { digest: scoped.digest, hunks: [2] })).rejects.toMatchObject({ code: "stale" })
    const result = await stage(repo, { digest: scoped.digest, hunks: [2], paths: ["dir"] })
    expect(result.files).toEqual([{ file: "dir/c d.txt", added: 1, removed: 1 }])
    await expect(stage(repo, { digest: scoped.digest, hunks: [1], paths: ["../x"] })).rejects.toMatchObject({
      code: "invalid_argument",
    })
  })

  test("reports the whole index, and works before the first commit", async () => {
    const repo = await fixture({ remote: false, initialCommit: false })
    repo.write("a.txt", "one\n")
    await repo.git(["add", "-N", "a.txt"])
    const listing = await list(repo)
    expect(listing.hunks).toMatchObject([{ file: "a.txt", added: 1, removed: 0 }])
    const result = await stage(repo, { digest: listing.digest, hunks: [1] })
    expect(result.files).toEqual([{ file: "a.txt", added: 1, removed: 0 }])
    expect(await repo.git(["show", ":a.txt"])).toBe("one\n")
  })

  test("is an idempotent change that names the working tree as its target", async () => {
    const repo = await fixture()
    expect(commitStage.class).toBe("idempotent")
    expect(commitStage.openWorld).toBe(false)
    const args = { digest: "x", hunks: [1] }
    expect(await commitStage.targets!(args, { cwd: repo.dir })).toEqual([repo.dir])
  })
})
