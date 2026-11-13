import { createHash } from "node:crypto"
import { appendFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { isRecord } from "../describe"
import { isToolError } from "../errors"
import { canonicalJson } from "../pin"
import type { CallMeasure, ToolBounds } from "../tool"
import { grantRefusal, matchGrant } from "./match"
import { RATE_WINDOW_MS, type Grant } from "./model"
import {
  hasSystemCode,
  macMatches,
  macOf,
  readGrants,
  requireKey,
  tamperedError,
  withLock,
  withReadLock,
  writeAtomic,
  type GrantStoreOptions,
} from "./store"

const USAGE_FILE = "usage.jsonl"
const HEAD_FILE = "usage.head.json"
const FILE_MODE = 0o600
/** The `prev` of the first line, and the `last` of an empty log. */
const NO_MAC = ""

const startSchema = z.object({
  kind: z.literal("start"),
  grant: z.string(),
  tool: z.string(),
  targets: z.array(z.string()),
  measure: z.record(z.string(), z.union([z.number(), z.boolean(), z.string(), z.array(z.string()).readonly()])),
  /** The SHA-256 of the arguments' canonical JSON. */
  args: z.string(),
  at: z.string(),
})

const endSchema = z.object({
  kind: z.literal("end"),
  /** The `seq` of the start this call began with. */
  start: z.number().int(),
  /** `ok`, or the code of the error the call ended with. */
  outcome: z.string(),
  at: z.string(),
})

const chain = { seq: z.number().int(), prev: z.string(), mac: z.string() }

const entrySchema = z.discriminatedUnion("kind", [startSchema.extend(chain), endSchema.extend(chain)])

const headSchema = z.object({ count: z.number().int().min(0), last: z.string(), mac: z.string() })

/** One line of the log: a call that began under a grant, or how it ended. */
export type UsageEntry = z.infer<typeof entrySchema>

/** The store, and the time the entry is made at. */
export type UsageOptions = GrantStoreOptions & { now: Date }

/** What `authorizeCall` needs to know of a call. */
export type UsageCall = {
  spec: { id: string; bounds?: ToolBounds }
  targets: readonly string[]
  measure: CallMeasure | undefined
  args: unknown
}

/** A grant that covers a call, and the line of the log that records its start. */
export type GrantUse = { grant: Grant; seq: number }

/** The calls that began under a grant in the hour before `now`; a call exactly an hour old no longer counts, and one dated after `now` still does. */
export function usedIn(entries: readonly UsageEntry[], grantId: string, now: Date): number {
  return entries.filter(
    (entry) =>
      entry.kind === "start" && entry.grant === grantId && now.getTime() - Date.parse(entry.at) < RATE_WINDOW_MS,
  ).length
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if (hasSystemCode(error, "ENOENT")) return undefined
    throw error
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw tamperedError()
  }
}

function verifiedEntries(key: Buffer, text: string): UsageEntry[] {
  const lines = text.split("\n")
  if (lines.pop() !== "") throw tamperedError()
  const entries: UsageEntry[] = []
  let prev = NO_MAC
  for (const [index, line] of lines.entries()) {
    const raw = parseJson(line)
    const parsed = entrySchema.safeParse(raw)
    if (!parsed.success || !isRecord(raw)) throw tamperedError()
    const entry = parsed.data
    const { mac, ...unsigned } = raw
    if (entry.seq !== index + 1 || entry.prev !== prev || !macMatches(key, unsigned, mac)) {
      throw tamperedError()
    }
    entries.push(entry)
    prev = entry.mac
  }
  return entries
}

function verifyHead(key: Buffer, text: string, entries: readonly UsageEntry[]): void {
  const parsed = headSchema.safeParse(parseJson(text))
  if (!parsed.success) throw tamperedError()
  const { count, last, mac } = parsed.data
  if (!macMatches(key, { count, last }, mac) || count > entries.length) throw tamperedError()
  if (last !== (count === 0 ? NO_MAC : entries[count - 1]!.mac)) throw tamperedError()
}

/**
 * Reads the log and checks it: every line parses, `seq` runs from 1, each
 * `prev` and `mac` verifies, and the head's MAC verifies with a count the log
 * reaches and a `last` that is the MAC of that line. Lines past the head are
 * accepted, since a call that died between appending and writing the head
 * leaves them, signed. A missing log with a missing head is empty; one without
 * the other, or any failure, is `forbidden` as tampered.
 */
