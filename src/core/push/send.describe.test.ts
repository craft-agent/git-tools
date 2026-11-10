import { afterEach, describe, expect, test } from "bun:test"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import { fullSha, previewedSend, pushFromOtherClone } from "../../testing/push-fixtures"
import { layer } from "../../testing/rebase-fixtures"
import { callDescription } from "../describe"
import { pushSend } from "./send"

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

async function fixture() {
  const repo = await tempRepo()
  repos.push(repo)
  return repo
}

const describeSend = (repo: TempRepo, args: Parameters<typeof pushSend.execute>[0]) =>
  callDescription(pushSend, args, { cwd: repo.dir })

const commits = (count: number) => ({
  label: "Commits",
  value: { text: count === 1 ? "{commits} commit" : "{commits} commits", values: { commits: count } },
})

/** `feat` with two commits pushed, then its last commit replaced, so pushing it again needs a force. */
async function forcePushNeeded(repo: TempRepo): Promise<string> {
  await layer(repo, "feat", 2)
  await repo.git(["push", "-u", "origin", "feat"])
  const remoteTip = await fullSha(repo, "origin/feat")
  await repo.git(["reset", "--hard", "HEAD~1"])
  await repo.commit("feat: replacement", { "other.txt": "x\n" })
  return remoteTip
}

describe("git_push_send description", () => {
  test("describes a new branch: the headline, its kind and the commits that leave, with no pins", async () => {
    const repo = await fixture()
    await layer(repo, "feat", 2)

    const description = await describeSend(repo, await previewedSend(repo))

    expect(description!.headline).toEqual({
      text: "About to push {branch} to {remote}",
      values: { branch: "feat", remote: "origin" },
    })
    expect(description!.facts).toEqual([
      { label: "Branches", value: { text: "{create} (new)", values: { create: "feat" } } },
      commits(2),
    ])
    expect(description!.pins).toBeUndefined()
  })

  test("a force push comes first, and accepted findings come last, once each", async () => {
    const repo = await fixture()
    const expectTip = await forcePushNeeded(repo)
    const request = {
      remote: "origin",
      branches: [{ branch: "feat", sha: await fullSha(repo, "feat"), expect: expectTip }],
    }

    const description = await describeSend(repo, { ...request, accept_findings: ["b:1:r", "a:1:r", "b:1:r"] })

    expect(description!.facts).toEqual([
      { label: "Push", value: { text: "needs a force push" } },
      { label: "Branches", value: { text: "{force} (force)", values: { force: "feat" } } },
      commits(1),
      { label: "Accepted findings", value: "b:1:r, a:1:r" },
    ])
  })

  test("a remote commit this repository does not have is a force push", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    await repo.git(["push", "-u", "origin", "feat"])
    const theirs = await pushFromOtherClone(repo, "feat", "feat: theirs", { "theirs.txt": "t\n" })
    await repo.commit("feat: more", { "more.txt": "1\n" })
    const request = {
      remote: "origin",
      branches: [{ branch: "feat", sha: await fullSha(repo, "feat"), expect: theirs }],
    }

    const description = await describeSend(repo, request)

    expect(description!.facts.map((fact) => fact.label)).toEqual(["Push", "Branches", "Commits"])
  })

  test("a line of layers names the count and groups the branches by kind", async () => {
    const repo = await fixture()
    await layer(repo, "l1")
    await repo.git(["push", "-u", "origin", "l1"])
    await repo.commit("l1: more", { "more.txt": "1\n" })
    await layer(repo, "l2")
    await layer(repo, "l3")

    const description = await describeSend(repo, await previewedSend(repo))

    expect(description!.headline).toEqual({
      text: "About to push {count} branches to {remote}",
      values: { count: "3", remote: "origin" },
    })
    expect(description!.facts).toEqual([
      {
        label: "Branches",
        value: {
          text: "{create} (new); {fast_forward} (fast forward)",
          values: { create: "l2, l3", fast_forward: "l1" },
        },
      },
      commits(3),
    ])
  })

  test("gives no description when a local check fails", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    const send = await previewedSend(repo)
    const [branch] = send.branches
    expect(await describeSend(repo, send)).toBeDefined()

    const withBranch = (changes: object) => ({ ...send, branches: [{ ...branch!, ...changes }] })
    expect(await describeSend(repo, withBranch({ sha: branch!.sha.slice(0, 12) }))).toBeUndefined()
    expect(await describeSend(repo, withBranch({ branch: "-feat" }))).toBeUndefined()
    expect(await describeSend(repo, withBranch({ branch: "nowhere" }))).toBeUndefined()
    expect(await describeSend(repo, { ...send, branches: [branch!, branch!] })).toBeUndefined()

    await repo.commit("feat: later", { "later.txt": "1\n" })
    expect(await describeSend(repo, send)).toBeUndefined()
  })

  test("reads no remote and changes nothing", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    await repo.git(["push", "-u", "origin", "feat"])
    await repo.commit("feat: more", { "more.txt": "1\n" })
    const send = await previewedSend(repo)
    const trackingBefore = await fullSha(repo, "origin/feat")
    await pushFromOtherClone(repo, "feat", "feat: theirs", { "theirs.txt": "t\n" })
    await repo.git(["remote", "set-url", "origin", `${repo.dir}/no-such-remote.git`])
    const state = async () => [
      await repo.git(["for-each-ref", "--format=%(refname) %(objectname)"]),
      await repo.git(["reflog", "--all"]),
      await repo.git(["status", "--porcelain"]),
      await repo.git(["rev-parse", "HEAD"]),
    ]
    const before = await state()

    const description = await describeSend(repo, send)

    expect(description).toBeDefined()
    expect(await state()).toEqual(before)
    expect(await fullSha(repo, "origin/feat")).toBe(trackingBefore)
  })
})
