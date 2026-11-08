/**
 * The facts every package can use in a call's description. A package adds its
 * own in the same form, beside its tools: a function that takes what the tool
 * resolved and returns a `CallFact` with a short noun for a label and a value
 * that carries its unit.
 */
import type { CallFact } from "./tool"

/** The `Size` fact: how many bytes the call writes, as `1 byte` or `42 bytes`. */
export function sizeFact(bytes: number): CallFact {
  return { label: "Size", value: `${bytes} ${bytes === 1 ? "byte" : "bytes"}` }
}
