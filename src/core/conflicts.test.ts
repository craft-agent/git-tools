import { afterEach, describe, expect, test } from "bun:test"
import { unlinkSync } from "node:fs"
import { join } from "node:path"
import { tempRepo, type TempRepo } from "../testing/git-repo"
import { parseRegions } from "./conflicts"
import { gitResult } from "./git"
import { repoRead } from "./repo/read"
import { invoke } from "./tool"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

async function diverge() {
  const repo = await tempRepo()
  repos.push(repo)
  await repo.git(["config", "merge.conflictStyle", "diff3"])
  await repo.commit("base", {
    "a.txt": "one\nshared\nthree\n",
    "pnpm-lock.yaml": "lock: 1\n",
    "gone.txt": "g\n",
  })
  await repo.git(["switch", "-c", "topic"])
  const topicSha = await repo.commit("topic change", {
    "a.txt": "one\ntopic\nthree\n",
    "pnpm-lock.yaml": "lock: topic\n",
    "gone.txt": "g2\n",
  })
  await repo.git(["switch", "main"])
  await repo.git(["rm", "gone.txt"])
  await repo.commit("main change", { "a.txt": "one\nmain\nthree\n", "pnpm-lock.yaml": "lock: main\n" })
  return { repo, topicSha }
}

describe("parseRegions", () => {
  test("reads two regions with and without a diff3 base", () => {
    const text = [
      "before",
      "<<<<<<< HEAD",
      "ours",
      "=======",
      "theirs",
      ">>>>>>> topic",
      "between",
      "<<<<<<< HEAD",
      "our next line",
      "||||||| base",
      "shared",
      "=======",
      "their next line",
      ">>>>>>> topic",
    ].join("\n")
    expect(parseRegions(text)).toEqual([
      { line: 2, ours: ["ours"], theirs: ["theirs"], truncated: false },
      { line: 8, ours: ["our next line"], base: ["shared"], theirs: ["their next line"], truncated: false },
    ])
  })

  test("caps each side at 40 lines and marks any overflow", () => {
    for (const side of ["ours", "base", "theirs"] as const) {
      const content = { ours: ["ours"], base: ["base"], theirs: ["theirs"] }
      content[side] = Array.from({ length: 41 }, (_, i) => `${side} ${i}`)
      const text = [
        "<<<<<<<",
        ...content.ours,
        "|||||||",
        ...content.base,
        "=======",
        ...content.theirs,
        ">>>>>>>",
      ].join("\n")
      const regions = parseRegions(text)
      expect(regions).toHaveLength(1)
      expect(regions[0]![side]).toEqual(content[side].slice(0, 40))
      expect(regions[0]!.truncated).toBe(true)
    }
  })

  test("drops an unclosed region without losing a complete one", () => {
    expect(parseRegions("<<<<<<<\nours\n=======\ntheirs\n>>>>>>>\n<<<<<<<\nunclosed")).toEqual([
      { line: 1, ours: ["ours"], theirs: ["theirs"], truncated: false },
    ])
    expect(parseRegions("plain text\n")).toEqual([])
  })
})

