import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PIN_PATTERN } from "../core"
import { EXIT_FAILED, EXIT_OK } from "./cli"
import { ADD_ID, DESCRIBED_ID, ENGLISH_WORDS, HANGING_DESCRIBE_ID, READ_ID, cli, json } from "./testing"

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cli-target-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** The titles of the fixtures that are not `Title of <id>`: the id itself. */
const OWN_ID_TITLES = [DESCRIBED_ID, HANGING_DESCRIBE_ID]

/** The answer of `target` without a language for a fixture: its resources, its English title and the English words. */
const answer = (id: string, resources: string[]) => ({
  resources,
  title: OWN_ID_TITLES.includes(id) ? id : `Title of ${id}`,
  words: ENGLISH_WORDS,
})

describe("target", () => {
  test("includes the call's description with hidden characters marked and newlines normalized", async () => {
    const run = await cli(["target", DESCRIBED_ID, "--cwd", "/x"], '{"area":"north"}')
    expect(run.code).toBe(EXIT_OK)
    expect(run.stderr).toBe("")
    expect(json(run)).toEqual({
      ...answer(DESCRIBED_ID, ["north"]),
      description: {
        headline: 'Label the area "north"',
        facts: [{ label: "Area", value: "north" }],
        text: { label: "Body", body: "Body<U+202E> line\nnext" },
      },
      pin: expect.stringMatching(PIN_PATTERN),
    })
  })

  test("still answers resources without a description when describing never settles", async () => {
    const run = await cli(["target", HANGING_DESCRIBE_ID, "--cwd", "/x"], '{"area":"north"}', {
      describeTimeoutMs: 50,
    })
    expect(run.code).toBe(EXIT_OK)
    expect(run.stderr).toBe("")
    expect(json(run)).toEqual(answer(HANGING_DESCRIBE_ID, ["north"]))
  })

  test("omits the description and answers * for invalid arguments", async () => {
    expect(json(await cli(["target", DESCRIBED_ID, "--cwd", "/x"], '{"area":3}'))).toEqual(answer(DESCRIBED_ID, ["*"]))
    expect(json(await cli(["target", DESCRIBED_ID, "--cwd", "/x"], '{"bogus":1}'))).toEqual(answer(DESCRIBED_ID, ["*"]))
  })

  test("is the area argument as given, case kept", async () => {
    const run = await cli(["target", ADD_ID, "--cwd", "/x"], JSON.stringify({ area: "North/Hall" }))
    expect(run.code).toBe(EXIT_OK)
    expect(json(run)).toEqual(answer(ADD_ID, ["North/Hall"]))
  })

  test("is the working directory without an area argument", async () => {
    expect(json(await cli(["target", ADD_ID, "--cwd", "/work/tree"]))).toEqual(answer(ADD_ID, ["/work/tree"]))
  })

  test("lists every target the call writes to, sorted", async () => {
    const stdin = JSON.stringify({ area: "south", parent: "east" })
    expect(json(await cli(["target", ADD_ID, "--cwd", "/x"], stdin))).toEqual(answer(ADD_ID, ["east", "south"]))
  })

  test("is * for a tool that does not say what it writes to", async () => {
    expect(json(await cli(["target", READ_ID, "--cwd", "/x"]))).toEqual(answer(READ_ID, ["*"]))
  })

  test("is * for a target that cannot be told, beside the others", async () => {
    expect(json(await cli(["target", ADD_ID, "--cwd", "/x"], '{"area":"north","parent":""}'))).toEqual(
      answer(ADD_ID, ["north", "*"]),
    )
  })

  test("is * for arguments the schema does not accept", async () => {
    expect(json(await cli(["target", ADD_ID, "--cwd", "/x"], '{"area":3}'))).toEqual(answer(ADD_ID, ["*"]))
    expect(json(await cli(["target", ADD_ID, "--cwd", "/x"], '{"bogus":1}'))).toEqual(answer(ADD_ID, ["*"]))
  })

  test("is * in the install directory without an area, and still names an area given there", async () => {
    const own = tempDir()
    const argv = ["target", ADD_ID, "--cwd", own]
    expect(json(await cli(argv, "", { ownDir: own }))).toEqual(answer(ADD_ID, ["*"]))
    expect(json(await cli(argv, '{"area":"north"}', { ownDir: own }))).toEqual(answer(ADD_ID, ["north"]))
    expect(json(await cli(argv))).toEqual(answer(ADD_ID, [own]))
  })

  test("an unknown tool is invalid_argument", async () => {
    const run = await cli(["target", "demo_nonexistent_read", "--cwd", "/x"])
    expect(run.code).toBe(EXIT_FAILED)
    expect(json(run).error.code).toBe("invalid_argument")
  })

  test("rejects stdin that is not JSON", async () => {
    const run = await cli(["target", ADD_ID, "--cwd", "/x"], "{nope")
    expect(run.code).toBe(EXIT_FAILED)
    expect(json(run).error.code).toBe("invalid_argument")
  })
})
