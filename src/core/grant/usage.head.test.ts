import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isToolError } from "../errors"
import { canonicalJson } from "../pin"
import type { Grant } from "./model"
import { addGrant, macOf, type GrantStoreOptions } from "./store"
import { authorizeCall, readUsage, type UsageCall } from "./usage"

const KEY = Buffer.alloc(32, 7)
const TOOL = "demo_note_create"
const NOW = () => new Date("2026-06-01T12:00:00Z")

const grant: Grant = {
  id: "g1",
  tool: TOOL,
  targets: ["/work/a.md"],
  bounds: { text_length: 100 },
  rate: 5,
  created_at: "2026-05-31T12:00:00Z",
  expires_at: "2026-06-30T12:00:00Z",
  reason: "daily notes",
}

const call: UsageCall = {
  spec: { id: TOOL, bounds: { text_length: { kind: "max", description: "The longest text" } } },
  targets: ["/work/a.md"],
  measure: { text_length: 10 },
  args: {},
}

let base: string
let options: GrantStoreOptions

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "usage-head-"))
  options = { dir: join(base, "grants"), key: KEY }
  await addGrant(options, grant)
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

const logPath = () => join(options.dir, "usage.jsonl")
const headPath = () => join(options.dir, "usage.head.json")

/** The head as the store signs it for a log of `count` lines ending in `last`. */
function signedHead(count: number, last: string): string {
  const head = { count, last }
  return `${canonicalJson({ ...head, mac: macOf(KEY, head) })}\n`
}

async function thrown(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  )
}

describe("the first append", () => {
  test("a head of count 0 with no log, or an empty log, is an empty log, and the next call succeeds", async () => {
    await writeFile(headPath(), signedHead(0, ""))
    expect(await readUsage(options)).toEqual([])
    await writeFile(logPath(), "")
    expect(await readUsage(options)).toEqual([])

    expect((await authorizeCall({ ...options, now: NOW }, call)).seq).toBe(1)
    expect((await readUsage(options)).map((entry) => entry.seq)).toEqual([1])
    expect(JSON.parse(await readFile(headPath(), "utf8")).count).toBe(1)
  })

  test("the head is written before the first line: a call that fails to append leaves a store the next call can use", async () => {
    const blockLog = () => {
      mkdirSync(logPath())
      return NOW()
    }
    expect(await thrown(authorizeCall({ ...options, now: blockLog }, call))).toBeInstanceOf(Error)
    expect(await readFile(headPath(), "utf8")).toBe(signedHead(0, ""))

    await rm(logPath(), { recursive: true })
    expect(await readUsage(options)).toEqual([])
    expect((await authorizeCall({ ...options, now: NOW }, call)).seq).toBe(1)
  })

  test("a crash after the empty head and the first line, before the head moves, leaves a store the next call carries on from", async () => {
    await authorizeCall({ ...options, now: NOW }, call)
    await writeFile(headPath(), signedHead(0, ""))

    expect(await readUsage(options)).toHaveLength(1)
    expect((await authorizeCall({ ...options, now: NOW }, call)).seq).toBe(2)
    expect((await readUsage(options)).map((entry) => entry.seq)).toEqual([1, 2])
    expect(JSON.parse(await readFile(headPath(), "utf8")).count).toBe(2)
  })

  test("a log with no head at all is still tampered, even a log of one line", async () => {
    await authorizeCall({ ...options, now: NOW }, call)
    await rm(headPath())
    const error = await thrown(authorizeCall({ ...options, now: NOW }, call))
    expect(isToolError(error) && [error.code, error.details?.reason]).toEqual(["forbidden", "tampered"])
    const read = await thrown(readUsage(options))
    expect(isToolError(read) && [read.code, read.details?.reason]).toEqual(["forbidden", "tampered"])
  })

  test("a head of count 0 that is not signed, or names a last, is tampered", async () => {
    await writeFile(headPath(), `${canonicalJson({ count: 0, last: "", mac: "x" })}\n`)
    expect(await thrown(readUsage(options))).toMatchObject({ details: { reason: "tampered" } })
    await writeFile(headPath(), signedHead(0, "abc"))
    expect(await thrown(readUsage(options))).toMatchObject({ details: { reason: "tampered" } })
  })
})
