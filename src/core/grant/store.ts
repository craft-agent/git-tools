import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { z } from "zod"
import { isRecord } from "../describe"
import { ToolError } from "../errors"
import { canonicalJson } from "../pin"
import type { Grant } from "./model"
import { grantRefusal } from "./match"

/** Where grants and their use are kept, and the key that signs them. */
export type GrantStoreOptions = {
  /** The directory grants and their log are kept in; created (mode 0o700) when missing. */
  dir: string
  /** The HMAC key; absent means no key is set. */
  key: Buffer | undefined
}

/** The only version of `grants.json` this package reads and writes. */
const GRANTS_VERSION = 1
/** The mode of the directory and of every file in it: the person's alone. */
const DIR_MODE = 0o700
const FILE_MODE = 0o600

const GRANTS_FILE = "grants.json"
const LOCK_FILE = "lock"
const TEMP_FILE_RANDOM_BYTES = 4

const LOCK_TIMEOUT_MS = 5000
/** A lock older than this was left by a call that died. */
const LOCK_STALE_MS = 30_000
const LOCK_RETRY_MIN_MS = 25
const LOCK_RETRY_JITTER_MS = 25

const grantSchema = z.object({
  id: z.string(),
  tool: z.string(),
  targets: z.array(z.string()),
  bounds: z.record(z.string(), z.union([z.number(), z.boolean(), z.array(z.string())])),
  rate: z.number(),
  created_at: z.string(),
  expires_at: z.string(),
  reason: z.string(),
})

/** What a file in the directory holds when it was changed outside the package. */
export function tamperedError(): ToolError {
  return new ToolError("forbidden", grantRefusal("tampered", "").message, { details: { reason: "tampered" } })
}

/** The refusal when no key is set, for a caller that knows no tool. */
export function noKeyError(): ToolError {
  return new ToolError("forbidden", "No grant key is set, so grants cannot be read or written.", {
    details: { reason: "no_key" },
  })
}

/** The key of the options; `forbidden` when none is set. */
export function requireKey(options: GrantStoreOptions): Buffer {
  if (options.key === undefined) throw noKeyError()
  return options.key
}

/** The lowercase hex HMAC-SHA256 of a value's canonical JSON. */
export function macOf(key: Buffer, value: unknown): string {
  return createHmac("sha256", key).update(canonicalJson(value)).digest("hex")
}

/** Whether `mac` is the MAC of `value`, compared in constant time. */
export function macMatches(key: Buffer, value: unknown, mac: unknown): boolean {
  if (typeof mac !== "string") return false
  const expected = Buffer.from(macOf(key, value))
  const given = Buffer.from(mac)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

/** Writes a file whole: to a temporary file beside it, then renamed over it. */
export async function writeAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(TEMP_FILE_RANDOM_BYTES).toString("hex")}.tmp`
  try {
    await writeFile(temporary, text, { mode: FILE_MODE })
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/** Whether an error is the system's, with this code (`ENOENT`). */
export function hasSystemCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}

/** Takes the lock file; false when another call holds it. */
async function takeLock(path: string): Promise<boolean> {
  let handle
  try {
    handle = await open(path, "wx", FILE_MODE)
  } catch (error) {
    if (hasSystemCode(error, "EEXIST")) return false
    throw error
  }
  try {
    await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`)
  } catch (error) {
    await rm(path, { force: true })
    throw error
  } finally {
    await handle.close()
  }
  return true
}

/** Removes a lock a dead call left behind; true when it did, so the caller retries at once. */
async function removeStaleLock(path: string): Promise<boolean> {
  try {
    if (Date.now() - (await stat(path)).mtimeMs <= LOCK_STALE_MS) return false
  } catch (error) {
    if (hasSystemCode(error, "ENOENT")) return true
    throw error
  }
  await rm(path, { force: true })
  return true
}

/**
 * Runs `fn` while holding the directory's lock, so that calls from several
 * processes change the files one at a time. A call that finds the lock taken
 * retries for 5 seconds, and takes over a lock file more than 30 seconds old.
 * The lock is always released.
 */
