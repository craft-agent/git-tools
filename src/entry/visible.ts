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
