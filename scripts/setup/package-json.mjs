import { SetupError } from "./errors.mjs"

const PRIVATE_LINE = /^ *"private": true,\n/m
const SETUP_SCRIPT_LINE = /^ *"setup": "[^"\n]*",?\n/m

/**
 * Makes package.json publishable and drops the setup script, as text edits so the file keeps its formatting.
 * Returns `{ text, count }`.
 */
export function editPackageJson(text) {
  const edited = text.replace(PRIVATE_LINE, "").replace(SETUP_SCRIPT_LINE, "")
  let pkg
  try {
    pkg = JSON.parse(edited)
  } catch {
    pkg = null
  }
  if (!pkg || "private" in pkg || "setup" in (pkg.scripts ?? {})) {
    throw new SetupError("package.json has a `private` or `setup` entry the setup cannot remove by line.")
  }
  const count = Number(PRIVATE_LINE.test(text)) + Number(SETUP_SCRIPT_LINE.test(text))
  return { text: edited, count }
}
