import { createHash } from "node:crypto"
import type { CallDescription } from "./tool"

/** The shape of a pin: the lowercase hex of a SHA-256. */
export const PIN_PATTERN = /^[0-9a-f]{64}$/

/** A value with every object's keys in sorted order, recursively, and arrays in their own order. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (typeof value !== "object" || value === null) return value
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return Object.fromEntries(entries.map(([key, entry]) => [key, sorted(entry)]))
}

/**
 * The pin of an approval: the lowercase hex SHA-256 of the canonical JSON (keys
 * sorted recursively, arrays in order) of what the call writes to and its
 * description as the tool gave it, whole, before translation and before the
 * prompt's budgets cut it, hidden `pins` included.
 * The order in which a `describe` lists its keys never changes the pin; a
 * change of any resource, headline, fact, text or pin does.
 */
export function pinOf(resources: string[], description: CallDescription): string {
  return createHash("sha256")
    .update(JSON.stringify(sorted({ resources, description })))
    .digest("hex")
}
