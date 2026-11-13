import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { isToolError } from "../errors"
import type { Grant } from "./model"
import { addGrant, withLock, type GrantStoreOptions } from "./store"
import { authorizeCall, checkCall, finishCall, readUsage, type UsageCall } from "./usage"

const KEY = Buffer.alloc(32, 7)
const TOOL = "demo_note_create"
const NOW = new Date("2026-06-01T12:00:00Z")
const HELD_FOR_MS = 150
const LOCK_POLL_MS = 5

const grant: Grant = {
  id: "g1",
  tool: TOOL,
  targets: ["/work/a.md"],
  bounds: { text_length: 100 },
  rate: 3,
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
  base = await mkdtemp(join(tmpdir(), "usage-lock-"))
  options = { dir: join(base, "grants"), key: KEY }
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

const exists = async (path: string) => (await stat(path).catch(() => undefined)) !== undefined

async function thrown(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  )
}

/**
 * Holds the lock for a while, as a slow append would, and says whether `reader` (started meanwhile) had
 * settled before it let go. `whileHeld` runs just before the lock is released.
 */
async function readWhileLocked<T>(
  reader: () => Promise<T>,
  whileHeld: () => void = () => {},
): Promise<{ settledEarly: boolean; result: T }> {
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  const holding = withLock(options.dir, () => held)
  while (!(await exists(join(options.dir, "lock")))) await sleep(LOCK_POLL_MS)

  let settled = false
  const pending = reader().finally(() => (settled = true))
  await sleep(HELD_FOR_MS)
  const settledEarly = settled
  whileHeld()
  release()
  await holding
  return { settledEarly, result: await pending }
}

describe("reading under the lock", () => {
  test("a checkCall started while a writer holds the lock waits, then succeeds", async () => {
    await addGrant(options, grant)
    const { settledEarly, result } = await readWhileLocked(() => checkCall({ ...options, now: () => NOW }, call))
    expect(settledEarly).toBe(false)
    expect(result.id).toBe("g1")
    expect(await exists(join(options.dir, "lock"))).toBe(false)
  })

  test("a readUsage started while a writer holds the lock waits, then reads", async () => {
    await addGrant(options, grant)
    await authorizeCall({ ...options, now: () => NOW }, call)
    const { settledEarly, result } = await readWhileLocked(() => readUsage(options))
    expect(settledEarly).toBe(false)
    expect(result).toHaveLength(1)
  })

  test("without a directory checkCall decides on an empty store and creates nothing", async () => {
    const error = await checkCall({ ...options, now: () => NOW }, call).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(isToolError(error) && error.details).toEqual({ reason: "no_grant", tool: TOOL })
    expect(await readUsage(options)).toEqual([])
    expect(await exists(options.dir)).toBe(false)
  })

  test("checkCall leaves only what was there: no lock and no log", async () => {
    await addGrant(options, grant)
    await checkCall({ ...options, now: () => NOW }, call)
    expect(await exists(join(options.dir, "lock"))).toBe(false)
    expect(await exists(join(options.dir, "usage.jsonl"))).toBe(false)
  })
})

describe("the clock is read inside the lock", () => {
  const LATER = new Date(NOW.getTime() + 60_000)

  test("a grant that expires while the call waits for the lock refuses as expired", async () => {
    await addGrant(options, { ...grant, expires_at: new Date(NOW.getTime() + 1000).toISOString() })
    let current = NOW
    const { result } = await readWhileLocked(
      () => thrown(authorizeCall({ ...options, now: () => current }, call)),
      () => (current = LATER),
    )
    expect(isToolError(result) && [result.code, result.details?.reason]).toEqual(["forbidden", "expired"])
    expect(await exists(join(options.dir, "usage.jsonl"))).toBe(false)
  })

  test("the start is logged with the time of the decision, and the end with the time it was made", async () => {
    await addGrant(options, grant)
    let current = NOW
    const { result } = await readWhileLocked(
      () => authorizeCall({ ...options, now: () => current }, call),
      () => (current = LATER),
    )
    await finishCall({ ...options, now: () => new Date(LATER.getTime() + 1000) }, result.seq, "ok")
    const [start, end] = await readUsage(options)
    expect([start?.at, end?.at]).toEqual([LATER.toISOString(), new Date(LATER.getTime() + 1000).toISOString()])
  })

  test("the clock is read after the state, once per decision", async () => {
    await addGrant(options, grant)
    let reads = 0
    await authorizeCall(
      {
        ...options,
        now: () => {
          reads += 1
          return NOW
        },
      },
      call,
    )
    expect(reads).toBe(1)
  })
})

describe("a call whose lock was taken over", () => {
  /** A clock that, when read inside the critical section, hands the lock to another owner as a takeover would. */
  const takingOver = (): (() => Date) => () => {
    writeFileSync(join(options.dir, "lock"), `${JSON.stringify({ token: "another owner" })}\n`)
    return NOW
  }

  test("authorizeCall writes nothing and fails, and leaves the other owner's lock", async () => {
    await addGrant(options, grant)
    const error = await thrown(authorizeCall({ ...options, now: takingOver() }, call))
    expect(isToolError(error) && error.code).toBe("internal_error")
    expect(error).toMatchObject({ message: expect.stringContaining("Nothing was written") })
    expect(await exists(join(options.dir, "usage.jsonl"))).toBe(false)
    expect(await exists(join(options.dir, "usage.head.json"))).toBe(false)
    expect(await readFile(join(options.dir, "lock"), "utf8")).toContain("another owner")
  })

  test("finishCall appends nothing and fails", async () => {
    await addGrant(options, grant)
    const { seq } = await authorizeCall({ ...options, now: () => NOW }, call)
    const before = await readFile(join(options.dir, "usage.jsonl"), "utf8")
    const error = await thrown(finishCall({ ...options, now: takingOver() }, seq, "ok"))
    expect(isToolError(error) && error.code).toBe("internal_error")
    expect(await readFile(join(options.dir, "usage.jsonl"), "utf8")).toBe(before)
  })
})
