import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installFakeGh, type FakeGh } from "../../testing/fake-gh"
import { tempRepo, type TempRepo } from "../../testing/git-repo"
import {
  asGithubRemote,
  failureOf,
  fullSha,
  previewedSend,
  pushFromOtherClone,
  remoteHead,
  sendOf,
} from "../../testing/push-fixtures"
import { conflictingStack, layer, startStoppedRebase } from "../../testing/rebase-fixtures"
import { PREFIXED } from "../../testing/secret-fixtures"
import type { ToolError } from "../errors"
import { PUBLISHED_TEXT_RULES_OPTION } from "./published-text"

const repos: TempRepo[] = []
const dirs: string[] = []
const fakes: FakeGh[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const fake of fakes.splice(0)) fake.restore()
})

async function fixture() {
  const repo = await tempRepo()
  repos.push(repo)
  return repo
}

const TOKEN = PREFIXED["github-pat"]!

/** The send arguments for one branch, read from the repository now. */
async function requestFor(repo: TempRepo, branch: string, expect: string | null) {
  return { remote: "origin", branches: [{ branch, sha: await fullSha(repo, branch), expect }] }
}

/** The option that names a rules file holding `content`. */
function rulesFile(content: string) {
  const dir = mkdtempSync(join(tmpdir(), "push-rules-"))
  dirs.push(dir)
  const path = join(dir, "rules.json")
  writeFileSync(path, content)
  return { [PUBLISHED_TEXT_RULES_OPTION]: path }
}

/** The details of a failed call as `ToolError` carries them. */
const detailsOf = (error: unknown) => (error as ToolError).details as Record<string, any>

describe("git_push_send refusals", () => {
  test("refuses the remote's default branch", async () => {
    const repo = await fixture()
    await repo.commit("main: more", { "more.txt": "1\n" })

    const error = await failureOf(sendOf(repo, await requestFor(repo, "main", await fullSha(repo, "origin/main"))))

    expect(error).toMatchObject({ code: "push_refused" })
    expect(detailsOf(error).refusals).toEqual([
      { rule: "default_branch", branch: "main", message: expect.stringContaining("main is the default branch") },
    ])
    expect(await remoteHead(repo, "main")).toBe(await fullSha(repo, "origin/main"))
  })

  test("refuses while an operation is in progress", async () => {
    const repo = await fixture()
    await conflictingStack(repo)
    await startStoppedRebase(repo)

    const error = await failureOf(sendOf(repo, await requestFor(repo, "l1", null)))

    expect(error).toMatchObject({ code: "push_refused" })
    expect(detailsOf(error).refusals.map((refusal: { rule: string }) => refusal.rule)).toEqual(["operation"])
    expect(await remoteHead(repo, "l1")).toBeNull()
  })

  test("refuses a force push over a remote commit this repository does not have", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    await repo.git(["push", "-u", "origin", "feat"])
    const theirs = await pushFromOtherClone(repo, "feat", "feat: theirs", { "theirs.txt": "t\n" })
    await repo.git(["commit", "--amend", "-m", "feat: amended"])

    const error = await failureOf(sendOf(repo, await requestFor(repo, "feat", theirs)))

    expect(error).toMatchObject({ code: "push_refused" })
    expect(detailsOf(error).refusals.map((refusal: { rule: string }) => refusal.rule)).toEqual([
      "unknown_remote_commit",
    ])
    expect(await remoteHead(repo, "feat")).toBe(theirs)
  })

  test("refuses a force push onto a branch GitHub protects", async () => {
    const repo = await fixture()
    await layer(repo, "feat", 2)
    await repo.git(["push", "-u", "origin", "feat"])
    const remoteTip = await fullSha(repo, "origin/feat")
    await repo.git(["reset", "--hard", "HEAD~1"])
    await repo.commit("feat: replacement", { "other.txt": "x\n" })
    await asGithubRemote(repo)
    const ruleset = { refUpdateRule: null, rules: { nodes: [{ type: "NON_FAST_FORWARD" }] } }
    fakes.push(
      installFakeGh([{ match: "api graphql", stdout: JSON.stringify({ data: { repository: { ref: ruleset } } }) }]),
    )

    const error = await failureOf(sendOf(repo, await requestFor(repo, "feat", remoteTip)))

    expect(error).toMatchObject({ code: "push_refused" })
    expect(detailsOf(error).refusals.map((refusal: { rule: string }) => refusal.rule)).toEqual(["protected"])
    expect(await remoteHead(repo, "feat")).toBe(remoteTip)
  })
})

