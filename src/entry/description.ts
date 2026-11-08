import { callDescription, type CallDescription, type ToolContext, type ToolSpec } from "../core"

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

/** A description with every label and value, and the text, made `visible`. */
function markedDescription(description: CallDescription): CallDescription {
  const facts = description.facts.map(({ label, value }) => ({ label: visible(label), value: visible(value) }))
  return description.text === undefined ? { facts } : { facts, text: visible(description.text, { keepNewlines: true }) }
}

/**
 * The description of a call for an approval prompt (see `callDescription`),
 * with its characters made `visible`. It gives `undefined` where there is
 * none, and also when describing takes longer than `timeoutMs`, even if the
 * describer ignores its signal. It never throws but for the caller's own
 * cancellation (`ctx.signal`), so the approval is asked either way.
 */
export async function permissionDescription(
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
    return description && markedDescription(description)
  } catch (error) {
    if (outer?.aborted) throw error
    return undefined
  } finally {
    clearTimeout(timer)
    if (onAbort) outer?.removeEventListener("abort", onAbort)
  }
}

/**
 * The whole text of an approval prompt: the header alone without a
 * description, else the header, one line per fact, and after a blank line the
 * text. It does not mark or escape; its inputs come from `permissionDescription`.
 */
export function approvalPrompt(header: string, description: CallDescription | undefined): string {
  if (!description) return header
  const lines = [header, ...description.facts.map(({ label, value }) => `${label}: ${value}`)]
  if (description.text !== undefined) lines.push("", description.text)
  return lines.join("\n")
}
