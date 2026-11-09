import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installFakeGh, type FakeGh, type GhRule } from "../testing/fake-gh"
import { ghEnv, ghGraphql, githubRepo } from "./gh"

const OPTIONS = { cwd: tmpdir(), timeoutMs: 5_000 }

const installed: FakeGh[] = []
const cleanups: (() => void)[] = []

afterEach(() => {
  for (const fake of installed.splice(0)) fake.restore()
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function fakeGh(rules: GhRule[]): FakeGh {
  const fake = installFakeGh(rules)
  installed.push(fake)
  return fake
}

describe("githubRepo", () => {
  test.each([
    "https://github.com/o/r",
    "https://github.com/o/r.git",
    "https://user@github.com/o/r.git",
    "https://github.com/o/r/",
    "git@github.com:o/r.git",
    "git@github.com:o/r",
    "ssh://git@github.com/o/r.git",
    "ssh://git@github.com:22/o/r.git",
    "  https://GitHub.com/o/r.git\n",
  ])("reads the repository from %j", (url) => {
    expect(githubRepo(url)).toEqual({ owner: "o", name: "r" })
  })

  test("keeps dots in a repository name", () => {
    expect(githubRepo("git@github.com:o/r.js.git")).toEqual({ owner: "o", name: "r.js" })
  })

  test.each([
    "https://example.com/github.com/o/r.git",
    "https://github.com.example.com/o/r.git",
    "git@gitlab.com:o/r.git",
    "https://github.com/o",
    "https://github.com/o/r/extra",
    "/srv/git/github.com/o/r.git",
    "",
  ])("is null for %j", (url) => {
    expect(githubRepo(url)).toBeNull()
  })
})

describe("ghEnv", () => {
  test("passes the variables gh needs, never a stray one, and forces the quiet settings", () => {
    const names = ["GH_TOKEN", "GH_REPO", "CRAFT_TEST_SECRET", "GH_PAGER", "NO_COLOR"]
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]))
    process.env.GH_TOKEN = "token-value"
    process.env.GH_REPO = "other/repo"
    process.env.CRAFT_TEST_SECRET = "secret"
    process.env.GH_PAGER = "less"
    process.env.NO_COLOR = "0"
    try {
      const env = ghEnv()
      expect(env.GH_TOKEN).toBe("token-value")
      expect(env).not.toHaveProperty("GH_REPO")
      expect(env).not.toHaveProperty("CRAFT_TEST_SECRET")
      expect(env).toMatchObject({
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
        GH_SPINNER_DISABLED: "1",
        NO_COLOR: "1",
        CLICOLOR: "0",
        GH_PAGER: "cat",
      })
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
})

describe("ghGraphql", () => {
  test("sends the query and each variable as -f arguments and returns the data", async () => {
    const fake = fakeGh([{ match: "^api graphql", stdout: JSON.stringify({ data: { repository: { id: "1" } } }) }])
    const data = await ghGraphql<{ repository: { id: string } }>("query { x }", { owner: "o", name: "r" }, OPTIONS)
    expect(data).toEqual({ repository: { id: "1" } })
    expect(fake.calls()).toEqual([
      ["api", "graphql", "--hostname", "github.com", "-f", "query=query { x }", "-f", "owner=o", "-f", "name=r"],
    ])
  })

  test("throws upstream_error with the messages of a GraphQL errors reply", async () => {
    fakeGh([
      {
        match: "api graphql",
        stdout: JSON.stringify({ data: null, errors: [{ message: "Something broke" }, { message: "again" }] }),
        stderr: "gh: Something broke",
        code: 1,
      },
    ])
    await expect(ghGraphql("query { x }", {}, OPTIONS)).rejects.toMatchObject({
      code: "upstream_error",
      message: expect.stringContaining("Something broke; again"),
    })
  })

  test("throws unauthenticated when gh is not logged in", async () => {
    fakeGh([{ match: "api graphql", stderr: "To get started with GitHub CLI, please run:  gh auth login", code: 4 }])
    await expect(ghGraphql("query { x }", {}, OPTIONS)).rejects.toMatchObject({
      code: "unauthenticated",
      message: expect.stringContaining("gh auth login"),
    })
  })

  test("throws not_found for a GraphQL error that names no such repository", async () => {
    fakeGh([
      {
        match: "api graphql",
        stdout: JSON.stringify({
          data: null,
          errors: [{ message: "Could not resolve to a Repository with the name 'o/r'." }],
        }),
        code: 1,
      },
    ])
    await expect(ghGraphql("query { x }", {}, OPTIONS)).rejects.toMatchObject({ code: "not_found" })
  })

  test("throws not_found for an HTTP 404 and trims a long message", async () => {
    fakeGh([{ match: "api graphql", stderr: `gh: Not Found (HTTP 404) ${"x".repeat(2000)}`, code: 1 }])
    const error = await ghGraphql("query { x }", {}, OPTIONS).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: "not_found" })
    expect((error as Error).message.length).toBeLessThan(600)
  })

  test("throws upstream_error when gh is not installed", async () => {
    const empty = mkdtempSync(join(tmpdir(), "no-gh-"))
    const path = process.env.PATH
    process.env.PATH = empty
    cleanups.push(() => {
      if (path === undefined) delete process.env.PATH
      else process.env.PATH = path
      rmSync(empty, { recursive: true, force: true })
    })
    await expect(ghGraphql("query { x }", {}, OPTIONS)).rejects.toMatchObject({
      code: "upstream_error",
      message: expect.stringContaining("the GitHub CLI (gh) is not installed"),
    })
  })

  test("throws upstream_error when the call outlasts its time limit", async () => {
    fakeGh([{ match: "api graphql", stdout: "{}", delayMs: 2_000 }])
    await expect(ghGraphql("query { x }", {}, { ...OPTIONS, timeoutMs: 200 })).rejects.toMatchObject({
      code: "upstream_error",
      message: expect.stringContaining("timed out"),
    })
  })

  test("rejects with an AbortError when the signal aborts", async () => {
    fakeGh([{ match: "api graphql", stdout: "{}", delayMs: 2_000 }])
    const controller = new AbortController()
    const pending = ghGraphql("query { x }", {}, { ...OPTIONS, signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })
})
