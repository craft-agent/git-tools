import { isAbortError } from "./errors"
import type { CallDescription, CallFact, CallText, ToolContext, ToolSpec } from "./tool"

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
 * What a call will do, as short facts and an optional text, within their code
 * point budgets. A tool without a describer, arguments the input schema
 * rejects, a describer that fails, an answer of another shape (a bad fact or
 * text included) and an answer with no facts or text all give `undefined`,
 * leaving approval to proceed without a description. A cancellation is never
 * turned into `undefined`; it is rethrown.
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
  const text =
    answer.text === undefined || answer.text.body === ""
      ? undefined
      : { label: cut(answer.text.label, MAX_TEXT_LABEL_LENGTH), body: cut(answer.text.body, MAX_TEXT_LENGTH) }
  if (facts.length === 0 && text === undefined) return undefined
  return text === undefined ? { facts } : { facts, text }
}