describe("git_repo_read conflicts", () => {
  test("maps a merge's sides, diff3 regions, lockfile and deleted file, with an exact paths filter", async () => {
    const { repo } = await diverge()
    expect((await gitResult(["merge", "topic"], { cwd: repo.dir })).code).not.toBe(0)

    const result = await invoke(repoRead, { method: "conflicts" }, { cwd: repo.dir })
    const conflicts = result.conflicts!
    expect(result.root).toBe(repo.dir)
    expect(result.status).toBeUndefined()
    expect(conflicts.operation).toBe("merge")
    expect(conflicts.count).toBe(3)
    expect(conflicts.sides.ours).toMatchObject({ ref: "HEAD", subject: "main change" })
    expect(conflicts.sides.theirs).toMatchObject({ ref: "MERGE_HEAD", subject: "topic change" })
    const byPath = Object.fromEntries(conflicts.files.map((file) => [file.path, file]))
    expect(byPath["a.txt"]).toMatchObject({
      kind: "both modified",
      lockfile: false,
      region_count: 1,
      regions: [{ line: 2, ours: ["main"], base: ["shared"], theirs: ["topic"], truncated: false }],
      regions_truncated: false,
    })
    expect(byPath["pnpm-lock.yaml"]).toMatchObject({ lockfile: true, regenerate: "pnpm install --lockfile-only" })
    expect(byPath["pnpm-lock.yaml"]!.resolve).toContain(
      "`git checkout --ours -- pnpm-lock.yaml` keeps the current branch",
    )
    expect(byPath["pnpm-lock.yaml"]!.resolve).toContain("run `pnpm install --lockfile-only` where the lockfile lives")
    expect(byPath["gone.txt"]).toMatchObject({ kind: "deleted by us", region_count: 0, regions: [] })
    const only = await invoke(repoRead, { method: "conflicts", paths: ["a.txt"] }, { cwd: repo.dir })
    expect(only.conflicts!.count).toBe(1)
    expect(only.conflicts!.files.map((file) => file.path)).toEqual(["a.txt"])
    for (const paths of [["a"], ["./a.txt"]]) {
      const none = await invoke(repoRead, { method: "conflicts", paths }, { cwd: repo.dir })
      expect(none.conflicts!.count).toBe(0)
    }
    const all = await invoke(repoRead, { method: "conflicts", paths: [] }, { cwd: repo.dir })
    expect(all.conflicts!.count).toBe(3)
  })

  test("explains ours and theirs in a rebase", async () => {
    const { repo } = await diverge()
    await repo.git(["switch", "topic"])
    expect((await gitResult(["rebase", "main"], { cwd: repo.dir })).code).not.toBe(0)
    const { conflicts } = await invoke(repoRead, { method: "conflicts" }, { cwd: repo.dir })
    expect(conflicts!.operation).toBe("rebase")
    expect(conflicts!.sides.ours?.subject).toBe("main change")
    expect(conflicts!.sides.theirs).toMatchObject({ ref: "REBASE_HEAD", subject: "topic change" })
    expect(conflicts!.sides.note).toBe(
      "In a rebase, ours is the branch being rebased onto and theirs is the commit being replayed.",
    )
    expect(conflicts!.files.find((file) => file.lockfile)?.resolve).toContain("keeps the branch being rebased onto")
  })

  test("returns no conflicts outside an operation, including an unborn repository", async () => {
    for (const initialCommit of [true, false]) {
      const repo = await tempRepo({ remote: false, initialCommit })
      repos.push(repo)
      const { conflicts } = await invoke(repoRead, { method: "conflicts" }, { cwd: repo.dir })
      expect(conflicts).toMatchObject({ operation: null, count: 0, files: [], sides: { theirs: null } })
      if (initialCommit) expect(conflicts!.sides.ours).toMatchObject({ ref: "HEAD", subject: "initial" })
      else expect(conflicts!.sides.ours).toBeNull()
      repo.cleanup()
    }
  })

  test("identifies a binary conflicted file", async () => {
    const repo = await tempRepo()
    repos.push(repo)
    await repo.commit("base", { "binary.dat": "base\0\n" })
    await repo.git(["switch", "-c", "topic"])
    await repo.commit("topic change", { "binary.dat": "topic\0\n" })
    await repo.git(["switch", "main"])
    await repo.commit("main change", { "binary.dat": "main\0\n" })
    expect((await gitResult(["merge", "topic"], { cwd: repo.dir })).code).not.toBe(0)
    const { conflicts } = await invoke(repoRead, { method: "conflicts" }, { cwd: repo.dir })
    expect(conflicts!.files).toEqual([
      { path: "binary.dat", kind: "both modified", lockfile: false, binary: true, region_count: 0, regions: [] },
    ])
  })

  test("reads the cherry-picked commit from CHERRY_PICK_HEAD", async () => {
    const { repo, topicSha } = await diverge()
    expect((await gitResult(["cherry-pick", topicSha], { cwd: repo.dir })).code).not.toBe(0)
    const { conflicts } = await invoke(repoRead, { method: "conflicts" }, { cwd: repo.dir })
    expect(conflicts!.operation).toBe("cherry-pick")
    expect(conflicts!.sides.theirs).toEqual({ ref: "CHERRY_PICK_HEAD", sha: topicSha, subject: "topic change" })
  })

  test("caps regions at 20 and reports unreadable files without a binary flag", async () => {
    const { repo } = await diverge()
    expect((await gitResult(["merge", "topic"], { cwd: repo.dir })).code).not.toBe(0)
    repo.write("a.txt", "<<<<<<<\nours\n=======\ntheirs\n>>>>>>>\n".repeat(21))
    const result = await invoke(repoRead, { method: "conflicts", paths: ["a.txt"] }, { cwd: repo.dir })
    expect(result.conflicts!.files[0]).toMatchObject({ region_count: 21, regions_truncated: true })
    expect(result.conflicts!.files[0]!.regions).toHaveLength(20)
    unlinkSync(join(repo.dir, "a.txt"))
    const unreadable = await invoke(repoRead, { method: "conflicts", paths: ["a.txt"] }, { cwd: repo.dir })
    expect(unreadable.conflicts!.files).toEqual([
      { path: "a.txt", kind: "both modified", lockfile: false, region_count: 0, regions: [] },
    ])
  })
})
