import {
  ENGLISH,
  HEADLINE_PLACEHOLDER,
  MAX_LABEL_LENGTH,
  MAX_TEXT_LABEL_LENGTH,
  MAX_VALUE_LENGTH,
  MAX_VALUE_TEMPLATE_LENGTH,
  callDescription,
  cut,
  type CallDescription,
  type CallHeadline,
  type CallText,
  type CallValue,
  type ToolContext,
  type ToolSpec,
  type Translator,
} from "../core"
import { ANY_RESOURCE } from "./permission"
import { visible } from "./visible"
import { ENGLISH_PROMPT_WORDS, type PromptWords } from "./words"

/** How long a description may take, in milliseconds, before the prompt goes without one. */
export const DESCRIBE_TIMEOUT_MS = 10_000

/** A fact as the prompt shows it: its value filled in and the characters made `visible`. */
export type ShownFact = { label: string; value: string }

/** A call's description as the prompt shows it: the headline rendered to one line, the characters made `visible`. */
export type ShownDescription = { headline?: string; facts: ShownFact[]; text?: CallText }

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
 * A fact's value as the prompt shows it. A string is made `visible`. A value
 * template is translated, its placeholders are replaced by their values as
 * written (unquoted, a number by `String`), the whole is cut to
 * `MAX_VALUE_LENGTH` code points and then made `visible`: cutting the filled
 * value first never splits a `<U+XXXX>` mark.
 */
function renderedValue(value: string | CallValue, t: Translator): string {
  if (typeof value === "string") return visible(value)
  const { text, values = {} } = value
  const shown = filled(
    t.template(text, MAX_VALUE_TEMPLATE_LENGTH),
    (part) => part,
    (name) => String(values[name] ?? ""),
  )
  return visible(cut(shown, MAX_VALUE_LENGTH))
}

/**
 * A description with the tool's words (the headline and value templates and
 * the labels) translated, the headline and the values rendered, and every
 * label, value and text made `visible`. The values and the text are the
 * call's data and stay as they are. The `pins` are never shown, so they are
 * never copied.
 */
export function shownDescription({ headline, facts, text }: CallDescription, t: Translator): ShownDescription {
  return {
    ...(headline && { headline: renderedHeadline({ ...headline, text: t.template(headline.text) }) }),
    facts: facts.map((fact) => ({
      label: visible(t.word(fact.label, MAX_LABEL_LENGTH)),
      value: renderedValue(fact.value, t),
    })),
    ...(text && {
      text: {
        label: visible(t.word(text.label, MAX_TEXT_LABEL_LENGTH)),
        body: visible(text.body, { keepNewlines: true }),
      },
    }),
  }
}

/**
 * The description of a call as the tool gave it (see `callDescription`),
 * before translation. It gives `undefined` where there is none, and also when
 * describing takes longer than `timeoutMs`, even if the describer ignores its
 * signal. It never throws but for the caller's own cancellation
 * (`ctx.signal`), so the approval is asked either way.
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
      callDescription(spec, args, { ...ctx, signal: controller.signal }),
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
 * told), then one line per fact; and a section of the text under its own
 * label. A section with nothing to show is left out. The stand-in is the
 * caller's, already translated (see `standIn`); `words` are the plugin's own
 * words (see `promptWords`). The stand-in and the resources are made
 * `visible` here; the description comes from `permissionDescription`, which
 * has done the same.
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
  const details = [...targets, ...(description?.facts ?? []).map(({ label, value }) => `${label}: ${value}`)]

  const lines = [description?.headline ?? visible(firstLine)]
  if (details.length > 0) lines.push("", sectionHeading(words.details), "", ...details)
  if (description?.text) lines.push("", sectionHeading(description.text.label), "", description.text.body)
  return lines.join("\n")
}
