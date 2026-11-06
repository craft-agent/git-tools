import { SetupError } from "./errors.mjs"

const MARKER_LINE = /^<!-- (\/?)(starter|example) -->$/

/**
 * Removes the marked blocks of a Markdown file: `<!-- starter -->` to `<!-- /starter -->` always, with their
 * content; `<!-- example -->` to `<!-- /example -->` too, unless `keepExample`, which drops only the two markers.
 * A file with a block loses the blank lines the block leaves behind. `label` names the file in an error for
 * unbalanced markers. Returns `{ text, count }`, `count` being the blocks found.
 */
export function removeMarkedBlocks(text, { keepExample }, label) {
  const unbalanced = (line, why) => new SetupError(`${label}:${line}: ${why}; markers must come in balanced pairs.`)
  const kept = []
  let open = null
  let count = 0
  text.split("\n").forEach((line, index) => {
    const marker = MARKER_LINE.exec(line.trim())
    if (!marker) {
      if (open === null || (open === "example" && keepExample)) kept.push(line)
      return
    }
    const [, closing, kind] = marker
    if (!closing) {
      if (open !== null) throw unbalanced(index + 1, `\`${kind}\` opens inside \`${open}\``)
      open = kind
    } else {
      if (open !== kind) throw unbalanced(index + 1, `\`/${kind}\` closes ${open === null ? "nothing" : `\`${open}\``}`)
      open = null
      count++
    }
  })
  if (open !== null) throw unbalanced(text.split("\n").length, `\`${open}\` is never closed`)
  if (count === 0) return { text, count }
  return {
    text: kept
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/\n+$/, "\n"),
    count,
  }
}
