import { isAbortError } from "./errors"
import type { CallDescription, CallFact, CallHeadline, CallText, CallValue, ToolContext, ToolSpec } from "./tool"

/** How many facts an approval description keeps. */
export const MAX_FACTS = 8
/** The code point budget of a fact's label, including an ellipsis when cut. */
export const MAX_LABEL_LENGTH = 40
/** The code point budget of a fact's value, including an ellipsis when cut. */
export const MAX_VALUE_LENGTH = 200
/** The code point budget of a fact's value template; a longer one is invalid, since cutting could split a placeholder. */
export const MAX_VALUE_TEMPLATE_LENGTH = 200
/** The code point budget of the text's label, including an ellipsis when cut. */
export const MAX_TEXT_LABEL_LENGTH = 40
/** The code point budget of the text, including an ellipsis when cut. */
export const MAX_TEXT_LENGTH = 2000
/** The code point budget of a headline template; a longer one is dropped, since cutting could split a placeholder. */
export const MAX_HEADLINE_LENGTH = 120
/** How many values a headline or a fact's value template may carry; one with more is bad. */
export const MAX_HEADLINE_VALUES = 8
/** The code point budget of a headline value, including an ellipsis when cut. */
export const MAX_HEADLINE_VALUE_LENGTH = 80
/** How many pins a description may carry; one with more is bad. */
export const MAX_PINS = 16

/**
 * A `{name}` placeholder of a headline template, with its name captured, so
 * splitting a template on it gives literal text at the even indices and
 * placeholder names at the odd ones.
 */
export const HEADLINE_PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/

/** Keeps a string within its code point budget without splitting a surrogate pair. */
export function cut(text: string, limit: number): string {
  const points = Array.from(text)
  return points.length > limit ? `${points.slice(0, limit - 1).join("")}…` : text
}

/** The placeholder names of a template whose every brace belongs to a `{name}` placeholder, else `undefined`. */
export function templatePlaceholders(text: string): Set<string> | undefined {
  const names = new Set<string>()
  const parts = text.split(HEADLINE_PLACEHOLDER)
  for (const [index, part] of parts.entries()) {
    if (index % 2 === 1) names.add(part)
    else if (/[{}]/.test(part)) return undefined
  }
  return names
}

/** Whether a value is a plain object: not an array, a date or a class instance. */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** The entries of a template's values, none when they are absent, else `undefined` when they are not a plain record of at most `MAX_HEADLINE_VALUES`. */
function valueEntries(values: unknown): [string, unknown][] | undefined {
  if (values === undefined) return []
  if (!isRecord(values)) return undefined
  const entries = Object.entries(values)
  return entries.length > MAX_HEADLINE_VALUES ? undefined : entries
}

/** Whether a template is nonblank, within its code point budget, well formed, and has a value for every placeholder. */
function isTemplate(text: string, limit: number, entries: [string, unknown][]): boolean {
  if (text.trim() === "" || Array.from(text).length > limit) return false
  const given = new Set(entries.map(([name]) => name))
  const placeholders = templatePlaceholders(text)
  return placeholders !== undefined && [...placeholders].every((name) => given.has(name))
}

/** Whether a value is a string or a finite number. */
function isTemplateValue(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
}

/** Whether a fact's value is a template within `MAX_VALUE_TEMPLATE_LENGTH` whose values are strings or finite numbers. */
function isCallValue(value: unknown): value is CallValue {
  if (!isRecord(value) || typeof value.text !== "string") return false
  const entries = valueEntries(value.values)
  return (
    entries !== undefined &&
    entries.every(([, entry]) => isTemplateValue(entry)) &&
    isTemplate(value.text, MAX_VALUE_TEMPLATE_LENGTH, entries)
  )
}

/** Whether a fact has a nonblank label and a value that is a string or a well formed template. */
function isFact(fact: unknown): fact is CallFact {
  return (
    typeof fact === "object" &&
    fact !== null &&
    !Array.isArray(fact) &&
    "label" in fact &&
    typeof fact.label === "string" &&
    fact.label.trim() !== "" &&
    "value" in fact &&
    (typeof fact.value === "string" || isCallValue(fact.value))
  )
}

/** A fact's value within its budgets: a string cut, a template kept with its string values cut and its numbers kept. */
function cutValue(value: string | CallValue): string | CallValue {
  if (typeof value === "string") return cut(value, MAX_VALUE_LENGTH)
  const { text, values } = value
  if (values === undefined) return { text }
  const cutValues = Object.entries(values).map(
    ([name, entry]) => [name, typeof entry === "string" ? cut(entry, MAX_VALUE_LENGTH) : entry] as const,
  )
  return { text, values: Object.fromEntries(cutValues) }
}

/** Whether the text has a nonblank label and a text body. */
function isText(text: unknown): text is CallText {
  return isRecord(text) && typeof text.label === "string" && text.label.trim() !== "" && typeof text.body === "string"
}

