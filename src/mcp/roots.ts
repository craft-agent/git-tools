import type { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js"
import { statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { isAbortError, isWithin } from "../core"

const FILE_URI_PROTOCOL = "file:"

/** The directory a root URI names, or `undefined` for anything but an existing local directory. */
function localDirectory(uri: string): string | undefined {
  try {
    const url = new URL(uri)
    if (url.protocol !== FILE_URI_PROTOCOL) return undefined
    const dir = fileURLToPath(url)
    return statSync(dir, { throwIfNoEntry: false })?.isDirectory() ? dir : undefined
  } catch {
    return undefined
  }
}

/** The first root of the client that is an existing local directory, and not inside `ownDir`. */
async function firstUsableRoot(server: Server, ownDir?: string, signal?: AbortSignal): Promise<string | undefined> {
  const { roots } = await server.listRoots(undefined, { signal })
  for (const root of roots) {
    const dir = localDirectory(root.uri)
    if (dir !== undefined && !(ownDir !== undefined && (await isWithin(dir, ownDir)))) return dir
  }
  return undefined
}

/**
 * Resolves the directory a call runs in: the first of the client's roots that
 * is an existing local directory and not inside `ownDir`, else `fallback()`.
 * A client that advertises no roots always gets `fallback()`. The answer is
 * kept until the client reports that its roots changed.
 */
export function createWorkingDirResolver(
  server: Server,
  fallback: () => string,
  ownDir?: string,
): (signal?: AbortSignal) => Promise<string> {
  let cached: string | undefined
  let generation = 0
  server.setNotificationHandler(RootsListChangedNotificationSchema, () => {
    cached = undefined
    generation++
  })

  return async (signal) => {
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
