import { isRecord } from "../describe"
import { ToolError } from "../errors"
import { PATTERN_CHARACTERS } from "../targets"
import type { ToolBounds } from "../tool"

/** A grant's value for one bound: a ceiling for `max`, whether it is allowed for `allow`, the allowed values for `oneOf`. */
export type GrantBoundValue = number | boolean | readonly string[]

/** A person's delegation of bounded writes of one tool. */
export type Grant = {
  id: string
  tool: string
  /** The targets the tool may write to: named ones only, sorted, without repeats. */
  targets: readonly string[]
  bounds: Readonly<Record<string, GrantBoundValue>>
  /** Calls per hour. */
  rate: number
  /** ISO 8601. */
  created_at: string
  /** ISO 8601. */
  expires_at: string
  reason: string
}

/** The longest a grant may last, in days. */
export const MAX_GRANT_DAYS = 90
/** The most calls per hour a grant may allow. */
export const MAX_GRANT_RATE = 1000
/** The window a grant's rate counts calls over, in milliseconds. */
export const RATE_WINDOW_MS = 60 * 60 * 1000

/** Why a call is not covered: the tool or the setup refuses every call, or the closest grant fails one check. */
export type GrantRefusal = "not_bounded" | "no_key" | "tampered" | "no_grant" | "expired" | "target" | "bound" | "rate"

function invalidBound(tool: string, name: string, mustBe: string): ToolError {
  return new ToolError("invalid_argument", `The bound "${name}" of ${tool} must be ${mustBe}.`)
}

/**
 * Checks the values a person gives for a new grant against the bounds the tool
 * declares and returns a normalized copy: every declared bound present (an
 * unset bound would be no bound), none undeclared, a `max` a whole number of
 * at least 0, an `allow` a boolean, and a `oneOf` a non-empty list of declared
 * values, sorted without repeats. Anything else is `invalid_argument`.
 */
export function grantBounds(bounds: ToolBounds, values: unknown, tool: string): Record<string, GrantBoundValue> {
  if (!isRecord(values)) {
    throw new ToolError(
      "invalid_argument",
      `The bounds of a grant for ${tool} must be an object with a value for each bound.`,
    )
  }
  const undeclared = Object.keys(values).find((name) => !Object.hasOwn(bounds, name))
  if (undeclared !== undefined) {
    const declared = Object.keys(bounds)
    throw new ToolError(
      "invalid_argument",
      `${tool} has no bound "${undeclared}"; ${declared.length > 0 ? `give only ${declared.join(", ")}` : "it declares none"}.`,
    )
  }

  const result: Record<string, GrantBoundValue> = {}
  for (const name of Object.keys(bounds).sort()) {
    const bound = bounds[name]!
    if (!Object.hasOwn(values, name)) throw invalidBound(tool, name, "given, since an unset bound would be no bound")
    const value = values[name]
    if (bound.kind === "max") {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw invalidBound(tool, name, "a whole number of at least 0")
      }
      result[name] = value
    } else if (bound.kind === "allow") {
      if (typeof value !== "boolean") throw invalidBound(tool, name, "true or false")
      result[name] = value
    } else {
      const among = `a non-empty list of values among ${bound.values.join(", ")}`
      if (!Array.isArray(value) || value.length === 0) throw invalidBound(tool, name, among)
      if (value.some((item) => typeof item !== "string" || !bound.values.includes(item))) {
        throw invalidBound(tool, name, among)
      }
      result[name] = [...new Set<string>(value)].sort()
    }
  }
  return result
}

/**
 * Checks the targets a person gives for a new grant: a non-empty list of
 * names, none blank and none holding `*` or `?` (those are patterns, which
 * would grant more than they name). Returns them as given, sorted, without
 * repeats; anything else is `invalid_argument`.
 */
export function grantTargets(targets: unknown): string[] {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new ToolError("invalid_argument", "A grant must name the targets it covers, as a non-empty list.")
  }
  for (const target of targets) {
    if (typeof target !== "string" || target.trim() === "" || PATTERN_CHARACTERS.test(target)) {
      throw new ToolError(
        "invalid_argument",
        `Every target of a grant must be a name that is not blank and holds no * or ?; got ${JSON.stringify(target) ?? String(target)}.`,
      )
    }
  }
  return [...new Set<string>(targets)].sort()
}