async function readLog(options: GrantStoreOptions): Promise<UsageEntry[]> {
  const { dir } = options
  const key = requireKey(options)
  const [log, head] = await Promise.all([readText(join(dir, USAGE_FILE)), readText(join(dir, HEAD_FILE))])
  if (log === undefined && head === undefined) return []
  if (log === undefined || head === undefined) throw tamperedError()
  const entries = verifiedEntries(key, log)
  verifyHead(key, head, entries)
  return entries
}

/** Appends a signed line and moves the head to it; the caller holds the lock and has just read the log. */
async function appendEntry(
  options: GrantStoreOptions,
  entries: readonly UsageEntry[],
  body: z.infer<typeof startSchema> | z.infer<typeof endSchema>,
): Promise<number> {
  const { dir } = options
  const key = requireKey(options)
  const seq = entries.length + 1
  const unsigned = { ...body, seq, prev: entries.at(-1)?.mac ?? NO_MAC }
  const entry = { ...unsigned, mac: macOf(key, unsigned) }
  await appendFile(join(dir, USAGE_FILE), `${canonicalJson(entry)}\n`, { mode: FILE_MODE })
  const head = { count: seq, last: entry.mac }
  await writeAtomic(join(dir, HEAD_FILE), `${canonicalJson({ ...head, mac: macOf(key, head) })}\n`)
  return seq
}

/** Reads what the decision rests on, turning a tampered file into the refusal of this tool. */
async function readState(options: GrantStoreOptions, tool: string) {
  if (options.key === undefined) throw grantRefusal("no_key", tool)
  try {
    const { grants, failed } = await readGrants(options)
    if (failed.length > 0) throw tamperedError()
    return { grants, entries: await readLog(options) }
  } catch (error) {
    if (isToolError(error) && error.details?.reason === "tampered") throw grantRefusal("tampered", tool)
    throw error
  }
}

async function decide(options: UsageOptions, call: UsageCall) {
  const { spec, targets, measure } = call
  const { grants, entries } = await readState(options, spec.id)
  const match = matchGrant({
    call: { tool: spec.id, targets, measure },
    bounds: spec.bounds,
    grants,
    now: options.now,
    used: (id) => usedIn(entries, id, options.now),
  })
  if (!match.covered) throw match.error
  return { grant: match.grant, entries }
}

/**
 * Says which grant covers a call without recording anything, or throws the
 * refusal: `no_key` and `tampered` (a grant or the log fails its MAC) refuse
 * every call, otherwise `matchGrant` decides with the rate counted from the log.
 * It reads under the lock, so it never sees a line being appended, and creates
 * nothing: a directory that does not exist is an empty store.
 */
export async function checkCall(options: UsageOptions, call: UsageCall): Promise<Grant> {
  if (options.key === undefined) throw grantRefusal("no_key", call.spec.id)
  return withReadLock(options.dir, async () => (await decide(options, call)).grant)
}

/**
 * Decides as `checkCall` does and, when a grant covers the call, appends its
 * start to the log in the same locked step, so that concurrent calls cannot
 * both take the last of a rate. Returns the grant and the line of the start.
 */
export async function authorizeCall(options: UsageOptions, call: UsageCall): Promise<GrantUse> {
  if (options.key === undefined) throw grantRefusal("no_key", call.spec.id)
  return withLock(options.dir, async () => {
    const { grant, entries } = await decide(options, call)
    const seq = await appendEntry(options, entries, {
      kind: "start",
      grant: grant.id,
      tool: call.spec.id,
      targets: [...call.targets],
      measure: call.measure ?? {},
      args: createHash("sha256").update(canonicalJson(call.args)).digest("hex"),
      at: options.now.toISOString(),
    })
    return { grant, seq }
  })
}

/**
 * Appends the end of a call that `authorizeCall` began. It throws when the log
 * fails its check or cannot be written; a caller that has the call's own result
 * to return swallows that, so the log never hides it.
 */
export async function finishCall(options: UsageOptions, seq: number, outcome: string): Promise<void> {
  requireKey(options)
  await withLock(options.dir, async () => {
    const entries = await readLog(options)
    await appendEntry(options, entries, { kind: "end", start: seq, outcome, at: options.now.toISOString() })
  })
}

/** The log's lines, checked as `readLog` says and read under the lock; `forbidden` when tampered or no key is set. */
export async function readUsage(options: GrantStoreOptions): Promise<UsageEntry[]> {
  requireKey(options)
  return withReadLock(options.dir, () => readLog(options))
}
