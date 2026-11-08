import { isAbortError } from "./errors"
import type { CallDescription, CallFact, CallHeadline, CallText, ToolContext, ToolSpec } from "./tool"

/** How many facts an approval description keeps. */
export const MAX_FACTS = 8
/** The code point budget of a fact's label, including an ellipsis when cut. */
export const MAX_LABEL_LENGTH = 40
/** The code point budget of a fact's value, including an ellipsis when cut. */
export const MAX_VALUE_LENGTH = 200
/** The code point budget of the text's label, including an ellipsis when cut. */
export const MAX_TEXT_LABEL_LENGTH = 40
/** The code point budget of the text, including an ellipsis when cut. */
export const MAX_TEXT_LENGTH = 2000
/** The code point budget of a headline template; a longer one is dropped, since cutting could split a placeholder. */
export const MAX_HEADLINE_LENGTH = 120
/** How many values a headline may carry; a headline with more is dropped. */
export const MAX_HEADLINE_VALUES = 8
/** The code point budget of a headline value, including an ellipsis when cut. */
export const MAX_HEADLINE_VALUE_LENGTH = 80

/**
 * A `{name}` placeholder of a headline template, with its name captured, so
 * splitting a template on it gives literal text at the even indices and
 * placeholder names at the odd ones.
 */
export const HEADLINE_PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/

/** Keeps a string within its code point budget without splitting a surrogate pair. */
function cut(text: string, limit: number): string {
  const points = Array.from(text)
  return points.length > limit ? `${points.slice(0, limit - 1).join("")}…` : text
}

/** Whether a value is a plain object: not an array, a date or a class instance. */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Whether a fact has a nonblank label and a text value. */
function isFact(fact: unknown): fact is CallFact {
  return (
    typeof fact === "object" &&
    fact !== null &&
    !Array.isArray(fact) &&
    "label" in fact &&
    typeof fact.label === "string" &&
    fact.label.trim() !== "" &&
    "value" in fact &&
    typeof fact.value === "string"
  )
}

/** Whether the text has a nonblank label and a text body. */
function isText(text: unknown): text is CallText {
  return isRecord(text) && typeof text.label === "string" && text.label.trim() !== "" && typeof text.body === "string"
}

/**
 * The headline when it is well formed, else `undefined`: a nonblank template
 * within its budget whose every brace belongs to a `{name}` placeholder that
 * has a string value, with at most `MAX_HEADLINE_VALUES` values. A bad
 * headline falls back to the title and never voids the rest of the
 * description.
 */
function headlineOf(headline: unknown): CallHeadline | undefined {
  if (!isRecord(headline) || typeof headline.text !== "string") return undefined
  const { text, values } = headline
  if (text.trim() === "" || Array.from(text).length > MAX_HEADLINE_LENGTH) return undefined
  if (values !== undefined && !isRecord(values)) return undefined

  const entries = Object.entries(values ?? {})
  if (entries.length > MAX_HEADLINE_VALUES) return undefined
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) return undefined
  const given = new Set(entries.map(([name]) => name))
  const wellFormed = text
    .split(HEADLINE_PLACEHOLDER)
    .every((part, index) => (index % 2 === 0 ? !/[{}]/.test(part) : given.has(part)))
  if (!wellFormed) return undefined

  const cutValues = entries.map(([name, value]) => [name, cut(value, MAX_HEADLINE_VALUE_LENGTH)] as const)
  return values === undefined ? { text } : { text, values: Object.fromEntries(cutValues) }
}

/**
 * What a call will do, as an optional headline, short facts and an optional
 * text, within their code point budgets. A tool without a describer,
 * arguments the input schema rejects, a describer that fails, an answer of
 * another shape (a bad fact or text included) and an answer with no headline,
 * facts or text all give `undefined`, leaving approval to proceed without a
 * description. A bad headline alone is dropped, so the title stands in its
 * place. A cancellation is never turned into `undefined`; it is rethrown.
 */
export async function callDescription(
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

  const facts = entries.slice(0, MAX_FACTS).map(({ label, value }) => ({
    label: cut(label, MAX_LABEL_LENGTH),
    value: cut(value, MAX_VALUE_LENGTH),
  }))
  const headline = answer.headline === undefined ? undefined : headlineOf(answer.headline)
  const text =
    answer.text === undefined || answer.text.body === ""
      ? undefined
      : { label: cut(answer.text.label, MAX_TEXT_LABEL_LENGTH), body: cut(answer.text.body, MAX_TEXT_LENGTH) }
  if (headline === undefined && facts.length === 0 && text === undefined) return undefined
  return { ...(headline && { headline }), facts, ...(text && { text }) }
}
