import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { isToolError } from "../errors"
import type { Grant } from "./model"
import { addGrant, withLock, type GrantStoreOptions } from "./store"
import { authorizeCall, checkCall, readUsage, type UsageCall } from "./usage"

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

/** Holds the lock for a while, as a slow append would, and says whether `reader` (started meanwhile) had settled before it let go. */
async function readWhileLocked<T>(reader: () => Promise<T>): Promise<{ settledEarly: boolean; result: T }> {
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  const holding = withLock(options.dir, () => held)
  while (!(await exists(join(options.dir, "lock")))) await sleep(LOCK_POLL_MS)

  let settled = false
  const pending = reader().finally(() => (settled = true))
  await sleep(HELD_FOR_MS)
  const settledEarly = settled
  release()
  await holding
  return { settledEarly, result: await pending }
}

describe("reading under the lock", () => {
  test("a checkCall started while a writer holds the lock waits, then succeeds", async () => {
    await addGrant(options, grant)
    const { settledEarly, result } = await readWhileLocked(() => checkCall({ ...options, now: NOW }, call))
    expect(settledEarly).toBe(false)
    expect(result.id).toBe("g1")
    expect(await exists(join(options.dir, "lock"))).toBe(false)
  })

  test("a readUsage started while a writer holds the lock waits, then reads", async () => {
    await addGrant(options, grant)
    await authorizeCall({ ...options, now: NOW }, call)
    const { settledEarly, result } = await readWhileLocked(() => readUsage(options))
    expect(settledEarly).toBe(false)
    expect(result).toHaveLength(1)
  })

  test("without a directory checkCall decides on an empty store and creates nothing", async () => {
    const error = await checkCall({ ...options, now: NOW }, call).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(isToolError(error) && error.details).toEqual({ reason: "no_grant", tool: TOOL })
    expect(await readUsage(options)).toEqual([])
    expect(await exists(options.dir)).toBe(false)
  })

  test("checkCall leaves only what was there: no lock and no log", async () => {
    await addGrant(options, grant)
    await checkCall({ ...options, now: NOW }, call)
    expect(await exists(join(options.dir, "lock"))).toBe(false)
    expect(await exists(join(options.dir, "usage.jsonl"))).toBe(false)
  })
})
