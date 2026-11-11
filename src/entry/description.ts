import {
  ENGLISH,
  HEADLINE_PLACEHOLDER,
  MAX_LABEL_LENGTH,
  MAX_TEXT_LABEL_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_VALUE_LENGTH,
  MAX_VALUE_TEMPLATE_LENGTH,
  cut,
  cutDescription,
  omittedBy,
  wholeCallDescription,
  type CallDescription,
  type CallHeadline,
  type CallValue,
  type ToolContext,
  type ToolSpec,
  type Translator,
} from "../core"
import { ANY_RESOURCE } from "./permission"
import { visible } from "./visible"
import { ENGLISH_PROMPT_WORDS, charactersLeftOut, factsLeftOut, type PromptWords } from "./words"

/** How long a description may take, in milliseconds, before the prompt goes without one. */
export const DESCRIBE_TIMEOUT_MS = 10_000

/**
 * A fact as the prompt shows it: its value filled in and the characters made
 * `visible`. `omitted` is there only when the value was cut: the code points
 * of the value, as the tool gave it (for a template, the filled and
 * translated value), that the cut to `MAX_VALUE_LENGTH` left out.
 */
export type ShownFact = { label: string; value: string; omitted?: number }

/**
 * A call's text as the prompt shows it. `omitted` is there only when the body
 * was cut: the code points of the body that the cut to `MAX_TEXT_LENGTH` left
 * out.
 */
export type ShownText = { label: string; body: string; omitted?: number }

/**
 * A call's description as the prompt shows it: the headline rendered to one
 * line, the characters made `visible`. `dropped` is there only when the tool
 * gave more than `MAX_FACTS` facts: how many it dropped past them.
 */
export type ShownDescription = { headline?: string; facts: ShownFact[]; dropped?: number; text?: ShownText }

/** The `omitted` property of a shown fact or text: the count when it is above zero, else nothing. */
const omittedOf = (count: number) => (count > 0 ? { omitted: count } : {})

