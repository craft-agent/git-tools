import { SetupError } from "./errors.mjs"

/**
 * `"name": "craftsamo", "url": "https://github.com/craftsamo"` inside an `author` or `owner` object, as the
 * manifests write it.
 */
const PERSON_OBJECT = /("(?:author|owner)": \{\s*"name": )"craftsamo"(,\s*"url": )"https:\/\/github\.com\/craftsamo"/g

const json = JSON.stringify

/** Replaces the person object of a manifest with the author and the owner's URL. */
const person = [
  PERSON_OBJECT,
  (o, name, url) => `${name}${json(o.author)}${url}${json(`https://github.com/${o.owner}`)}`,
]

const marketplaceName = [/^(  "name": )"craftsamo"/gm, (o, key) => `${key}${json(o.marketplace)}`]

/**
 * The places where the starter's own marketplace name, author or owner stands, by file: each `[pattern, build]`
 * must match, and `build(options, ...groups)` gives its replacement. These are edited exactly where they are,
 * never by replacing `craftsamo` everywhere: that is also the `@craftsamo/repo-kit` dependency and the
 * `craftsamo/repo-kit` workflows, which stay.
 */
const SPOTS = {
  "plugin.json": [person],
  ".claude-plugin/plugin.json": [person],
  ".antigravity-plugin/plugin.json": [person],
  ".claude-plugin/marketplace.json": [
    person,
    marketplaceName,
    [/"Plugins by craftsamo\."/g, (o) => json(`Plugins by ${o.author}.`)],
  ],
  ".agents/plugins/marketplace.json": [
    marketplaceName,
    [/^(    "displayName": )"craftsamo"/gm, (o, key) => `${key}${json(o.marketplace)}`],
  ],
  "package.json": [[/^(  "author": )"craftsamo"/gm, (o, key) => `${key}${json(o.author)}`]],
  LICENSE: [[/(Copyright \(c\) \d{4} )CraftSamo/g, (o, key) => `${key}${o.author}`]],
}

/** The files `editSpots` edits; the starter has all of them. */
export const SPOT_FILES = Object.keys(SPOTS)

/** Applies the author, owner and marketplace edits of `path`, if it has any. Returns `{ text, count }`. */
export function editSpots(path, text, options) {
  let count = 0
  for (const [pattern, build] of SPOTS[path] ?? []) {
    let found = 0
    text = text.replace(pattern, (_, ...groups) => {
      found++
      return build(options, ...groups)
    })
    if (found === 0) throw new SetupError(`${path} has no ${pattern}; the setup has probably run already.`)
    count += found
  }
  return { text, count }
}