export async function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dir, { recursive: true, mode: DIR_MODE })
  const path = join(dir, LOCK_FILE)
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  while (!(await takeLock(path))) {
    if (await removeStaleLock(path)) continue
    if (Date.now() >= deadline) {
      throw new ToolError(
        "internal_error",
        `Could not take the grants lock in ${dir} within ${LOCK_TIMEOUT_MS / 1000} s; another call may be stuck. Remove ${path} if no call is running.`,
      )
    }
    await sleep(LOCK_RETRY_MIN_MS + Math.random() * LOCK_RETRY_JITTER_MS)
  }
  try {
    return await fn()
  } finally {
    await rm(path, { force: true })
  }
}

/**
 * Runs `fn` as a reader would: under the lock, so that it never sees a line a
 * writer is still appending. A directory that does not exist holds nothing a
 * writer could be changing, so `fn` runs at once and nothing is created.
 */
export async function withReadLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  try {
    await stat(dir)
  } catch (error) {
    if (hasSystemCode(error, "ENOENT")) return fn()
    throw error
  }
  return withLock(dir, fn)
}

/** The entries of `grants.json` as stored; none when the file is missing, and tampered when it is not `{ version, grants }`. */
async function readEntries(dir: string): Promise<unknown[]> {
  let text: string
  try {
    text = await readFile(join(dir, GRANTS_FILE), "utf8")
  } catch (error) {
    if (hasSystemCode(error, "ENOENT")) return []
    throw error
  }
  let file: unknown
  try {
    file = JSON.parse(text)
  } catch {
    throw tamperedError()
  }
  if (!isRecord(file) || file.version !== GRANTS_VERSION || !Array.isArray(file.grants)) throw tamperedError()
  return file.grants
}

async function writeEntries(dir: string, grants: unknown[]): Promise<void> {
  await writeAtomic(join(dir, GRANTS_FILE), `${JSON.stringify({ version: GRANTS_VERSION, grants }, null, 2)}\n`)
}

function entryId(entry: unknown): string | undefined {
  return isRecord(entry) && typeof entry.id === "string" && entry.id !== "" ? entry.id : undefined
}

function verifiedGrant(key: Buffer, entry: unknown): Grant | undefined {
  if (!isRecord(entry)) return undefined
  const { mac, ...grant } = entry
  if (!macMatches(key, grant, mac)) return undefined
  const parsed = grantSchema.safeParse(grant)
  return parsed.success ? parsed.data : undefined
}

/**
 * Reads the grants. A grant whose MAC or shape fails is left out of `grants`
 * and its id (`?` when it has none) is listed in `failed`; a missing file holds
 * none. A file that is not valid JSON, or not `{ version: 1, grants: [] }`, is
 * `forbidden` as tampered; so is a missing key.
 */
export async function readGrants(options: GrantStoreOptions): Promise<{ grants: Grant[]; failed: string[] }> {
  const key = requireKey(options)
  const grants: Grant[] = []
  const failed: string[] = []
  for (const entry of await readEntries(options.dir)) {
    const grant = verifiedGrant(key, entry)
    if (grant) grants.push(grant)
    else failed.push(entryId(entry) ?? "?")
  }
  return { grants, failed }
}

/** Signs a grant and adds it to the file, keeping the entries already there as they are, whether or not they verify. */
export async function addGrant(options: GrantStoreOptions, grant: Grant): Promise<void> {
  const { dir } = options
  const key = requireKey(options)
  await withLock(dir, async () => {
    const entries = await readEntries(dir)
    await writeEntries(dir, [...entries, { ...grant, mac: macOf(key, grant) }])
  })
}

/**
 * Removes the grant with this id, even when its MAC fails, since revoking only
 * narrows what runs and needs no key. True when one was removed. A file that is
 * not valid JSON is `forbidden` as tampered.
 */
export async function removeGrant(options: GrantStoreOptions, id: string): Promise<boolean> {
  const { dir } = options
  return withLock(dir, async () => {
    const entries = await readEntries(dir)
    const kept = entries.filter((entry) => entryId(entry) !== id)
    if (kept.length === entries.length) return false
    await writeEntries(dir, kept)
    return true
  })
}
