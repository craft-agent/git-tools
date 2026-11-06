import { SetupError } from "./errors.mjs"
import { STARTER } from "./identity.mjs"

/** The folder of the example notes skill; it is renamed to the prefix when the example is kept. */
export const EXAMPLE_SKILL_DIR = `skills/${STARTER.prefix}-notes`

/** The folders of the example notes tools and of their skill. */
export const EXAMPLE_DIRS = ["src/core/example", EXAMPLE_SKILL_DIR]

const TOOLS_FILE = "src/tools.ts"
const PLUGIN_YAML = "plugin.yaml"
const PROJECT_FILE = "src/project.ts"
const HERMES_PROJECT_FILE = /^src\/hermes\/[^/]+\/project\.py$/

const EMPTY_TOOLS_FILE = `import type { ToolSpec } from "./core"

/** Every tool spec of the package; entry points register their tools from this list. */
export const ALL_TOOLS: ToolSpec[] = []
`

const TOOL_PREFIX_LINE = new RegExp(`(\\btoolPrefix: )"${STARTER.prefix}"`)
const SKILL_PREFIX_LINE = new RegExp(`(\\bSKILL_PREFIX = )"${STARTER.prefix}-"`)
const TOOLSETS_LINES = /(\b(?:toolsets|defaultToolsets): )\[[^\]]*\]( as readonly string\[\])/g
const PROVIDES_TOOLS_BLOCK = /^provides_tools:.*(?:\n[ \t]+-.*)*$/m

/** Replaces `pattern` in `text` through `replacement`; it must match `expected` times, so a changed file is refused. */
function replaceExactly(path, text, pattern, replacement, expected = 1) {
  let count = 0
  const replaced = text.replace(pattern, (...args) => {
    count++
    return replacement(...args)
  })
  if (count !== expected) {
    throw new SetupError(`${path} has ${count} of ${pattern}, not ${expected}; the setup has probably run already.`)
  }
  return { text: replaced, count }
}

/** Takes the example tools out of the files that list them. */
function removeExample(path, text) {
  if (path === TOOLS_FILE) {
    if (!text.includes("./core/example/")) {
      throw new SetupError(`${TOOLS_FILE} does not import the example tools; it was changed after the starter.`)
    }
    return { text: EMPTY_TOOLS_FILE, count: 1 }
  }
  if (path === PROJECT_FILE) {
    return replaceExactly(path, text, TOOLSETS_LINES, (_, key, type) => `${key}[]${type}`, 2)
  }
  if (path === PLUGIN_YAML) return replaceExactly(path, text, PROVIDES_TOOLS_BLOCK, () => "provides_tools: []")
  return { text, count: 0 }
}

/**
 * Edits the places where the tool prefix is set (`toolPrefix` of src/project.ts, `SKILL_PREFIX` of the Hermes
 * plugin) and, unless `keepExample`, takes the example out of the files that list it. Returns `{ text, count }`.
 */
export function editForExample(path, text, { prefix, keepExample }) {
  let result = { text, count: 0 }
  if (path === PROJECT_FILE) {
    result = replaceExactly(path, text, TOOL_PREFIX_LINE, (_, key) => `${key}"${prefix}"`)
  } else if (HERMES_PROJECT_FILE.test(path)) {
    result = replaceExactly(path, text, SKILL_PREFIX_LINE, (_, key) => `${key}"${prefix}-"`)
  }
  if (keepExample) return result
  const removed = removeExample(path, result.text)
  return { text: removed.text, count: result.count + removed.count }
}
