import { describe, expect, test } from "bun:test"
import { DESCRIPTION_LIMIT } from "../server-json.mjs"
import { EXIT_USAGE, SetupError } from "./errors.mjs"
import { parseArgs, parseOrigin, resolveOptions } from "./options.mjs"

const ORIGIN = { owner: "Acme", repo: "widget-tools" }
const REQUIRED = { prefix: "widget", description: "Widget tools for agents." }

function usageMessage(run) {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(SetupError)
    expect(error.exitCode).toBe(EXIT_USAGE)
    return error.message
  }
  throw new Error("expected a usage error")
}

describe("parseOrigin", () => {
  test.each([
    ["https://github.com/o/r", { owner: "o", repo: "r" }],
    ["https://github.com/o/r.git", { owner: "o", repo: "r" }],
    ["https://token@github.com/o/r.git\n", { owner: "o", repo: "r" }],
    ["git@github.com:o/r", { owner: "o", repo: "r" }],
    ["git@github.com:o/r.git", { owner: "o", repo: "r" }],
    ["ssh://git@github.com/o/r.git", { owner: "o", repo: "r" }],
    ["ssh://git@github.com/o/r", { owner: "o", repo: "r" }],
    ["https://github.com/o/r.js.git", { owner: "o", repo: "r.js" }],
  ])("reads %j", (url, expected) => {
    expect(parseOrigin(url)).toEqual(expected)
  })

  test.each([
    "https://gitlab.com/o/r.git",
    "git@gitlab.com:o/r.git",
    "https://github.com/o",
    "https://github.com/o/r/extra",
    "/srv/git/r.git",
  ])("rejects %j", (url) => {
    expect(parseOrigin(url)).toBeNull()
  })
})

describe("parseArgs", () => {
  test("takes `--flag value` and `--flag=value`, and the standalone flags", () => {
    expect(
      parseArgs([
        "--prefix",
        "git",
        "--description=A = B",
        "--author-url",
        "https://example.test",
        "--publisher=Pub",
        "--keep-example",
        "--dry-run",
        "--yes",
      ]),
    ).toEqual({
      prefix: "git",
      description: "A = B",
      authorUrl: "https://example.test",
      publisher: "Pub",
      keepExample: true,
      dryRun: true,
      yes: true,
    })
  })

  test("skips the bare `--` that pnpm forwards", () => {
    expect(parseArgs(["--", "--prefix", "git"])).toEqual({ prefix: "git" })
  })

  test("refuses an unknown option, a stray argument, a missing value and a value on a flag", () => {
    expect(usageMessage(() => parseArgs(["--bogus"]))).toContain("--bogus")
    expect(usageMessage(() => parseArgs(["--constructor"]))).toContain("--constructor")
    expect(usageMessage(() => parseArgs(["widget"]))).toContain("widget")
    expect(usageMessage(() => parseArgs(["--prefix"]))).toContain("--prefix")
    expect(usageMessage(() => parseArgs(["--prefix", "--yes"]))).toContain("--prefix")
    expect(usageMessage(() => parseArgs(["--yes=1"]))).toContain("--yes")
  })
})

describe("resolveOptions", () => {
  test("fills the name, owner, scope, marketplace, author and publisher from the origin", () => {
    expect(resolveOptions(REQUIRED, ORIGIN)).toMatchObject({
      name: "widget-tools",
      owner: "Acme",
      repo: "widget-tools",
      scope: "@acme",
      marketplace: "Acme",
      author: "Acme",
      authorUrl: "https://github.com/Acme",
      publisher: "Acme",
      keepExample: false,
    })
  })

  test("lets the options win, but the URLs keep the origin's repository name", () => {
    const options = resolveOptions(
      {
        ...REQUIRED,
        name: "widgets",
        owner: "other",
        scope: "@o",
        marketplace: "m",
        author: "A B",
        authorUrl: "https://example.test/author",
        publisher: "P Corp",
      },
      ORIGIN,
    )
    expect(options).toMatchObject({ name: "widgets", repo: "widget-tools", owner: "other", scope: "@o" })
    expect(options).toMatchObject({
      marketplace: "m",
      author: "A B",
      authorUrl: "https://example.test/author",
      publisher: "P Corp",
    })
  })

  test("defaults publisher to the author when specified", () => {
    const options = resolveOptions({ ...REQUIRED, author: "A B" }, ORIGIN)
    expect(options).toMatchObject({ author: "A B", authorUrl: "https://github.com/Acme", publisher: "A B" })
  })

  test("needs --name and --owner when there is no GitHub origin, and names what is missing", () => {
    expect(resolveOptions({ ...REQUIRED, name: "widgets", owner: "acme" }, null)).toMatchObject({ repo: "widgets" })
    const message = usageMessage(() => resolveOptions({ prefix: "widget" }, null))
    expect(message).toContain("--description")
    expect(message).toContain("--name")
    expect(message).toContain("--owner")
    expect(message).not.toContain("--prefix,")
  })

  test.each([
    [{ prefix: "Widget" }, "--prefix"],
    [{ prefix: "wid_get" }, "--prefix"],
    [{ name: "Widget" }, "--name"],
    [{ name: "widget--tools" }, "--name"],
    [{ name: "1widget" }, "--name"],
    [{ owner: "-acme" }, "--owner"],
    [{ scope: "acme" }, "--scope"],
    [{ scope: "@Acme" }, "--scope"],
    [{ marketplace: "a b" }, "--marketplace"],
    [{ description: "two\nlines" }, "--description"],
    [{ description: "x".repeat(DESCRIPTION_LIMIT + 1) }, "--description"],
    [{ author: "two\nlines" }, "--author"],
    [{ authorUrl: "http://example.com" }, "--author-url"],
    [{ authorUrl: "https://example.com/a\nb" }, "--author-url"],
    [{ authorUrl: "https://" }, "--author-url"],
    [{ authorUrl: "ftp://example.com" }, "--author-url"],
    [{ publisher: "two\nlines" }, "--publisher"],
    [{ publisher: "" }, "--publisher"],
    [{ publisher: "   " }, "--publisher"],
  ])("refuses %j", (invalid, option) => {
    expect(usageMessage(() => resolveOptions({ ...REQUIRED, ...invalid }, ORIGIN))).toContain(option)
  })

  test("accepts a description of exactly the registry's limit", () => {
    const description = "x".repeat(DESCRIPTION_LIMIT)
    expect(resolveOptions({ ...REQUIRED, description }, ORIGIN).description).toBe(description)
  })
})
