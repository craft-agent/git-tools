import { afterEach, describe, expect, test } from "bun:test"
import { type TempRepo, tempRepo } from "../../testing/git-repo"
import { ToolError } from "../errors"
import { invoke, type ToolContext } from "../tool"
import { commitVerify } from "./verify"

const CHECK = "test ! -f broken"
const ABORT_DELAY_MS = 500

const repos: TempRepo[] = []

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

async function fixture(options?: Parameters<typeof tempRepo>[0]) {
  const repo = await tempRepo(options)
  repos.push(repo)
  return repo
}

/** A branch off main with three commits; the second one adds `broken`. */
async function branch(files: Record<string, string> = { broken: "x\n" }) {
  const repo = await fixture()
  await repo.git(["checkout", "-b", "feat"])
  await repo.commit("feat: one", { "one.txt": "1\n", "sub/keep.txt": "k\n" })
  await repo.commit("feat: two", files)
  await repo.commit("feat: three", { "three.txt": "3\n" })
  return repo
}

type Args = Parameters<typeof commitVerify.execute>[0]

async function verify(repo: TempRepo, args: Partial<Args> & { command: string }, ctx?: Partial<ToolContext>) {
  return invoke(commitVerify, args, { cwd: repo.dir, ...ctx })
}

async function failure(attempt: Promise<unknown>): Promise<ToolError> {
  const error = await attempt.then(
    () => {
      throw new Error("expected the call to fail")
    },
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(ToolError)
  return error as ToolError
}

async function onlyMainWorktree(repo: TempRepo) {
  const list = await repo.git(["worktree", "list", "--porcelain"])
  expect(list.split("\n").filter((line) => line.startsWith("worktree "))).toEqual([`worktree ${repo.dir}`])
}

describe("git_commit_verify", () => {
  test("passes when every commit passes, oldest first", async () => {
    const repo = await branch({ "two.txt": "2\n" })

    const result = await verify(repo, { command: CHECK })

    expect(result).toMatchObject({ root: repo.dir, total: 3, checked: 3, pass: true, first_failure: null, setup: null })
    expect(result.base).toBe((await repo.git(["rev-parse", "main"])).trim())
    expect(result.results.map((entry) => entry.subject)).toEqual(["feat: one", "feat: two", "feat: three"])
    expect(result.results.every((entry) => entry.ok && entry.output === undefined)).toBe(true)
    await onlyMainWorktree(repo)
  })

  test("stops at the first failure with its output, and keep_going checks them all", async () => {
    const repo = await branch()
    const command = `echo checking; ${CHECK} || { echo found broken >&2; exit 3; }`

    const stopped = await verify(repo, { command })
    expect(stopped).toMatchObject({ total: 3, checked: 2, pass: false, first_failure: stopped.results[1]!.sha })
    expect(stopped.results[1]).toMatchObject({ ok: false, exit_code: 3, subject: "feat: two" })
    expect(stopped.results[1]!.output).toContain("found broken")
    await onlyMainWorktree(repo)

    const all = await verify(repo, { command, keep_going: true })
    expect(all).toMatchObject({ checked: 3, pass: false })
    expect(all.results.map((entry) => entry.ok)).toEqual([true, false, false])
  })

  test("a failing setup checks no commit", async () => {
    const repo = await branch({ "two.txt": "2\n" })

    const result = await verify(repo, { command: CHECK, setup: "echo no network; exit 4" })

    expect(result).toMatchObject({ checked: 0, pass: false, results: [], first_failure: null })
    expect(result.setup).toMatchObject({ ok: false, exit_code: 4 })
    expect(result.setup!.output).toContain("no network")
    await onlyMainWorktree(repo)
  })

  test("runs setup once, then the command, in dir", async () => {
    const repo = await branch({ broken: "x\n", "sub/two.txt": "2\n" })

    const result = await verify(repo, { command: "test ! -f ../broken", dir: "sub", setup: "test ! -f one.txt" })

    expect(result.setup).toEqual({ ok: true })
    expect(result).toMatchObject({ checked: 2, pass: false })

    const inDir = await verify(repo, { command: "test ! -f two.txt", dir: "sub", keep_going: true })
    expect(inDir.results.map((entry) => entry.ok)).toEqual([true, false, false])
  })

  test("refuses a dir that is absolute or escapes the repository", async () => {
    const repo = await branch()

    expect((await failure(verify(repo, { command: CHECK, dir: "../x" }))).code).toBe("invalid_argument")
    expect((await failure(verify(repo, { command: CHECK, dir: repo.dir }))).code).toBe("invalid_argument")
  })

  test("takes an explicit base, and rejects an unknown one or an empty range", async () => {
    const repo = await branch({ "two.txt": "2\n" })

    const result = await verify(repo, { command: CHECK, base: "HEAD~1" })
    expect(result).toMatchObject({ total: 1, checked: 1, pass: true })
    expect(result.base).toBe((await repo.git(["rev-parse", "HEAD~1"])).trim())

    expect((await failure(verify(repo, { command: CHECK, base: "nope" }))).code).toBe("not_found")
    expect((await failure(verify(repo, { command: CHECK, base: "HEAD" }))).code).toBe("invalid_argument")
  })

  test("needs a base when no remote default branch is known", async () => {
    const repo = await fixture({ remote: false })
    await repo.commit("feat: one", { "one.txt": "1\n" })

    expect((await failure(verify(repo, { command: CHECK }))).code).toBe("not_found")
  })

  test("leaves the caller's checkout, index and stashes alone", async () => {
    const repo = await branch()
    repo.write("one.txt", "edited\n")
    repo.write("staged.txt", "s\n")
    await repo.git(["add", "staged.txt"])
    const head = (await repo.git(["rev-parse", "HEAD"])).trim()

    await verify(repo, { command: CHECK })

    expect((await repo.git(["rev-parse", "HEAD"])).trim()).toBe(head)
    expect(await repo.git(["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feat\n")
    expect(await repo.git(["status", "--porcelain"])).toBe(" M one.txt\nA  staged.txt\n")
    expect(await repo.git(["stash", "list"])).toBe("")
    await onlyMainWorktree(repo)
  })

  test("the command sees only the allowlisted environment", async () => {
    const repo = await branch({ "two.txt": "2\n" })
    const before = process.env.GIT_TOOLS_TEST_SECRET
    process.env.GIT_TOOLS_TEST_SECRET = "x"
    try {
      const result = await verify(repo, { command: 'test -z "$GIT_TOOLS_TEST_SECRET"' })
      expect(result.pass).toBe(true)
    } finally {
      if (before === undefined) delete process.env.GIT_TOOLS_TEST_SECRET
      else process.env.GIT_TOOLS_TEST_SECRET = before
    }
  })

  test("a command over its time limit fails as timed out", async () => {
    const repo = await branch()

    const result = await verify(repo, { command: "sleep 5", timeout_sec: 1 })

    expect(result.pass).toBe(false)
    expect(result.results[0]).toMatchObject({ ok: false, timed_out: true })
    await onlyMainWorktree(repo)
  })

  test("a declined confirmation runs nothing", async () => {
    const repo = await branch()
    const asked: string[] = []

    const error = await failure(
      verify(
        repo,
        { command: "touch ran", setup: "touch ran" },
        {
          confirm: async ({ message }) => {
            asked.push(message)
            return false
          },
        },
      ),
    )

    expect(error.code).toBe("declined")
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain("touch ran")
    await onlyMainWorktree(repo)
  })

  test("an aborted call propagates the abort and removes the worktree", async () => {
    const repo = await branch()
    const controller = new AbortController()
    const attempt = verify(repo, { command: "sleep 5" }, { signal: controller.signal })
    setTimeout(() => controller.abort(), ABORT_DELAY_MS)

    expect(((await attempt.catch((error: unknown) => error)) as Error).name).toBe("AbortError")
    await onlyMainWorktree(repo)
  })
})
