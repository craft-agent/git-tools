import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isToolError } from "../errors"
import { PUBLISHED_TEXT_RULES_OPTION, loadPublishedTextRules } from "./published-text"

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "published-text-"))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Writes `content` (JSON text, or a value to stringify) to a new file and returns its path. */
async function rulesFile(content: unknown, name = `rules-${Math.random().toString(36).slice(2)}.json`) {
  const path = join(dir, name)
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content))
  return path
}

const load = (path: string | undefined) =>
  loadPublishedTextRules(path === undefined ? {} : { [PUBLISHED_TEXT_RULES_OPTION]: path })

/** The message of the `invalid_argument` the load fails with. */
async function refusal(path: string): Promise<string> {
  try {
    await load(path)
  } catch (error) {
    expect(isToolError(error) && error.code).toBe("invalid_argument")
    return (error as Error).message
  }
  throw new Error("expected the rules to be refused")
}

const ENTRY = { rule: "no-wip", pattern: "wip", hint: "Name the change instead." }

describe("loadPublishedTextRules", () => {
  test("no option gives no rules", async () => {
    expect(await loadPublishedTextRules(undefined)).toEqual([])
    expect(await load(undefined)).toEqual([])
    expect(await loadPublishedTextRules({ [PUBLISHED_TEXT_RULES_OPTION]: "  " })).toEqual([])
  })

  test("a valid file loads its rules with compiled patterns", async () => {
    const path = await rulesFile([ENTRY, { rule: "no-todo", pattern: "^todo\\b", flags: "im", hint: "Finish it." }])
    const rules = await load(path)
    expect(rules.map((rule) => rule.rule)).toEqual(["no-wip", "no-todo"])
    expect(rules[0]!.pattern).toEqual(/wip/)
    expect(rules[1]!.pattern.flags).toBe("im")
    expect(rules[1]!.hint).toBe("Finish it.")
  })

  test("an absolute path loads rules", async () => {
    const path = await rulesFile([ENTRY], "rules.json")
    expect(await load(path)).toEqual([{ rule: ENTRY.rule, pattern: /wip/, hint: ENTRY.hint }])
  })

  test("a directory is refused as not a file", async () => {
    const message = await refusal(dir)
    expect(message).toContain(dir)
    expect(message).toContain("it is not a file")
  })

  test("an empty array is no rules", async () => {
    expect(await load(await rulesFile([]))).toEqual([])
  })

  test("the file is read again on every call", async () => {
    const path = await rulesFile([ENTRY], "edited.json")
    expect(await load(path)).toHaveLength(1)
    await rulesFile([ENTRY, { ...ENTRY, rule: "other" }], "edited.json")
    expect(await load(path)).toHaveLength(2)
  })

  test("a relative path is refused", async () => {
    const message = await refusal("rules.json")
    expect(message).toContain(PUBLISHED_TEXT_RULES_OPTION)
    expect(message).toContain("rules.json")
    expect(message).toContain("the value must be an absolute path")
  })

  test("a missing file, a directory and an oversized file are refused, naming the path", async () => {
    const missing = join(dir, "missing.json")
    expect(await refusal(missing)).toContain(missing)
    expect(await refusal(dir)).toContain(dir)
    const big = await rulesFile(JSON.stringify([{ ...ENTRY, hint: "x".repeat(70 * 1024) }]))
    const message = await refusal(big)
    expect(message).toContain(big)
    expect(message).toContain("64 KiB")
  })

  test("a file that is not JSON, or not an array, is refused, naming the path", async () => {
    const broken = await rulesFile("[{")
    expect(await refusal(broken)).toContain(broken)
    const object = await rulesFile({ rule: "no-wip" })
    expect(await refusal(object)).toContain("array")
    expect(await refusal(object)).toContain(object)
  })

  test("more than 100 rules are refused", async () => {
    const many = Array.from({ length: 101 }, (_, index) => ({ ...ENTRY, rule: `rule-${index}` }))
    expect(await refusal(await rulesFile(many))).toContain("100")
    const limit = await rulesFile(many.slice(0, 100))
    expect(await load(limit)).toHaveLength(100)
  })
})

describe("loadPublishedTextRules entries", () => {
  const entryRefusal = async (entries: unknown[]) => refusal(await rulesFile(entries))

  test.each([
    ["an unknown key", { ...ENTRY, extra: 1 }, 'unknown key "extra"'],
    ["a missing hint", { rule: "no-wip", pattern: "wip" }, "hint"],
    ["a blank pattern", { ...ENTRY, pattern: "" }, "pattern"],
    ["a pattern over 500 characters", { ...ENTRY, pattern: "a".repeat(501) }, "pattern"],
    ["a hint over 300 characters", { ...ENTRY, hint: "a".repeat(301) }, "hint"],
    ["an uppercase rule name", { ...ENTRY, rule: "No-Wip" }, "rule"],
    ["a rule name that starts with a digit", { ...ENTRY, rule: "1wip" }, "rule"],
    ["a rule name over 40 characters", { ...ENTRY, rule: "a".repeat(41) }, "rule"],
    ["the g flag", { ...ENTRY, flags: "g" }, "flags"],
    ["the y flag", { ...ENTRY, flags: "iy" }, "flags"],
    ["an entry that is not an object", "wip", "entry 0"],
  ])("%s is refused, naming the entry and the path", async (_name, entry, expected) => {
    const path = await rulesFile([entry])
    const message = await refusal(path)
    expect(message).toContain("entry 0")
    expect(message).toContain(expected)
    expect(message).toContain(path)
  })

  test("a pattern that does not compile is refused, naming the entry", async () => {
    const message = await entryRefusal([ENTRY, { ...ENTRY, rule: "broken", pattern: "(" }])
    expect(message).toContain("entry 1")
    expect(message).toContain("broken")
    expect(message).toContain("does not compile")
  })

  test("repeated flags do not compile", async () => {
    expect(await entryRefusal([{ ...ENTRY, flags: "ii" }])).toContain("does not compile")
  })

  test("a repeated rule name is refused, naming both entries", async () => {
    const message = await entryRefusal([ENTRY, { ...ENTRY, pattern: "other" }])
    expect(message).toContain("entry 1")
    expect(message).toContain("entry 0")
    expect(message).toContain('"no-wip"')
  })
})
