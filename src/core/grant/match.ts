import { isRecord } from "../describe"
import { ToolError, type ErrorDetails } from "../errors"
import { ANY_TARGET } from "../targets"
import type { BoundSpec, CallMeasure, MeasuredValue, ToolBounds } from "../tool"
import type { Grant, GrantRefusal } from "./model"

/** What a grant is matched against: the call's tool, targets and measured values. */
export type GrantCall = {
  tool: string
  /** The targets `writeTargets` resolved; `*` means one could not be told. */
  targets: readonly string[]
  /** The call's measured values, or undefined when `measure` failed. */
  measure: CallMeasure | undefined
}

/** A call a grant covers, or the refusal of the grant that came closest. */
export type GrantMatch = { covered: true; grant: Grant } | { covered: false; error: ToolError }

type RefusalExtra = { grant?: string; bound?: string; message?: string }

const DEFAULT_MESSAGES: Record<GrantRefusal, (tool: string, extra: RefusalExtra) => string> = {
  person_only: (tool) => `${tool} runs only on a person's own answer, never under a grant.`,
  no_key: (tool) => `${tool} cannot run while no one can be asked: no grant key is set.`,
  tampered: () =>
    "The grants were changed outside the package, so nothing runs under them; a person can revoke the grant that fails, or clear the grants.",
  no_grant: (tool) => `No grant lets ${tool} run while no one can be asked; a person can delegate it with a grant.`,
  expired: (tool) => `The grant for ${tool} has expired; a person can delegate it again.`,
  target: (tool) =>
    `No grant for ${tool} covers every target of this call; a person can delegate one that names them, or one for any target.`,
  bound: (tool, extra) =>
    extra.bound === undefined
      ? `This call to ${tool} could not be measured against the grant's bounds; a person can delegate a grant that leaves the bounds out.`
      : `This call to ${tool} goes past the grant's ${extra.bound} bound; a person can delegate a wider grant.`,
  rate: (tool) => `The grant for ${tool} allows no more calls this hour; wait, or a person can delegate a higher rate.`,
}

/** The refusal of a call that no grant covers: `forbidden`, with the reason, the tool and, where they apply, the grant and the bound in `details`. */
export function grantRefusal(reason: GrantRefusal, tool: string, extra: RefusalExtra = {}): ToolError {
  const details: ErrorDetails = { reason, tool }
  if (extra.grant !== undefined) details.grant = extra.grant
  if (extra.bound !== undefined) details.bound = extra.bound
  return new ToolError("forbidden", extra.message ?? DEFAULT_MESSAGES[reason](tool, extra), { details })
}

function isMeasuredStrings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string")
}

function measuredValue(bound: BoundSpec, value: unknown): MeasuredValue | undefined {
  switch (bound.kind) {
    case "max":
      return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
    case "allow":
      return typeof value === "boolean" ? value : undefined
    case "oneOf":
      if (typeof value === "string") return value
      return isMeasuredStrings(value) ? [...value] : undefined
  }
}

/**
 * The values a tool's `measure` returned, when their shape is right: a plain
 * object with exactly the declared bounds, a `max` a finite number of at least
 * 0, an `allow` a boolean and a `oneOf` a string or a non-empty list of
 * strings. Anything else is `undefined`, since a measure that cannot be read
 * covers nothing.
 */
export function measureOf(bounds: ToolBounds, value: unknown): CallMeasure | undefined {
  if (!isRecord(value)) return undefined
  const names = Object.keys(bounds)
  if (Object.keys(value).length !== names.length) return undefined
  const measure: Record<string, MeasuredValue> = {}
  for (const name of names) {
    if (!Object.hasOwn(value, name)) return undefined
    const measured = measuredValue(bounds[name]!, value[name])
    if (measured === undefined) return undefined
    measure[name] = measured
  }
  return measure
}

type CheckInput = {
  call: GrantCall
  bounds: ToolBounds
  grant: Grant
  now: Date
  used(grantId: string): number
}

type Check = (input: CheckInput) => ToolError | undefined

