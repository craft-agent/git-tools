import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isToolError } from "../errors"
import type { ToolBounds } from "../tool"
import { RATE_WINDOW_MS, type Grant } from "./model"
import { addGrant, type GrantStoreOptions } from "./store"
import { authorizeCall, checkCall, finishCall, readUsage, usedIn, type UsageCall, type UsageEntry } from "./usage"

const KEY = Buffer.alloc(32, 7)
const TOOL = "demo_note_create"
const NOW = new Date("2026-06-01T12:00:00Z")
const bounds: ToolBounds = { text_length: { kind: "max", description: "The longest text" } }

function grant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: "g1",
    tool: TOOL,
    targets: ["/work/a.md"],
    bounds: { text_length: 100 },
    rate: 3,
    created_at: "2026-05-31T12:00:00Z",
    expires_at: "2026-06-30T12:00:00Z",
    reason: "daily notes",
    ...overrides,
  }
}

function call(overrides: Partial<UsageCall> = {}): UsageCall {
  return {
    spec: { id: TOOL, bounds },
    targets: ["/work/a.md"],
    measure: { text_length: 10 },
    args: { path: "/work/a.md", text: "hello" },
    ...overrides,
  }
}

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs)
}

async function thrown(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  )
}

function reason(error: unknown): unknown {
  return isToolError(error) && [error.code, error.details?.reason]
}

let base: string
let options: GrantStoreOptions

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "usage-"))
  options = { dir: join(base, "grants"), key: KEY }
  await addGrant(options, grant())
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

const logPath = () => join(options.dir, "usage.jsonl")
const headPath = () => join(options.dir, "usage.head.json")

async function logLines(): Promise<string[]> {
  return (await readFile(logPath(), "utf8")).split("\n").slice(0, -1)
}

async function expectTampered(promise: Promise<unknown>): Promise<void> {
  expect(reason(await thrown(promise))).toEqual(["forbidden", "tampered"])
}

async function threeCalls(): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    const { seq } = await authorizeCall({ ...options, now: at(index) }, call({ args: { index } }))
    await finishCall({ ...options, now: at(index) }, seq, "ok")
  }
}

describe("the log of use", () => {
  test("a missing log is empty", async () => {
    expect(await readUsage(options)).toEqual([])
  })

  test("a call is logged as a start and an end, chained, with a digest of its arguments", async () => {
    const use = await authorizeCall({ ...options, now: NOW }, call())
    expect(use.grant.id).toBe("g1")
    expect(use.seq).toBe(1)
    await finishCall({ ...options, now: at(1000) }, use.seq, "not_found")

    const [start, end] = await readUsage(options)
    expect(start).toMatchObject({
      kind: "start",
      seq: 1,
      prev: "",
      grant: "g1",
      tool: TOOL,
      targets: ["/work/a.md"],
      measure: { text_length: 10 },
      at: NOW.toISOString(),
    })
    expect(start!.kind === "start" && start!.args).toMatch(/^[0-9a-f]{64}$/)
    expect(end).toMatchObject({ kind: "end", seq: 2, prev: start!.mac, start: 1, outcome: "not_found" })

    const head = JSON.parse(await readFile(headPath(), "utf8"))
    expect(head).toMatchObject({ count: 2, last: end!.mac })
  })

  test("the digest does not depend on the order of the arguments' keys, and changes with their values", async () => {
    await authorizeCall({ ...options, now: NOW }, call({ args: { a: 1, b: { c: 2, d: 3 } } }))
    await authorizeCall({ ...options, now: NOW }, call({ args: { b: { d: 3, c: 2 }, a: 1 } }))
    await authorizeCall({ ...options, now: NOW }, call({ args: { a: 2, b: { c: 2, d: 3 } } }))
    const digests = (await readUsage(options)).map((entry) => entry.kind === "start" && entry.args)
    expect(digests[0]).toBe(digests[1]!)
    expect(digests[2]).not.toBe(digests[0]!)
  })

  test("a deleted middle line is tampered", async () => {
    await threeCalls()
    const lines = await logLines()
    await writeFile(logPath(), `${[lines[0], ...lines.slice(2)].join("\n")}\n`)
    await expectTampered(readUsage(options))
  })

  test("an edited line is tampered", async () => {
    await threeCalls()
    const lines = await logLines()
    lines[1] = lines[1]!.replace('"outcome":"ok"', '"outcome":"x"')
    await writeFile(logPath(), `${lines.join("\n")}\n`)
    await expectTampered(readUsage(options))
  })

  test("a truncated tail, which leaves the head ahead of the log, is tampered", async () => {
    await threeCalls()
    const lines = await logLines()
    await writeFile(logPath(), `${lines.slice(0, -1).join("\n")}\n`)
    await expectTampered(readUsage(options))
  })

  test("a head or a log without the other, a bad head and a line that is not JSON are tampered", async () => {
    await threeCalls()
    const log = await readFile(logPath(), "utf8")
    const head = await readFile(headPath(), "utf8")

    await rm(headPath())
    await expectTampered(readUsage(options))
    await writeFile(headPath(), head)
    await rm(logPath())
    await expectTampered(readUsage(options))
    await writeFile(logPath(), log)
    expect(await readUsage(options)).toHaveLength(6)

    await writeFile(headPath(), head.replace('"count":6', '"count":5'))
    await expectTampered(readUsage(options))
    await writeFile(headPath(), head)
    await writeFile(logPath(), `${log}not json\n`)
    await expectTampered(readUsage(options))
    await writeFile(logPath(), log.trimEnd())
    await expectTampered(readUsage(options))
  })

  test("a line past the head is accepted, and the next call carries on from it", async () => {
    const first = await authorizeCall({ ...options, now: NOW }, call())
    const head = await readFile(headPath(), "utf8")
    await finishCall({ ...options, now: NOW }, first.seq, "ok")
    await writeFile(headPath(), head)

    expect(await readUsage(options)).toHaveLength(2)
    await authorizeCall({ ...options, now: NOW }, call())
    const entries = await readUsage(options)
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3])
    expect(JSON.parse(await readFile(headPath(), "utf8")).count).toBe(3)
  })

  test("the key that signed it is needed to read it", async () => {
    await threeCalls()
    await expectTampered(readUsage({ ...options, key: Buffer.alloc(32, 1) }))
    expect(reason(await thrown(readUsage({ ...options, key: undefined })))).toEqual(["forbidden", "no_key"])
  })

  test.skipIf(process.platform === "win32")("the log and its head are 0o600", async () => {
    await threeCalls()
    expect((await stat(logPath())).mode & 0o777).toBe(0o600)
    expect((await stat(headPath())).mode & 0o777).toBe(0o600)
  })
})

