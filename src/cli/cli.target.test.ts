import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EXIT_FAILED, EXIT_OK } from "./cli"
import { ADD_ID, READ_ID, cli, json } from "./testing"

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cli-target-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe("target", () => {
  test("is the area argument as given, case kept", async () => {
    const run = await cli(["target", ADD_ID, "--cwd", "/x"], JSON.stringify({ area: "North/Hall" }))
    expect(run).toEqual({ code: EXIT_OK, stdout: '{"resources":["North/Hall"]}\n', stderr: "" })
  })

  test("is the working directory without an area argument", async () => {
    expect(json(await cli(["target", ADD_ID, "--cwd", "/work/tree"]))).toEqual({ resources: ["/work/tree"] })
  })

  test("lists every target the call writes to, sorted", async () => {
    const stdin = JSON.stringify({ area: "south", parent: "east" })
    expect(json(await cli(["target", ADD_ID, "--cwd", "/x"], stdin))).toEqual({ resources: ["east", "south"] })
  })

  test("is * for a tool that does not say what it writes to", async () => {
    expect(json(await cli(["target", READ_ID, "--cwd", "/x"]))).toEqual({ resources: ["*"] })
  })

  test("is * for a target that cannot be told, beside the others", async () => {
    expect(json(await cli(["target", ADD_ID, "--cwd", "/x"], '{"area":"north","parent":""}'))).toEqual({
      resources: ["north", "*"],
    })
  })

  test("is * for arguments the schema does not accept", async () => {
    expect(json(await cli(["target", ADD_ID, "--cwd", "/x"], '{"area":3}'))).toEqual({ resources: ["*"] })
    expect(json(await cli(["target", ADD_ID, "--cwd", "/x"], '{"bogus":1}'))).toEqual({ resources: ["*"] })
  })

  test("is * in the install directory without an area, and still names an area given there", async () => {
    const own = tempDir()
    const argv = ["target", ADD_ID, "--cwd", own]
    expect(json(await cli(argv, "", { ownDir: own }))).toEqual({ resources: ["*"] })
    expect(json(await cli(argv, '{"area":"north"}', { ownDir: own }))).toEqual({ resources: ["north"] })
    expect(json(await cli(argv))).toEqual({ resources: [own] })
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