/** Quotes a headline value: `visible`, then `\` and `"` escaped, inside double quotes. */
function quoted(value: string): string {
  return `"${visible(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

/** A template with its literal parts passed through `literal` and every placeholder replaced by `slot` of its name. */
function filled(text: string, literal: (part: string) => string, slot: (name: string) => string): string {
  return text
    .split(HEADLINE_PLACEHOLDER)
    .map((part, index) => (index % 2 === 0 ? literal(part) : slot(part)))
    .join("")
}

/** The headline with its template made `visible` and every placeholder replaced by its quoted value. */
function renderedHeadline({ text, values = {} }: CallHeadline): string {
  return filled(
    text,
    (part) => visible(part),
    (name) => quoted(values[name] ?? ""),
  )
}

/**
 * A fact's whole value as the prompt shows it, with what its cut left out.
 * A string is cut to `MAX_VALUE_LENGTH` code points. A value template is
 * translated, its placeholders are replaced by their values as written
 * (unquoted, uncut, a number by `String`) and the whole is cut the same way.
 * Either is then made `visible`: cutting first never splits a `<U+XXXX>`
 * mark. `omitted` counts the code points of the string, or of the filled
 * template, that the cut dropped.
 */
function renderedValue(value: string | CallValue, t: Translator): Pick<ShownFact, "value" | "omitted"> {
  const whole =
    typeof value === "string"
      ? value
      : filled(
          t.template(value.text, MAX_VALUE_TEMPLATE_LENGTH),
          (part) => part,
          (name) => String(value.values?.[name] ?? ""),
        )
  return { value: visible(cut(whole, MAX_VALUE_LENGTH)), ...omittedOf(omittedBy(whole, MAX_VALUE_LENGTH)) }
}

/**
 * A whole description (see `wholeCallDescription`) as the prompt shows it,
 * cut to the prompt's budgets, with the tool's words (the headline and value
 * templates and the labels) translated, the headline and the values rendered,
 * and every label, value and text made `visible`. The headline and the labels
 * are cut by `cutDescription`; the values and the text are cut here from the
 * whole, so `omitted` counts what the cut left out of them, and `dropped`
 * counts the facts past `MAX_FACTS`. They are the call's data and stay as
 * they are. The `pins` are never shown, so they are never copied.
 */
export function shownDescription(description: CallDescription, t: Translator): ShownDescription {
  const { headline, facts, text } = cutDescription(description)
  const wholeBody = description.text?.body ?? ""
  const dropped = description.facts.length - facts.length
  return {
    ...(headline && { headline: renderedHeadline({ ...headline, text: t.template(headline.text) }) }),
    facts: facts.map((fact, index) => ({
      label: visible(t.word(fact.label, MAX_LABEL_LENGTH)),
      ...renderedValue(description.facts[index]!.value, t),
    })),
    ...(dropped > 0 && { dropped }),
    ...(text && {
      text: {
        label: visible(t.word(text.label, MAX_TEXT_LABEL_LENGTH)),
        body: visible(cut(wholeBody, MAX_TEXT_LENGTH), { keepNewlines: true }),
        ...omittedOf(omittedBy(wholeBody, MAX_TEXT_LENGTH)),
      },
    }),
  }
}

/**
 * The description of a call as the tool gave it, uncut (see
 * `wholeCallDescription`), before translation. It gives `undefined` where
 * there is none, and also when describing takes longer than `timeoutMs`, even
 * if the describer ignores its signal. It never throws but for the caller's
 * own cancellation (`ctx.signal`), so the approval is asked either way.
 */
export async function timedCallDescription(
  spec: Pick<ToolSpec, "input" | "describe">,
  args: unknown,
  ctx: ToolContext,
  timeoutMs: number = DESCRIBE_TIMEOUT_MS,
): Promise<CallDescription | undefined> {
  const outer = ctx.signal
  if (outer?.aborted) throw outer.reason

  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    const timedOut = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        resolve(undefined)
        controller.abort()
      }, timeoutMs)
    })
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => {
        reject(outer?.reason)
        controller.abort(outer?.reason)
      }
      outer?.addEventListener("abort", onAbort, { once: true })
    })
    const description = await Promise.race([
      wholeCallDescription(spec, args, { ...ctx, signal: controller.signal }),
      timedOut,
      cancelled,
    ])
    if (outer?.aborted) throw outer.reason
    return description
  } catch (error) {
    if (outer?.aborted) throw error
    return undefined
  } finally {
    clearTimeout(timer)
    if (onAbort) outer?.removeEventListener("abort", onAbort)
  }
}

/**
 * The description of a call for an approval prompt (see `timedCallDescription`),
 * as the prompt shows it: the tool's words translated through `t`, the
 * headline rendered, the characters made `visible`. It gives `undefined`
 * where there is none, and never throws but for the caller's own
 * cancellation, so the approval is asked either way.
 */
export async function permissionDescription(
  spec: Pick<ToolSpec, "input" | "describe">,
  args: unknown,
  ctx: ToolContext,
  timeoutMs: number = DESCRIBE_TIMEOUT_MS,
  t: Translator = ENGLISH,
): Promise<ShownDescription | undefined> {
  const description = await timedCallDescription(spec, args, ctx, timeoutMs)
  return description && shownDescription(description, t)
}

/** The line that opens a section of the prompt. */
const sectionHeading = (name: string) => `--- ${name} ---`

/** The line a prompt shows where no headline stands: the tool's intent, else its title, translated through `t`. */
export function standIn(spec: Pick<ToolSpec, "title" | "intent">, t: Translator): string {
  return t.word(spec.intent ?? spec.title)
}

/**
 * The whole text of an approval prompt, in the one shape of every native
 * plugin: the headline (`firstLine`, the stand-in, without one); a Details section with a
 * `Target` line per resource, unless the only resource is `*` (what cannot be
 * told), then one line per fact and the notice of the facts dropped past the
 * eighth (`factsLeftOut`), if any; and a section of the text under its own
 * label. A section with nothing to show is left out. A fact whose value was
 * cut ends its line with the notice of the characters left out, and a cut
 * text is followed by the same notice on a line of its own (see
 * `charactersLeftOut`). The stand-in is the caller's, already translated (see
 * `standIn`); `words` are the plugin's own words (see `promptWords`). The
 * stand-in and the resources are made `visible` here; the description comes
 * from `permissionDescription`, which has done the same.
 */
export function approvalPrompt(
  firstLine: string,
  resources: string[],
  description: ShownDescription | undefined,
  words: PromptWords = ENGLISH_PROMPT_WORDS,
): string {
  const targets =
    resources.length === 1 && resources[0] === ANY_RESOURCE
      ? []
      : resources.map((resource) => `${words.target}: ${visible(resource)}`)
  const facts = (description?.facts ?? []).map(
    ({ label, value, omitted }) => `${label}: ${value}${omitted ? ` ${charactersLeftOut(omitted, words)}` : ""}`,
  )
  const dropped = description?.dropped ? [factsLeftOut(description.dropped, words)] : []
  const details = [...targets, ...facts, ...dropped]

  const lines = [description?.headline ?? visible(firstLine)]
  if (details.length > 0) lines.push("", sectionHeading(words.details), "", ...details)
  if (description?.text) {
    const { label, body, omitted } = description.text
    lines.push("", sectionHeading(label), "", body)
    if (omitted) lines.push(charactersLeftOut(omitted, words))
  }
  return lines.join("\n")
}
