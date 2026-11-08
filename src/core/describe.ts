import { isAbortError } from "./errors"
import type { CallDescription, CallFact, ToolContext, ToolSpec } from "./tool"

/** How many facts an approval description keeps. */
export const MAX_FACTS = 8
/** The code point budget of a fact's label, including an ellipsis when cut. */
export const MAX_LABEL_LENGTH = 40
/** The code point budget of a fact's value, including an ellipsis when cut. */
export const MAX_VALUE_LENGTH = 200
/** The code point budget of the free text, including an ellipsis when cut. */
export const MAX_TEXT_LENGTH = 2000

/** Keeps a string within its code point budget without splitting a surrogate pair. */
function cut(text: string, limit: number): string {
  const points = Array.from(text)
  return points.length > limit ? `${points.slice(0, limit - 1).join("")}…` : text
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

/**
 * What a call will do, as short facts followed by optional free text, within
 * their code point budgets. A tool without a describer, arguments the input
 * schema rejects, a describer that fails, an answer of another shape and an
 * answer with no facts or text all give `undefined`, leaving approval to
 * proceed without a description. A cancellation is never turned into
 * `undefined`; it is rethrown.
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
  if (typeof answer !== "object" || answer === null) return undefined
  const prototype = Object.getPrototypeOf(answer)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  if (!("facts" in answer) || !Array.isArray(answer.facts)) return undefined
  const entries: unknown[] = Array.from(answer.facts)
  if (!entries.every(isFact)) return undefined
  if ("text" in answer && answer.text !== undefined && typeof answer.text !== "string") return undefined

  const facts = entries.slice(0, MAX_FACTS).map(({ label, value }) => ({
    label: cut(label, MAX_LABEL_LENGTH),
    value: cut(value, MAX_VALUE_LENGTH),
  }))
  const text = "text" in answer && typeof answer.text === "string" ? cut(answer.text, MAX_TEXT_LENGTH) : ""
  if (facts.length === 0 && text === "") return undefined
  return text === "" ? { facts } : { facts, text }
}
