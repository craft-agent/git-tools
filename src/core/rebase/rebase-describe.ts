import type { CallFact } from "../tool"

/** The separator between the branches of the `Layers` fact, bottom to top. */
const LAYER_SEPARATOR = " → "

/** The `Layers` fact: the branches a rebase moves or puts back, bottom to top; the description cuts a long list to fit. */
export function layersFact(branches: string[]): CallFact {
  return { label: "Layers", value: branches.join(LAYER_SEPARATOR) }
}
