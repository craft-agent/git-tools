import { VERSION_FILES } from "../version-files.mjs"
import { SetupError } from "./errors.mjs"

/** The version a project made from the starter begins at, whatever the starter's own release was. */
export const INITIAL_VERSION = "0.0.0"

const JSON_VERSION = /^( {2}"version": )"[^"\n]*"/m
const YAML_VERSION = /^version: .*$/m

/** The files that carry the package's version: package.json and every manifest the release bumps with it. */
export const VERSIONED_FILES = ["package.json", ...VERSION_FILES]

/**
 * Sets the top-level version of a versioned file to `INITIAL_VERSION`, as a text edit so the file keeps its
 * formatting; other files pass through. Returns `{ text, count }`.
 */
export function resetVersion(path, text) {
  if (!VERSIONED_FILES.includes(path)) return { text, count: 0 }
  const pattern = path.endsWith(".yaml") ? YAML_VERSION : JSON_VERSION
  if (!pattern.test(text)) throw new SetupError(`${path} has no top-level version the setup can reset.`)
  const replacement = path.endsWith(".yaml") ? `version: ${INITIAL_VERSION}` : `$1"${INITIAL_VERSION}"`
  const edited = text.replace(pattern, replacement)
  return { text: edited, count: Number(edited !== text) }
}
