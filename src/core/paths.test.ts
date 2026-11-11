import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isWithin, realpathOfExisting, realpathOrSelf } from "./paths"

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "paths-"))
  mkdirSync(join(root, "inside", "deeper"), { recursive: true })
  mkdirSync(join(root, "outside"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("isWithin", () => {
  test("a directory is within itself and within a parent", async () => {
    expect(await isWithin(join(root, "inside"), join(root, "inside"))).toBe(true)
    expect(await isWithin(join(root, "inside", "deeper"), join(root, "inside"))).toBe(true)
  })

  test("a sibling, a parent and a name that merely starts alike are not within", async () => {
    expect(await isWithin(join(root, "outside"), join(root, "inside"))).toBe(false)
    expect(await isWithin(root, join(root, "inside"))).toBe(false)
    mkdirSync(join(root, "inside-2"))
    expect(await isWithin(join(root, "inside-2"), join(root, "inside"))).toBe(false)
  })

  test("is compared by real path, so a link into the root is within it", async () => {
    symlinkSync(join(root, "inside"), join(root, "link"))
    expect(await isWithin(join(root, "link", "deeper"), join(root, "inside"))).toBe(true)
    symlinkSync(join(root, "outside"), join(root, "inside", "escape"))
    expect(await isWithin(join(root, "inside", "escape"), join(root, "inside"))).toBe(false)
  })

  test("a path that cannot be resolved is not within", async () => {
    expect(await isWithin(join(root, "missing"), join(root, "inside"))).toBe(false)
    expect(await isWithin(join(root, "inside"), join(root, "missing"))).toBe(false)
  })
})

describe("realpathOrSelf", () => {
  test("resolves a link, and returns a path that does not exist as it is", async () => {
    symlinkSync(join(root, "inside"), join(root, "link"))
    expect(await realpathOrSelf(join(root, "link"))).toBe(await realpath(join(root, "inside")))
    expect(await realpathOrSelf(join(root, "missing"))).toBe(join(root, "missing"))
  })
})

describe("realpathOfExisting", () => {
  test("resolves the part that exists and keeps the rest as written", async () => {
    symlinkSync(join(root, "inside"), join(root, "link"))
    const real = await realpath(join(root, "inside"))
    expect(await realpathOfExisting(join(root, "link", "deeper"))).toBe(join(real, "deeper"))
    expect(await realpathOfExisting(join(root, "link", "a", "b"))).toBe(join(real, "a", "b"))
    expect(await realpathOfExisting(join(root, "missing"))).toBe(join(await realpath(root), "missing"))
  })
})