describe("git_push_send checks", () => {
  test("a secret in the commits stops the push until its fingerprints are accepted", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    await repo.commit("feat: secret", { "secret.ts": `const v = "${TOKEN}"\n` })
    const send = await previewedSend(repo)

    const error = await failureOf(sendOf(repo, send))
    expect(error).toMatchObject({ code: "check_failed" })
    const details = detailsOf(error)
    expect(details.check).toBe("secrets")
    expect(details.accepted).toEqual([])
    expect(details.findings.map((finding: { fingerprint: string }) => finding.fingerprint)).toContain(
      "secret.ts:1:github-pat",
    )
    expect(JSON.stringify(details)).not.toContain(TOKEN)
    expect(await remoteHead(repo, "feat")).toBeNull()

    const fingerprints = details.findings.map((finding: { fingerprint: string }) => finding.fingerprint)
    const result = await sendOf(repo, { ...send, accept_findings: fingerprints })
    expect(result.accepted.sort()).toEqual([...new Set<string>(fingerprints)].sort())
    expect(result.branches[0]!.pushed).toBe(true)
    expect(await remoteHead(repo, "feat")).toBe(await fullSha(repo, "feat"))
  })

  test("a published-text finding stops the push until its fingerprint is accepted", async () => {
    const repo = await fixture()
    await repo.git(["switch", "-c", "wip-login"])
    await repo.commit("WIP: try it", { "try.txt": "1\n" })
    const send = await previewedSend(repo)
    const options = rulesFile(
      JSON.stringify([{ rule: "no-wip", pattern: "wip", flags: "i", hint: "Name the change." }]),
    )

    const error = await failureOf(sendOf(repo, send, { options }))
    expect(error).toMatchObject({ code: "check_failed" })
    const details = detailsOf(error)
    expect(details.check).toBe("published_text")
    expect(details.findings.map((finding: { fingerprint: string }) => finding.fingerprint)).toEqual([
      "no-wip:branch:wip-login",
      `no-wip:commit:${(await fullSha(repo, "wip-login")).slice(0, 12)}`,
    ])
    expect(await remoteHead(repo, "wip-login")).toBeNull()

    const fingerprints = details.findings.map((finding: { fingerprint: string }) => finding.fingerprint)
    const result = await sendOf(repo, { ...send, accept_findings: fingerprints }, { options })
    expect(result.accepted).toEqual(fingerprints)
    expect(await remoteHead(repo, "wip-login")).toBe(await fullSha(repo, "wip-login"))
  })

  test("a failing pre-push hook is a hook check, and nothing is pushed", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    const send = await previewedSend(repo)
    const hook = join(repo.dir, ".git", "hooks", "pre-push")
    writeFileSync(hook, "#!/bin/sh\necho 'hook says no' >&2\nexit 1\n")
    chmodSync(hook, 0o755)

    const error = await failureOf(sendOf(repo, send))

    expect(error).toMatchObject({ code: "check_failed" })
    expect(detailsOf(error)).toMatchObject({ check: "hook", hooks: ["pre-push"], exit_code: 1 })
    expect(detailsOf(error).output).toContain("hook says no")
    expect(await remoteHead(repo, "feat")).toBeNull()
  })

  test("a pre-push hook that passes lets the push through", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    const send = await previewedSend(repo)
    const hook = join(repo.dir, ".git", "hooks", "pre-push")
    writeFileSync(hook, "#!/bin/sh\nexit 0\n")
    chmodSync(hook, 0o755)

    expect((await sendOf(repo, send)).branches[0]!.pushed).toBe(true)
  })
})

describe("git_push_send arguments", () => {
  const sha = "a".repeat(40)

  const withBranches = (branches: { branch: string; sha: string; expect: string | null }[], remote = "origin") => ({
    remote,
    branches,
  })

  test("rejects names that are options or blank, and commit ids that are not full", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    const tip = await fullSha(repo, "feat")
    const bad = [
      withBranches([{ branch: "-x", sha: tip, expect: null }]),
      withBranches([{ branch: " ", sha: tip, expect: null }]),
      withBranches([{ branch: "feat", sha: tip, expect: null }], "-x"),
      withBranches([{ branch: "feat", sha: tip, expect: null }], ""),
      withBranches([{ branch: "feat", sha: tip.slice(0, 12), expect: null }]),
      withBranches([{ branch: "feat", sha: tip.toUpperCase(), expect: null }]),
      withBranches([{ branch: "feat", sha: tip, expect: sha.slice(0, 12) }]),
      withBranches([
        { branch: "feat", sha: tip, expect: null },
        { branch: "feat", sha: tip, expect: null },
      ]),
    ]
    for (const request of bad) {
      expect(await failureOf(sendOf(repo, request)), JSON.stringify(request)).toMatchObject({
        code: "invalid_argument",
      })
    }
    expect(await remoteHead(repo, "feat")).toBeNull()
  })

  test("a branch that does not exist is not found", async () => {
    const repo = await fixture()

    const error = await failureOf(sendOf(repo, withBranches([{ branch: "nowhere", sha, expect: null }])))

    expect(error).toMatchObject({ code: "not_found" })
  })

  test("a remote this repository does not have is not found", async () => {
    const repo = await fixture()
    await layer(repo, "feat")

    const error = await failureOf(sendOf(repo, { ...(await requestFor(repo, "feat", null)), remote: "elsewhere" }))

    expect(error).toMatchObject({ code: "not_found" })
  })
})

describe("git_push_send confirmation", () => {
  test("pushes nothing when the person declines, and asks with what is pushed", async () => {
    const repo = await fixture()
    await layer(repo, "feat")
    const asked: { tool: string; message: string }[] = []
    const confirm = async (request: { tool: string; message: string }) => {
      asked.push(request)
      return false
    }

    const error = await failureOf(sendOf(repo, await previewedSend(repo), { confirm }))

    expect(error).toMatchObject({ code: "declined" })
    expect(asked).toEqual([{ tool: "git_push_send", message: "Push feat (new) to origin." }])
    expect(await remoteHead(repo, "feat")).toBeNull()
  })

  test("pushes when the person accepts", async () => {
    const repo = await fixture()
    await layer(repo, "feat")

    const result = await sendOf(repo, await previewedSend(repo), { confirm: async () => true })

    expect(result.branches[0]!.pushed).toBe(true)
  })
})
