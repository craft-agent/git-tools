import { homedir } from "node:os"
import { join } from "node:path"

/** The settings that hold a path read `~` as the home directory, alone or as {@link HOME_PREFIX}. */

const HOME_MARK = "~"

/** The start of a path under the home directory, as a setting may write it. */
export const HOME_PREFIX = "~/"

/** The home directory: `HOME` as it is now, which git sees too (Bun's `os.homedir()` would not follow a change), else the account's. */
export function homeDirectory(): string {
  return process.env.HOME?.trim() || homedir()
}

/** `value` with `~` alone, or a leading `~/`, replaced by the home directory. */
export function expandHome(value: string): string {
  if (value === HOME_MARK) return homeDirectory()
  return value.startsWith(HOME_PREFIX) ? join(homeDirectory(), value.slice(HOME_PREFIX.length)) : value
}
