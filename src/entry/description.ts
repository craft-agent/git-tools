import {
  HEADLINE_PLACEHOLDER,
  callDescription,
  type CallDescription,
  type CallFact,
  type CallHeadline,
  type CallText,
  type ToolContext,
  type ToolSpec,
} from "../core"
import { ANY_RESOURCE } from "./permission"

/** How long a description may take, in milliseconds, before the prompt goes without one. */
export const DESCRIBE_TIMEOUT_MS = 10_000

/** The code points shown as a mark: control, format, separators, lone surrogates and the default-ignorable code points (such as variation selectors and the Hangul fillers). */
const HIDDEN =
  "\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Cs}\\u{00AD}\\u{034F}\\u{061C}\\u{115F}-\\u{1160}\\u{17B4}-\\u{17B5}\\u{180B}-\\u{180F}\\u{200B}-\\u{200F}\\u{202A}-\\u{202E}\\u{2060}-\\u{206F}\\u{3164}\\u{FE00}-\\u{FE0F}\\u{FEFF}\\u{FFA0}\\u{FFF0}-\\u{FFF8}\\u{1BCA0}-\\u{1BCA3}\\u{1D173}-\\u{1D17A}\\u{E0000}-\\u{E0FFF}"
const HIDDEN_ALL = new RegExp(`[${HIDDEN}]`, "gu")
const HIDDEN_EXCEPT_NEWLINE = new RegExp(`(?!\\n)[${HIDDEN}]`, "gu")

/** The width a code point's hex digits are padded to in its mark. */
const MARK_DIGITS = 4

/** The visible mark of one code point, such as `<U+202E>`. */
function mark(character: string): string {
  const hex = character.codePointAt(0)!.toString(16).toUpperCase()
  return `<U+${hex.padStart(MARK_DIGITS, "0")}>`
}

/**
 * Shows every code point another person could use to forge a line or hide
 * part of a value as `<U+XXXX>`: control, format, separators, lone surrogates
 * and the default-ignorable code points (such as variation selectors and the Hangul fillers).
 * Ordinary spaces and all visible text stay. With `keepNewlines`, `\r\n`
 * becomes `\n` and `\n` stays; any other `\r` is marked.
 */
export function visible(text: string, options: { keepNewlines?: boolean } = {}): string {
  if (options.keepNewlines) return text.replace(/\r\n/g, "\n").replace(HIDDEN_EXCEPT_NEWLINE, mark)
  return text.replace(HIDDEN_ALL, mark)
}

/** A call's description as the prompt shows it: the headline rendered to one line, the characters made `visible`. */
export type ShownDescription = { headline?: string; facts: CallFact[]; text?: CallText }

/** Quotes a headline value: `visible`, then `\` and `"` escaped, inside double quotes. */
function quoted(value: string): string {
  return `"${visible(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

/** The headline with its template made `visible` and every placeholder replaced by its quoted value. */
function renderedHeadline({ text, values = {} }: CallHeadline): string {
  return text
    .split(HEADLINE_PLACEHOLDER)
    .map((part, index) => (index % 2 === 0 ? visible(part) : quoted(values[part] ?? "")))
    .join("")
}

/** A description with the headline rendered, and every label, value and text made `visible`. */
function shownDescription({ headline, facts, text }: CallDescription): ShownDescription {
  return {
    ...(headline && { headline: renderedHeadline(headline) }),
    facts: facts.map((fact) => ({ label: visible(fact.label), value: visible(fact.value) })),
    ...(text && { text: { label: visible(text.label), body: visible(text.body, { keepNewlines: true }) } }),
  }
}

/**
 * The description of a call for an approval prompt (see `callDescription`),
 * as the prompt shows it: the headline rendered, the characters made
 * `visible`. It gives `undefined` where there is none, and also when
 * describing takes longer than `timeoutMs`, even if the describer ignores its
 * signal. It never throws but for the caller's own cancellation
 * (`ctx.signal`), so the approval is asked either way.
 */
export async function permissionDescription(
  spec: Pick<ToolSpec, "input" | "describe">,
  args: unknown,
  ctx: ToolContext,
  timeoutMs: number = DESCRIBE_TIMEOUT_MS,
): Promise<ShownDescription | undefined> {
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
    return description && shownDescription(description)
  } catch (error) {
    if (outer?.aborted) throw error
    return undefined
  } finally {
    clearTimeout(timer)
    if (onAbort) outer?.removeEventListener("abort", onAbort)
  }
}

/** The name of the prompt's section that lists the targets and the facts; the plugin's own word, in English. */
export const DETAILS_HEADING = "Details"

/** The label of a target's line in the Details; the plugin's own word, in English. */
export const TARGET_LABEL = "Target"

/** The line that opens a section of the prompt. */
const sectionHeading = (name: string) => `--- ${name} ---`

/**
 * The whole text of an approval prompt, in the one shape of every native
 * plugin: the headline (the title without one); a Details section with a
 * `Target` line per resource, unless the only resource is `*` (what cannot be
 * told), then one line per fact; and a section of the text under its own
 * label. A section with nothing to show is left out. The resources are made
 * `visible` here; the description comes from `permissionDescription`, which
 * has done the same.
 */
export function approvalPrompt(title: string, resources: string[], description: ShownDescription | undefined): string {
  const targets =
    resources.length === 1 && resources[0] === ANY_RESOURCE
      ? []
      : resources.map((resource) => `${TARGET_LABEL}: ${visible(resource)}`)
  const details = [...targets, ...(description?.facts ?? []).map(({ label, value }) => `${label}: ${value}`)]

  const lines = [description?.headline ?? title]
  if (details.length > 0) lines.push("", sectionHeading(DETAILS_HEADING), "", ...details)
  if (description?.text) lines.push("", sectionHeading(description.text.label), "", description.text.body)
  return lines.join("\n")
}
