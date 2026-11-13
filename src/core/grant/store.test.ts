import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isToolError } from "../errors"
import type { Grant } from "./model"
import { addGrant, readGrants, removeGrant, withLock, type GrantStoreOptions } from "./store"

const KEY = Buffer.alloc(32, 7)
const OTHER_KEY = Buffer.alloc(32, 9)
const POSIX = process.platform !== "win32"

function grant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: "g1",
    tool: "demo_note_create",
    targets: ["/work/a.md"],
    bounds: { text_length: 100, type: ["A", "MX"], attach: false },
    rate: 5,
    created_at: "2026-05-31T12:00:00Z",
    expires_at: "2026-06-30T12:00:00Z",
    reason: "daily notes",
    ...overrides,
  }
}

async function thrown(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  )
}

let base: string
let options: GrantStoreOptions

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "grants-"))
  options = { dir: join(base, "grants"), key: KEY }
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

async function editFile(edit: (file: { version: number; grants: Record<string, unknown>[] }) => void): Promise<void> {
  const path = join(options.dir, "grants.json")
  const file = JSON.parse(await readFile(path, "utf8"))
  edit(file)
  await writeFile(path, JSON.stringify(file))
}

describe("the grant store", () => {
  test("a missing file holds no grants", async () => {
    expect(await readGrants(options)).toEqual({ grants: [], failed: [] })
  })

  test("grants added are read back, in order, with their MAC outside the grant", async () => {
    await addGrant(options, grant({ id: "g1" }))
    await addGrant(options, grant({ id: "g2", bounds: { attach: true, text_length: 5, type: ["TXT"] } }))
    const { grants, failed } = await readGrants(options)
    expect(failed).toEqual([])
    expect(grants).toEqual([
      grant({ id: "g1" }),
      grant({ id: "g2", bounds: { attach: true, text_length: 5, type: ["TXT"] } }),
    ])
    const file = JSON.parse(await readFile(join(options.dir, "grants.json"), "utf8"))
    expect(file.version).toBe(1)
    expect(file.grants[0].mac).toMatch(/^[0-9a-f]{64}$/)
  })

  test("a grant edited in any field fails its MAC, and only it is left out", async () => {
    await addGrant(options, grant({ id: "g1" }))
    await addGrant(options, grant({ id: "g2" }))
    await editFile((file) => {
      file.grants[0]!.rate = 1000
    })
    const { grants, failed } = await readGrants(options)
    expect(grants.map((g) => g.id)).toEqual(["g2"])
    expect(failed).toEqual(["g1"])
  })

  test("a grant signed with another key fails, and a bad shape fails with `?` when it has no id", async () => {
    await addGrant({ ...options, key: OTHER_KEY }, grant({ id: "g1" }))
    await addGrant(options, grant({ id: "g2" }))
    await editFile((file) => {
      file.grants.push({ rate: 1, mac: "x" }, "junk" as never)
    })
    const { grants, failed } = await readGrants(options)
    expect(grants.map((g) => g.id)).toEqual(["g2"])
    expect(failed).toEqual(["g1", "?", "?"])
  })

  test("adding keeps an entry that fails its MAC exactly as it is", async () => {
    await addGrant(options, grant({ id: "g1" }))
    await editFile((file) => {
      file.grants[0]!.reason = "edited"
    })
    await addGrant(options, grant({ id: "g2" }))
    const file = JSON.parse(await readFile(join(options.dir, "grants.json"), "utf8"))
    expect(file.grants.map((g: Grant) => [g.id, g.reason])).toEqual([
      ["g1", "edited"],
      ["g2", "daily notes"],
    ])
  })

  test("revoking removes an entry even when its MAC fails, and says whether one was there", async () => {
    await addGrant(options, grant({ id: "g1" }))
    await addGrant(options, grant({ id: "g2" }))
    await editFile((file) => {
      file.grants[0]!.rate = 1000
    })
    expect(await removeGrant({ ...options, key: undefined }, "g1")).toBe(true)
    expect(await removeGrant(options, "g1")).toBe(false)
    expect(await readGrants(options)).toEqual({ grants: [grant({ id: "g2" })], failed: [] })
  })

  test("a file that is not valid JSON, or not the grants shape, is tampered for read, add and revoke", async () => {
    await addGrant(options, grant())
    for (const text of ["{not json", "[]", '{"version":2,"grants":[]}', '{"version":1,"grants":{}}']) {
      await writeFile(join(options.dir, "grants.json"), text)
      for (const run of [
        () => readGrants(options),
        () => addGrant(options, grant({ id: "g2" })),
        () => removeGrant(options, "g1"),
      ]) {
        const error = await thrown(run())
        expect(isToolError(error) && [error.code, error.details]).toEqual(["forbidden", { reason: "tampered" }])
      }
      expect(await readFile(join(options.dir, "grants.json"), "utf8")).toBe(text)
    }
  })

  test("without a key nothing is read or added", async () => {
    for (const run of [
      () => readGrants({ ...options, key: undefined }),
      () => addGrant({ ...options, key: undefined }, grant()),
    ]) {
      const error = await thrown(run())
      expect(isToolError(error) && [error.code, error.details]).toEqual(["forbidden", { reason: "no_key" }])
    }
  })

  test.skipIf(!POSIX)("the directory is 0o700 and the files 0o600", async () => {
    await addGrant(options, grant())
    expect((await stat(options.dir)).mode & 0o777).toBe(0o700)
    expect((await stat(join(options.dir, "grants.json"))).mode & 0o777).toBe(0o600)
  })
})

describe("the lock", () => {
  test("two calls at once both land, and the lock is gone after", async () => {
    await Promise.all([addGrant(options, grant({ id: "g1" })), addGrant(options, grant({ id: "g2" }))])
    const { grants } = await readGrants(options)
    expect(grants.map((g) => g.id).sort()).toEqual(["g1", "g2"])
    expect(await stat(join(options.dir, "lock")).catch(() => undefined)).toBeUndefined()
  })

  test("many calls at once each take their turn", async () => {
    const ids = Array.from({ length: 12 }, (_, index) => `g${index}`)
    await Promise.all(ids.map((id) => addGrant(options, grant({ id }))))
    expect((await readGrants(options)).grants.map((g) => g.id).sort()).toEqual([...ids].sort())
  })

  test("a lock older than 30 seconds is taken over", async () => {
    await mkdir(options.dir, { recursive: true })
    const lock = join(options.dir, "lock")
    await writeFile(lock, "99999 long ago\n")
    const old = new Date(Date.now() - 60_000)
    await utimes(lock, old, old)
    await addGrant(options, grant())
    expect((await readGrants(options)).grants).toHaveLength(1)
  })

  test("the lock is released when the work throws", async () => {
    const error = await thrown(
      withLock(options.dir, async () => {
        throw new Error("boom")
      }),
    )
    expect((error as Error).message).toBe("boom")
    expect(await withLock(options.dir, async () => "again")).toBe("again")
  })
})
