import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { callDescription } from "../describe"
import { invoke } from "../tool"
import { commitRead } from "./read"
import { commitStage } from "./stage"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

/** A repository with `a.txt` and `b.txt` committed and both changed in one hunk, the listing's digest and its hunk ids. */
async function twoFiles() {
  const repo = await tempRepo()
  repos.push(repo)
  await repo.commit("add files", { "a.txt": "a\nb\n", "b.txt": "x\n" })
  repo.write("a.txt", "a\nchanged\nextra\n")
  repo.write("b.txt", "y\n")
  const listing = (await invoke(commitRead, { method: "hunks" }, { cwd: repo.dir })).hunks!
  return { repo, digest: listing.digest }
}

const describeStage = (repo: TempRepo, args: { digest: string; hunks: number[] }) =>
  callDescription(commitStage, args, { cwd: repo.dir })

describe("git_commit_stage description", () => {
  test("describes a one-file selection with its path, counts and the patch", async () => {
    const { repo, digest } = await twoFiles()
    const description = await describeStage(repo, { digest, hunks: [1] })
    expect(description!.headline).toEqual({ text: "About to stage hunks of {file}", values: { file: "a.txt" } })
    expect(description!.facts).toEqual([
      { label: "Hunks", value: { text: "{hunks} of {total}", values: { hunks: 1, total: 2 } } },
      { label: "Lines", value: { text: "{added} added, {removed} removed", values: { added: 2, removed: 1 } } },
    ])
    expect(description!.text!.label).toBe("Hunks to stage")
    expect(description!.text!.body.startsWith("diff --git")).toBe(true)
    expect(description!.text!.body).toContain("+changed")
    expect(description!.pins).toBeUndefined()
  })

  test("leaves a selection of two files to the intent and counts them as a fact", async () => {
    const { repo, digest } = await twoFiles()
    const description = await describeStage(repo, { digest, hunks: [2, 1] })
    expect(description!.headline).toBeUndefined()
    expect(description!.facts.slice(0, 2)).toEqual([
      { label: "Files", value: { text: "{files} files", values: { files: 2 } } },
      { label: "Hunks", value: { text: "{hunks} of {total}", values: { hunks: 2, total: 2 } } },
    ])
  })

  test("gives no description for a stale digest, an unknown id or a binary hunk", async () => {
    const { repo, digest } = await twoFiles()
    expect(await describeStage(repo, { digest: "0000000000000000", hunks: [1] })).toBeUndefined()
    expect(await describeStage(repo, { digest, hunks: [3] })).toBeUndefined()

    writeFileSync(join(repo.dir, "img.bin"), Buffer.from([0, 1, 2, 3]))
    await repo.git(["add", "img.bin"])
    await repo.git(["commit", "-m", "add image"])
    writeFileSync(join(repo.dir, "img.bin"), Buffer.from([0, 9, 8, 7, 0]))
    const listing = (await invoke(commitRead, { method: "hunks" }, { cwd: repo.dir })).hunks!
    const binary = listing.hunks.find((hunk) => hunk.binary)!
    expect(await describeStage(repo, { digest: listing.digest, hunks: [binary.id] })).toBeUndefined()
  })

  test("gives an equal description for the same state", async () => {
    const { repo, digest } = await twoFiles()
    expect(await describeStage(repo, { digest, hunks: [1, 2] })).toEqual(
      await describeStage(repo, { digest, hunks: [1, 2] }),
    )
  })

  test("describes without staging anything", async () => {
    const { repo, digest } = await twoFiles()
    await describeStage(repo, { digest, hunks: [1] })
    expect(await repo.git(["diff", "--cached", "--name-only"])).toBe("")
  })
})
