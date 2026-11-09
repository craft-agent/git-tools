/**
 * The facts every package can use in a call's description. A package adds its
 * own in the same form, beside its tools: a function that takes what the tool
 * resolved and returns a `CallFact` with a short noun for a label and a value
 * that carries its unit through a template (`{bytes} bytes` with the number as
 * a value), so the unit can be translated and the number never is.
 */
import type { CallFact } from "./tool"
import type { Translations } from "./words"

/** The `Size` fact: how many bytes the call writes, as `1 byte` or `42 bytes`. */
export function sizeFact(bytes: number): CallFact {
  return { label: "Size", value: { text: bytes === 1 ? "{bytes} byte" : "{bytes} bytes", values: { bytes } } }
}

/** The translations of the label and the value templates of the facts above. */
export const FACT_TRANSLATIONS: Translations = {
  ja: { Size: "サイズ", "{bytes} byte": "{bytes} バイト", "{bytes} bytes": "{bytes} バイト" },
}
