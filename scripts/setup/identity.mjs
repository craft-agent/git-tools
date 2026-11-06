/** What the starter calls itself; the setup replaces each of these. */
export const STARTER = {
  scope: "@craftsamo",
  name: "agent-tool-starter",
  owner: "craftsamo",
  prefix: "example",
}

/** A name in snake_case: `widget-tools` is `widget_tools`. */
export const toSnake = (name) => name.replaceAll("-", "_")

/** A name in SCREAMING_SNAKE_CASE: `widget-tools` is `WIDGET_TOOLS`. */
export const toScreamingSnake = (name) => toSnake(name).toUpperCase()

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * A tool ID or permission glob starting with the starter's prefix (`example_note_read`, `example_*`),
 * also behind underscores (`mcp__server__example_*`), but not inside a word (`exampleNoteRead`).
 */
const PREFIXED_ID = String.raw`(?<![A-Za-z0-9])${STARTER.prefix}_(?=[a-z*])`

/** Files whose strings are JSON or YAML double-quoted strings: a replacement there is escaped like one. */
const QUOTED_STRING_FILE = /\.(?:json|ya?ml)$/

/** Whether a replacement text going into `path` must be escaped as a JSON string's content. */
export const isQuotedStringFile = (path) => QUOTED_STRING_FILE.test(path)

/**
 * The replacement table for a run: each old text (`from`, `source` as a regular expression) with its new text
 * (`to`, and `escapedTo` inside a JSON or YAML string). Longer texts come first, so the one that starts earliest
 * and is longest wins at every position and a partial match never leaves a half-renamed name.
 */
export function deriveIdentity(options, starterDescription) {
  const { name, owner, repo, scope, marketplace, prefix, description } = options
  const literals = [
    [`${STARTER.scope}/${STARTER.name}`, `${scope}/${name}`],
    [`io.github.${STARTER.owner}/${STARTER.name}`, `io.github.${owner}/${repo}`],
    [`${STARTER.owner}/${STARTER.name}`, `${owner}/${repo}`],
    [`${STARTER.owner}-${STARTER.name}`, `${scope.slice(1)}-${name}`],
    [`${STARTER.name}@${STARTER.owner}`, `${name}@${marketplace}`],
    [toScreamingSnake(STARTER.name), toScreamingSnake(name)],
    [toSnake(STARTER.name), toSnake(name)],
    [STARTER.name, name],
    [`${STARTER.prefix}-notes`, `${prefix}-notes`],
  ]
    .map(([from, to]) => ({ from, source: escapeRegExp(from), to, escapedTo: to }))
    .sort((a, b) => b.from.length - a.from.length)
  const descriptionEntry = {
    from: starterDescription,
    source: escapeRegExp(starterDescription),
    to: description,
    escapedTo: JSON.stringify(description).slice(1, -1),
  }
  const prefixEntry = { from: `${STARTER.prefix}_`, source: PREFIXED_ID, to: `${prefix}_`, escapedTo: `${prefix}_` }
  return [descriptionEntry, ...literals, prefixEntry].sort((a, b) => b.from.length - a.from.length)
}

/**
 * A function `(text, quoted) => { text, count }` applying the whole table in one pass, so a replacement is never
 * itself replaced again; `quoted` selects the escaped replacement texts.
 */
export function createReplacer(entries) {
  const pattern = new RegExp(entries.map((entry) => `(${entry.source})`).join("|"), "g")
  return (text, quoted = false) => {
    let count = 0
    const replaced = text.replace(pattern, (...args) => {
      const entry = entries[args.slice(1).findIndex((group) => group !== undefined)]
      count++
      return quoted ? entry.escapedTo : entry.to
    })
    return { text: replaced, count }
  }
}
