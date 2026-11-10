import { afterEach, describe, expect, test } from "bun:test"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import type { ToolError } from "../errors"
import { failureOf, fullSha, previewedSend, pushFromOtherClone, remoteHead, sendOf } from "../../testing/push-fixtures"
import { layer } from "../../testing/rebase-fixtures"
import { runPush } from "./send-run"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

async function fixture() {
  const repo = await tempRepo()
  repos.push(repo)
  return repo
}

describe("git_push_send stale", () => {
  test("a local branch that moved after the preview is stale, and nothing is pushed", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    const send = await previewedSend(repo)
    const previewed = send.branches[0]!.sha
    await repo.commit("feat: later", { "later.txt": "1\n" })

    const error = await failureOf(sendOf(repo, send))

    expect(error).toMatchObject({ code: "stale" })
    expect((error as Error).message).toBe(
      `feat is at ${(await fullSha(repo, "feat")).slice(0, 12)} now, not ${previewed.slice(0, 12)}; preview again.`,
    )
    expect(await remoteHead(repo, "feat")).toBeNull()
  })

  test("a remote branch another clone moved after the preview is stale from the live read", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    await repo.git(["push", "-u", "origin", "feat"])
    await repo.commit("feat: more", { "more.txt": "1\n" })
    const send = await previewedSend(repo)
    const theirs = await pushFromOtherClone(repo, "feat", "feat: theirs", { "theirs.txt": "t\n" })

    const error = await failureOf(sendOf(repo, send))

    expect(error).toMatchObject({ code: "stale" })
    expect((error as Error).message).toContain(
      `origin/feat moved since the preview: it is at ${theirs.slice(0, 12)} now`,
    )
    expect(await remoteHead(repo, "feat")).toBe(theirs)
  })

  test("a branch someone created after the preview is stale", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    const send = await previewedSend(repo)
    await repo.git(["push", "origin", "main:feat"])

    const error = await failureOf(sendOf(repo, send))

    expect(error).toMatchObject({ code: "stale" })
    expect((error as Error).message).toContain("origin/feat moved since the preview: it is at")
    expect(await remoteHead(repo, "feat")).toBe(await fullSha(repo, "main"))
  })

  test("a branch the remote already holds has nothing to push and is stale", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    const tip = await fullSha(repo, "feat")
    await repo.git(["push", "origin", "feat"])

    const error = await failureOf(
      sendOf(repo, { remote: "origin", branches: [{ branch: "feat", sha: tip, expect: tip }] }),
    )

    expect(error).toMatchObject({ code: "stale" })
    expect((error as Error).message).toContain("already holds")
  })

  test("a lease the remote moved under at push time is stale, and nothing is pushed", async () => {
    const repo = await fixture()
    await layer(repo, "l1")
    await repo.git(["push", "-u", "origin", "l1"])
    await repo.commit("l1: more", { "more.txt": "1\n" })
    await layer(repo, "l2")
    const send = await previewedSend(repo, { branches: ["l1", "l2"] })
    expect(send.branches.map(({ branch, expect }) => [branch, expect === null])).toEqual([
      ["l1", false],
      ["l2", true],
    ])
    const theirs = await pushFromOtherClone(repo, "l1", "l1: theirs", { "theirs.txt": "t\n" })

    const error = await failureOf(runPush(repo.dir, send))

    expect(error).toMatchObject({ code: "stale" })
    expect((error as ToolError).details).toEqual({
      rejected: [
        { ref: "refs/heads/l1", summary: expect.stringContaining("stale info") },
        { ref: "refs/heads/l2", summary: expect.stringContaining("atomic push failed") },
      ],
    })
    expect(await remoteHead(repo, "l1")).toBe(theirs)
    expect(await remoteHead(repo, "l2")).toBeNull()
  })

  test("a branch created under the push by someone else fails its lease", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    const send = await previewedSend(repo)
    await repo.git(["push", "origin", "main:feat"])

    const error = await failureOf(runPush(repo.dir, send))

    expect(error).toMatchObject({ code: "stale" })
    expect(await remoteHead(repo, "feat")).toBe(await fullSha(repo, "main"))
  })
})