describe("usedIn", () => {
  function start(id: string, offsetMs: number, seq: number): UsageEntry {
    return {
      kind: "start",
      seq,
      prev: "",
      mac: "",
      grant: id,
      tool: TOOL,
      targets: [],
      measure: {},
      args: "",
      at: at(offsetMs).toISOString(),
    }
  }

  test("counts the starts of the grant in the hour before now, and not a start an hour old", () => {
    const entries = [
      start("g1", -RATE_WINDOW_MS, 1),
      start("g1", -RATE_WINDOW_MS + 1, 2),
      start("g1", -1, 3),
      start("g1", 0, 4),
      start("g1", 60_000, 5),
      start("g2", -1, 6),
      { kind: "end", seq: 7, prev: "", mac: "", start: 3, outcome: "ok", at: at(-1).toISOString() } as UsageEntry,
    ]
    expect(usedIn(entries, "g1", NOW)).toBe(4)
    expect(usedIn(entries, "g2", NOW)).toBe(1)
    expect(usedIn(entries, "g3", NOW)).toBe(0)
  })

  test("the window moves with now", () => {
    const entries = [start("g1", 0, 1)]
    expect(usedIn(entries, "g1", at(RATE_WINDOW_MS - 1))).toBe(1)
    expect(usedIn(entries, "g1", at(RATE_WINDOW_MS))).toBe(0)
  })
})

describe("authorizeCall", () => {
  test("the rate runs out across calls, and comes back as the window moves on", async () => {
    for (let index = 0; index < 3; index += 1) await authorizeCall({ ...options, now: at(index * 1000) }, call())
    const error = await thrown(authorizeCall({ ...options, now: at(10_000) }, call()))
    expect(isToolError(error) && error.details).toEqual({ reason: "rate", tool: TOOL, grant: "g1" })
    expect(await readUsage(options)).toHaveLength(3)

    expect((await authorizeCall({ ...options, now: at(RATE_WINDOW_MS + 1000) }, call())).seq).toBe(4)
  })

  test("calls at once cannot both take the last of the rate", async () => {
    await addGrant(options, grant({ id: "g2", targets: ["/work/b.md"], rate: 1 }))
    const results = await Promise.allSettled(
      [1, 2, 3].map(() => authorizeCall({ ...options, now: NOW }, call({ targets: ["/work/b.md"] }))),
    )
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  })

  test("a refusal writes nothing to the log", async () => {
    const error = await thrown(authorizeCall({ ...options, now: NOW }, call({ targets: ["/work/other.md"] })))
    expect(reason(error)).toEqual(["forbidden", "target"])
    expect(await stat(logPath()).catch(() => undefined)).toBeUndefined()
  })

  test("without a key the refusal names the tool and touches no file", async () => {
    const noKey = { dir: join(base, "other"), key: undefined, now: NOW }
    const error = await thrown(authorizeCall(noKey, call()))
    expect(isToolError(error) && error.details).toEqual({ reason: "no_key", tool: TOOL })
    expect(await stat(noKey.dir).catch(() => undefined)).toBeUndefined()
  })

  test("a grant that fails its MAC refuses every call, with the tool in the refusal", async () => {
    await addGrant(options, grant({ id: "g2" }))
    const path = join(options.dir, "grants.json")
    await writeFile(path, (await readFile(path, "utf8")).replace('"rate": 3', '"rate": 3000'))
    const error = await thrown(authorizeCall({ ...options, now: NOW }, call()))
    expect(isToolError(error) && error.details).toEqual({ reason: "tampered", tool: TOOL })
  })

  test("a tampered log refuses every call, with the tool in the refusal", async () => {
    await authorizeCall({ ...options, now: NOW }, call())
    await writeFile(logPath(), "{}\n")
    const error = await thrown(authorizeCall({ ...options, now: NOW }, call()))
    expect(isToolError(error) && error.details).toEqual({ reason: "tampered", tool: TOOL })
  })

  test("a call whose measure failed is refused as a bound", async () => {
    const error = await thrown(authorizeCall({ ...options, now: NOW }, call({ measure: undefined })))
    expect(reason(error)).toEqual(["forbidden", "bound"])
  })

  test("checkCall decides the same way and records nothing", async () => {
    expect((await checkCall({ ...options, now: NOW }, call())).id).toBe("g1")
    const error = await thrown(checkCall({ ...options, now: NOW }, call({ targets: ["/elsewhere"] })))
    expect(reason(error)).toEqual(["forbidden", "target"])
    expect(await stat(logPath()).catch(() => undefined)).toBeUndefined()
  })
})
