import { DESCRIPTION_LIMIT } from "../server-json.mjs"
import { usageError } from "./errors.mjs"

/** The options that take a value, mapped to the key they set. */
const VALUE_OPTIONS = {
  prefix: "prefix",
  description: "description",
  name: "name",
  owner: "owner",
  scope: "scope",
  marketplace: "marketplace",
  author: "author",
  "author-url": "authorUrl",
  publisher: "publisher",
}

/** The options that stand alone, mapped to the key they set. */
const FLAG_OPTIONS = { "keep-example": "keepExample", "dry-run": "dryRun", yes: "yes", help: "help" }

const PREFIX_PATTERN = /^[a-z]+$/
const NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const SCOPE_PATTERN = /^@[a-z0-9][a-z0-9._-]*$/
const MARKETPLACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const AUTHOR_URL_PATTERN = /^https:\/\/\S+$/
const ORIGIN_PATTERN =
  /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|git@)github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i

export const HELP = `Usage: pnpm run setup -- --prefix <prefix> --description "<one line>" [options]

Renames the starter to your package, once. Shows every change and asks before writing.

Options:
  --prefix <word>        the tool ID prefix, one lowercase word (required)
  --description <text>   the one-line description, at most ${DESCRIPTION_LIMIT} characters (required)
  --name <kebab-case>    the package, plugin, server and program name (default: the origin repository's name)
  --owner <login>        the GitHub owner (default: the origin repository's owner)
  --scope <@scope>       the npm scope (default: @<owner>)
  --marketplace <name>   the plugin marketplace name (default: <owner>)
  --author <name>        the author in the manifests and the license holder (default: <owner>)
  --author-url <url>     the author URL in the plugin manifests (default: https://github.com/<owner>)
  --publisher <name>     the marketplace publisher (default: <author>)
  --keep-example         keep the example notes tools, renamed to the prefix
  --dry-run              show the changes without writing
  --yes                  write without asking
  --help                 show this text`

/** The GitHub `{ owner, repo }` an `origin` remote URL names (https, scp-like or ssh form), or `null`. */
export function parseOrigin(url) {
  const match = ORIGIN_PATTERN.exec(url.trim())
  return match ? { owner: match[1], repo: match[2] } : null
}

/** Reads `argv` (without the program and script) into the options as typed; `--flag value` and `--flag=value` both work. */
export function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--") continue
    const match = /^--([a-z-]+)(?:=([\s\S]*))?$/.exec(arg)
    if (!match) throw usageError(`Unknown argument: ${arg}`)
    const [, key, inline] = match
    if (Object.hasOwn(FLAG_OPTIONS, key)) {
      if (inline !== undefined) throw usageError(`--${key} takes no value.`)
      parsed[FLAG_OPTIONS[key]] = true
    } else if (Object.hasOwn(VALUE_OPTIONS, key)) {
      let value = inline
      if (value === undefined) {
        value = argv[index + 1]
        if (value === undefined || value.startsWith("--")) throw usageError(`--${key} needs a value.`)
        index++
      }
      parsed[VALUE_OPTIONS[key]] = value
    } else {
      throw usageError(`Unknown option: --${key}`)
    }
  }
  return parsed
}

function missingOptions(parsed, origin) {
  const missing = []
  if (!parsed.prefix) missing.push("--prefix")
  if (!parsed.description?.trim()) missing.push("--description")
  if (!(parsed.name ?? origin)) missing.push("--name")
  if (!(parsed.owner ?? origin)) missing.push("--owner")
  return missing
}

function check(value, pattern, option, expected) {
  if (!pattern.test(value)) throw usageError(`${option} must be ${expected}: ${JSON.stringify(value)}.`)
}

/**
 * The complete options for a run: `parsed` with the defaults filled in from the
 * `origin` GitHub repository (`{ owner, repo }`, or `null`), every value checked.
 * `repo` is the repository name the URLs use: the origin's, else `name`.
 */
export function resolveOptions(parsed, origin) {
  const missing = missingOptions(parsed, origin)
  if (missing.length > 0) {
    const hint = origin ? "" : " The origin remote is not a GitHub repository, so --name and --owner have no default."
    throw usageError(`Missing ${missing.join(", ")}.${hint}`)
  }
  const name = parsed.name ?? origin.repo
  const owner = parsed.owner ?? origin.owner
  const description = parsed.description.trim()
  const author = parsed.author ?? owner
  const authorUrl = parsed.authorUrl ?? `https://github.com/${owner}`
  const publisher = parsed.publisher ?? author
  const scope = parsed.scope ?? `@${owner.toLowerCase()}`
  const marketplace = parsed.marketplace ?? owner

  check(parsed.prefix, PREFIX_PATTERN, "--prefix", "one lowercase word")
  check(name, NAME_PATTERN, "--name", "kebab-case (letters, digits and single hyphens, starting with a letter)")
  check(owner, OWNER_PATTERN, "--owner", "a GitHub login")
  check(scope, SCOPE_PATTERN, "--scope", "an npm scope such as @acme")
  check(marketplace, MARKETPLACE_PATTERN, "--marketplace", "letters, digits, dots, hyphens and underscores")
  check(authorUrl, AUTHOR_URL_PATTERN, "--author-url", "an https:// URL on one line")
  if (/[\r\n]/.test(description)) throw usageError("--description must be one line.")
  if (description.length > DESCRIPTION_LIMIT) {
    throw usageError(
      `--description is ${description.length} characters; the MCP Registry accepts ${DESCRIPTION_LIMIT}.`,
    )
  }
  if (!author.trim() || /[\r\n]/.test(author)) throw usageError("--author must be one non-empty line.")
  if (!publisher.trim() || /[\r\n]/.test(publisher)) throw usageError("--publisher must be one non-empty line.")

  return {
    prefix: parsed.prefix,
    description,
    name,
    owner,
    repo: origin?.repo ?? name,
    scope,
    marketplace,
    author: author.trim(),
    authorUrl,
    publisher: publisher.trim(),
    keepExample: parsed.keepExample === true,
    dryRun: parsed.dryRun === true,
    yes: parsed.yes === true,
  }
}
