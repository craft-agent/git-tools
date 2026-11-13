import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { isToolError } from "../errors"
import { withLock, writeAtomic } from "./store"

const STALE_AGE_MS = 60_000
const HELD_FOR_MS = 40
const POLL_MS = 5
const WAITERS = 2

let dir: string
let lockPath: string

beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), "store-lock-")), "grants")
  lockPath = join(dir, "lock")
})

afterEach(async () => {
  await rm(join(dir, ".."), { recursive: true, force: true })
})

async function thrown(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  )
}

/** The token the lock file holds now, or `undefined` while it is missing or not yet written. */
async function lockToken(): Promise<unknown> {
  try {
    return JSON.parse(await readFile(lockPath, "utf8")).token
  } catch {
    return undefined
  }
}

async function tokenOtherThan(previous: unknown): Promise<string> {
  for (;;) {
    const token = await lockToken()
    if (typeof token === "string" && token !== previous) return token
    await sleep(POLL_MS)
  }
}

async function makeStale(): Promise<void> {
  const old = new Date(Date.now() - STALE_AGE_MS)
  await utimes(lockPath, old, old)
}

/** A promise and the function that settles it, to hold a critical section open from the test. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { opened, open }
}

describe("who owns the lock", () => {
  test("the lock file holds a random token, the pid and the time, and is gone after", async () => {
    await withLock(dir, async () => {
      const content = JSON.parse(await readFile(lockPath, "utf8"))
      expect(content.token).toMatch(/^[0-9a-f]{32}$/)
      expect(content.pid).toBe(process.pid)
      expect(Number.isNaN(Date.parse(content.at))).toBe(false)
    })
    expect(await stat(lockPath).catch(() => undefined)).toBeUndefined()
  })

  test("release leaves a lock that holds another owner's token", async () => {
    await withLock(dir, async () => {
      await writeFile(lockPath, `${JSON.stringify({ token: "another owner" })}\n`)
    })
    expect(await lockToken()).toBe("another owner")
  })

  test("a holder whose stale lock was taken over writes nothing, fails, and leaves the new owner's lock", async () => {
    const target = join(dir, "out.txt")
    const stalled = gate()
    const second = gate()
    const holder = thrown(
      withLock(dir, async (lock) => {
        await stalled.opened
        await writeAtomic(target, "from a stalled holder", lock)
      }),
    )
    const firstToken = await tokenOtherThan(undefined)
    await makeStale()
    const takenOver = withLock(dir, () => second.opened)
    const secondToken = await tokenOtherThan(firstToken)

    stalled.open()
    const error = await holder
    expect(isToolError(error) && error.code).toBe("internal_error")
    expect(error).toMatchObject({ message: expect.stringContaining("Nothing was written") })
    expect(await stat(target).catch(() => undefined)).toBeUndefined()
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([])
    expect(await lockToken()).toBe(secondToken)

    second.open()
    await takenOver
    expect(await stat(lockPath).catch(() => undefined)).toBeUndefined()
  })

  test("waiters that reclaim the same stale lock take it one at a time", async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(lockPath, "99999 long ago\n")
    await makeStale()
    let active = 0
    let mostActive = 0
    const owners: number[] = []
    await Promise.all(
      Array.from({ length: WAITERS }, (_, index) =>
        withLock(dir, async () => {
          active += 1
          mostActive = Math.max(mostActive, active)
          owners.push(index)
          await sleep(HELD_FOR_MS)
          active -= 1
        }),
      ),
    )
    expect(mostActive).toBe(1)
    expect(owners.sort()).toEqual(Array.from({ length: WAITERS }, (_, index) => index))
    expect(await stat(lockPath).catch(() => undefined)).toBeUndefined()
  })

  test("a lock that is not stale is not taken over: the waiter runs after its holder lets go", async () => {
    const held = gate()
    const holder = withLock(dir, () => held.opened)
    await tokenOtherThan(undefined)
    const token = await lockToken()
    let waiterRan = false
    const waiter = withLock(dir, async () => {
      waiterRan = true
    })
    await sleep(HELD_FOR_MS)
    expect(waiterRan).toBe(false)
    expect(await lockToken()).toBe(token)
    held.open()
    await Promise.all([holder, waiter])
    expect(waiterRan).toBe(true)
  })
})