/** The pins of an answer when they are a plain record of at most `MAX_PINS` nonblank names with string values, none when absent or empty, else `undefined`. */
function pinsOf(pins: unknown): { pins?: Record<string, string> } | undefined {
  if (pins === undefined) return {}
  if (!isRecord(pins)) return undefined
  const entries = Object.entries(pins)
  if (entries.length > MAX_PINS) return undefined
  if (!entries.every((entry): entry is [string, string] => entry[0].trim() !== "" && typeof entry[1] === "string")) {
    return undefined
  }
  return entries.length === 0 ? {} : { pins: Object.fromEntries(entries) }
}

/** A fact's value as a fresh copy, uncut: a string as it is, a template with its own copy of the values. */
function copyValue(value: string | CallValue): string | CallValue {
  if (typeof value === "string") return value
  const { text, values } = value
  return values === undefined ? { text } : { text, values: { ...values } }
}

/**
 * The headline, uncut, when it is well formed, else `undefined`: a nonblank
 * template within its budget whose every brace belongs to a `{name}`
 * placeholder that has a string value, with at most `MAX_HEADLINE_VALUES`
 * values. A bad headline falls back to the title and never voids the rest of
 * the description.
 */
function headlineOf(headline: unknown): CallHeadline | undefined {
  if (!isRecord(headline) || typeof headline.text !== "string") return undefined
  const { text, values } = headline
  const entries = valueEntries(values)
  if (entries === undefined || !isTemplate(text, MAX_HEADLINE_LENGTH, entries)) return undefined
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) return undefined

  return values === undefined ? { text } : { text, values: Object.fromEntries(entries) }
}

/** A headline with its values cut to `MAX_HEADLINE_VALUE_LENGTH`, its template kept. */
function cutHeadline({ text, values }: CallHeadline): CallHeadline {
  if (values === undefined) return { text }
  const cutValues = Object.entries(values).map(
    ([name, value]) => [name, cut(value, MAX_HEADLINE_VALUE_LENGTH)] as const,
  )
  return { text, values: Object.fromEntries(cutValues) }
}

/**
 * A description kept within the prompt's code point budgets: the first
 * `MAX_FACTS` facts, every label, value, headline value and the text cut to
 * theirs. The pins are kept as they are. It cuts what is already cut to the
 * same result.
 */
export function cutDescription({ headline, facts, text, pins }: CallDescription): CallDescription {
  return {
    ...(headline && { headline: cutHeadline(headline) }),
    facts: facts.slice(0, MAX_FACTS).map(({ label, value }) => ({
      label: cut(label, MAX_LABEL_LENGTH),
      value: cutValue(value),
    })),
    ...(text && { text: { label: cut(text.label, MAX_TEXT_LABEL_LENGTH), body: cut(text.body, MAX_TEXT_LENGTH) } }),
    ...(pins && { pins }),
  }
}

/**
 * What a call carries, which the pin takes: an optional headline, facts and
 * an optional text, all uncut and every fact kept. A tool without a
 * describer, arguments the input schema rejects, a describer that fails, an
 * answer of another shape (a bad fact, text or pins included) and an answer
 * with no headline, facts or text (pins alone show nothing) all give
 * `undefined`, leaving approval to proceed without a description. A bad
 * headline alone is dropped, so the title stands in its place. The pins, at
 * most `MAX_PINS` nonblank names with string values, are kept as given, and
 * none when empty. A cancellation is never turned into `undefined`; it is
 * rethrown.
 */
export async function wholeCallDescription(
  spec: Pick<ToolSpec, "input" | "describe">,
  args: unknown,
  ctx: ToolContext,
): Promise<CallDescription | undefined> {
  if (!spec.describe) return undefined
  const parsed = spec.input.strict().safeParse(args)
  if (!parsed.success) return undefined

  let answer: unknown
  try {
    answer = await spec.describe(parsed.data, ctx)
  } catch (error) {
    if (isAbortError(error) || ctx.signal?.aborted) throw error
    return undefined
  }
  if (!isRecord(answer)) return undefined
  if (!("facts" in answer) || !Array.isArray(answer.facts)) return undefined
  const entries: unknown[] = Array.from(answer.facts)
  if (!entries.every(isFact)) return undefined
  if (answer.text !== undefined && !isText(answer.text)) return undefined
  const kept = pinsOf(answer.pins)
  if (kept === undefined) return undefined

  const facts = entries.map(({ label, value }) => ({ label, value: copyValue(value) }))
  const headline = answer.headline === undefined ? undefined : headlineOf(answer.headline)
  const text =
    answer.text === undefined || answer.text.body === ""
      ? undefined
      : { label: answer.text.label, body: answer.text.body }
  if (headline === undefined && facts.length === 0 && text === undefined) return undefined
  return { ...(headline && { headline }), facts, ...(text && { text }), ...kept }
}

/**
 * What the prompt shows of a call: `wholeCallDescription` cut to the prompt's
 * code point budgets (see `cutDescription`). It gives `undefined` wherever
 * the whole description does.
 */
export async function callDescription(
  spec: Pick<ToolSpec, "input" | "describe">,
  args: unknown,
  ctx: ToolContext,
): Promise<CallDescription | undefined> {
  const whole = await wholeCallDescription(spec, args, ctx)
  return whole && cutDescription(whole)
}
