import type { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js"
import { statSync } from "node:fs"
import { isAbsolute } from "node:path"
import { fileURLToPath } from "node:url"
import { isAbortError, isWithin } from "../core"

const FILE_URI_PROTOCOL = "file:"

/** The experimental capability under which Codex sends its sandbox state, including the session's directory, in each call's `_meta`. */
export const SANDBOX_STATE_META = "codex/sandbox-state-meta"

const TURN_METADATA = "x-codex-turn-metadata"

/** `dir` when it is an existing directory, else `undefined`. */
function existingDirectory(dir: string): string | undefined {
  try {
    return statSync(dir, { throwIfNoEntry: false })?.isDirectory() ? dir : undefined
  } catch {
    return undefined
  }
}

/** The directory a root URI names, or `undefined` for anything but an existing local directory. */
function localDirectory(uri: string): string | undefined {
  try {
    const url = new URL(uri)
    return url.protocol === FILE_URI_PROTOCOL ? existingDirectory(fileURLToPath(url)) : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The directory a client names, as a `file:` URI or, with `allowPath`, an
 * absolute path: `undefined` unless it is an existing local directory outside
 * `ownDir`.
 */
async function usableDirectory(candidate: unknown, ownDir?: string, allowPath = false): Promise<string | undefined> {
  if (typeof candidate !== "string") return undefined
  const dir = allowPath && isAbsolute(candidate) ? existingDirectory(candidate) : localDirectory(candidate)
  if (dir === undefined || (ownDir !== undefined && (await isWithin(dir, ownDir)))) return undefined
  return dir
}

/** The directory Codex sends with a call: its sandbox state's `sandboxCwd`, else the one workspace its turn metadata names. */
async function callDirectory(meta: unknown, ownDir?: string): Promise<string | undefined> {
  if (!isRecord(meta)) return undefined
  const sandbox = meta[SANDBOX_STATE_META]
  if (isRecord(sandbox)) {
    const dir = await usableDirectory(sandbox.sandboxCwd, ownDir, true)
    if (dir !== undefined) return dir
  }
  const turn = meta[TURN_METADATA]
  if (!isRecord(turn) || !isRecord(turn.workspaces)) return undefined
  const workspaces = Object.keys(turn.workspaces)
  return workspaces.length === 1 ? usableDirectory(workspaces[0], ownDir, true) : undefined
}

/** The first root of the client that is an existing local directory, and not inside `ownDir`. */
async function firstUsableRoot(server: Server, ownDir?: string, signal?: AbortSignal): Promise<string | undefined> {
  const { roots } = await server.listRoots(undefined, { signal })
  for (const root of roots) {
    const dir = await usableDirectory(root.uri, ownDir)
    if (dir !== undefined) return dir
  }
  return undefined
}

/**
 * Resolves the directory a call runs in: Codex's per-call sandbox state, else
 * the single workspace in Codex's turn metadata, else the client's first usable
 * root, else `fallback()`. Client directories must exist locally and not be
 * inside `ownDir`. Only roots are cached, until the client reports a change;
 * a client that advertises no roots skips straight to the fallback.
 */
export function createWorkingDirResolver(
  server: Server,
  fallback: () => string,
  ownDir?: string,
): (signal?: AbortSignal, meta?: Record<string, unknown>) => Promise<string> {
  let cached: string | undefined
  let generation = 0
  server.setNotificationHandler(RootsListChangedNotificationSchema, () => {
    cached = undefined
    generation++
  })

  return async (signal, meta) => {
    const callDir = await callDirectory(meta, ownDir)
    if (callDir !== undefined) return callDir
    if (!server.getClientCapabilities()?.roots) return fallback()
    if (cached !== undefined) return cached
    const started = generation
    let dir: string
    try {
      dir = (await firstUsableRoot(server, ownDir, signal)) ?? fallback()
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error
      return fallback()
    }
    if (generation === started) cached = dir
    return dir
  }
}