function withinBound(spec: BoundSpec, measured: MeasuredValue, limit: unknown): boolean {
  switch (spec.kind) {
    case "max":
      return typeof measured === "number" && typeof limit === "number" && measured <= limit
    case "allow":
      return typeof measured === "boolean" && typeof limit === "boolean" && (!measured || limit)
    case "oneOf": {
      const values = typeof measured === "string" ? [measured] : measured
      return (
        Array.isArray(values) &&
        Array.isArray(limit) &&
        values.every((value) => typeof value === "string" && limit.includes(value))
      )
    }
  }
}

function coversAnyTarget(grant: Grant): boolean {
  return grant.targets.length === 1 && grant.targets[0] === ANY_TARGET
}

const CHECKS: readonly Check[] = [
  ({ call, grant, now }) => {
    const expiresAt = Date.parse(grant.expires_at)
    if (!(now.getTime() < expiresAt)) {
      return grantRefusal("expired", call.tool, {
        grant: grant.id,
        message: `The grant for ${call.tool} expired at ${grant.expires_at}; a person can delegate it again.`,
      })
    }
  },
  ({ call, grant }) => {
    if (coversAnyTarget(grant)) return
    const covered =
      call.targets.length > 0 && call.targets.every((target) => target !== ANY_TARGET && grant.targets.includes(target))
    if (!covered) return grantRefusal("target", call.tool, { grant: grant.id })
  },
  ({ call, bounds, grant }) => {
    const names = Object.keys(grant.bounds).sort()
    if (names.length === 0) return
    const measure = call.measure
    if (measure === undefined) return grantRefusal("bound", call.tool, { grant: grant.id })
    for (const name of names) {
      const spec = Object.hasOwn(bounds, name) ? bounds[name] : undefined
      const measured = Object.hasOwn(measure, name) ? measure[name] : undefined
      if (spec === undefined || measured === undefined || !withinBound(spec, measured, grant.bounds[name])) {
        return grantRefusal("bound", call.tool, { grant: grant.id, bound: name })
      }
    }
  },
  ({ call, grant, used }) => {
    if (grant.rate !== null && used(grant.id) >= grant.rate) {
      return grantRefusal("rate", call.tool, {
        grant: grant.id,
        message: `The grant for ${call.tool} allows ${grant.rate} calls an hour, and they are used; wait, or a person can delegate a higher rate.`,
      })
    }
  },
]

function compareCovering(a: Grant, b: Grant): number {
  return (
    Number(coversAnyTarget(a)) - Number(coversAnyTarget(b)) ||
    a.targets.length - b.targets.length ||
    Object.keys(b.bounds).length - Object.keys(a.bounds).length ||
    Date.parse(a.expires_at) - Date.parse(b.expires_at) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

/**
 * Finds the grant that covers a call, or says why none does. Each grant that
 * names the tool is checked for expiry, targets, bounds and rate, in that
 * order, and its reason is the first check it fails. A grant for any target
 * (`*` alone) passes the target check for every call, and only the bounds a
 * grant sets are checked. Among the grants that pass every check, one that
 * names its targets is used before a `*` one, then the one with the fewest
 * targets, then the one that sets the most bounds, then the one that expires
 * first, then the smallest id. Otherwise the refusal is the reason of the
 * grant that passed the most checks, the earlier one on a tie, or `no_grant`
 * when no grant names the tool.
 */
export function matchGrant(options: {
  call: GrantCall
  /** The tool's declaration; undefined when it declares none. */
  bounds: ToolBounds | undefined
  grants: readonly Grant[]
  now: Date
  /** How many calls ran under a grant in the last `RATE_WINDOW_MS`. */
  used(grantId: string): number
}): GrantMatch {
  const { call, grants, now, used } = options
  const bounds = options.bounds ?? {}

  let covering: Grant | undefined
  let closest: { passed: number; error: ToolError } | undefined
  for (const grant of grants) {
    if (grant.tool !== call.tool) continue
    const input: CheckInput = { call, bounds, grant, now, used }
    let passed = 0
    let error: ToolError | undefined
    for (const check of CHECKS) {
      error = check(input)
      if (error) break
      passed += 1
    }
    if (!error) {
      if (covering === undefined || compareCovering(grant, covering) < 0) covering = grant
    } else if (closest === undefined || passed > closest.passed) {
      closest = { passed, error }
    }
  }

  if (covering !== undefined) return { covered: true, grant: covering }
  return { covered: false, error: closest?.error ?? grantRefusal("no_grant", call.tool) }
}
