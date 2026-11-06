import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { VERSION_FILES } from "./version-files.mjs"

/**
 * Keeps the generated fields of the manifests in step with package.json and the
 * tools the built CLI lists: the top-level `version` of every file in
 * `VERSION_FILES`, and `provides_tools` in `plugin.yaml`. The rest of each file
 * is written by hand. `--check` writes nothing and fails when a file is out of date.
 */

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url))
const ROOT = new URL("../", import.meta.url)
const PACKAGE = new URL("../package.json", import.meta.url)
const YAML_MANIFEST = "plugin.yaml"
const YAML_VERSION_LINE = /^version:.*$/m
const JSON_VERSION_LINE = /^ {2}"version": "[^"]*"/m
const PROVIDES_TOOLS_BLOCK = /^provides_tools:.*(?:\n[ \t]+-.*)*$/m

function listedToolIds() {
  const run = spawnSync(process.execPath, [CLI, "list", "--toolsets", "all"], { encoding: "utf8", stdio: "pipe" })
  if (run.status !== 0) {
    throw new Error(`\`dist/cli.js list\` failed (exit ${run.status}); run \`pnpm run build\` first.\n${run.stderr}`)
  }
  return JSON.parse(run.stdout)
    .map((tool) => tool.id)
    .sort()
}

function replaceField(text, pattern, replacement, name, file) {
  if (!pattern.test(text)) throw new Error(`${file} has no \`${name}\` field to update.`)
  return text.replace(pattern, () => replacement)
}

function renderYaml(text, version, toolIds) {
  const provided =
    toolIds.length === 0 ? "provides_tools: []" : `provides_tools:\n${toolIds.map((id) => `  - ${id}`).join("\n")}`
  const withVersion = replaceField(text, YAML_VERSION_LINE, `version: ${version}`, "version", YAML_MANIFEST)
  return replaceField(withVersion, PROVIDES_TOOLS_BLOCK, provided, "provides_tools", YAML_MANIFEST)
}

/** Only the version line changes, so the file keeps the formatting it was written with. */
function renderJson(file, text, version) {
  const updated = replaceField(text, JSON_VERSION_LINE, `  "version": ${JSON.stringify(version)}`, "version", file)
  if (JSON.parse(updated).version !== version) throw new Error(`${file} has its \`version\` field below the top level.`)
  return updated
}

function render(file, text, version, toolIds) {
  return file === YAML_MANIFEST ? renderYaml(text, version, toolIds) : renderJson(file, text, version)
}

try {
  const check = process.argv.includes("--check")
  const { version } = JSON.parse(readFileSync(PACKAGE, "utf8"))
  const toolIds = listedToolIds()

  const outOfDate = []
  for (const file of VERSION_FILES) {
    const url = new URL(file, ROOT)
    const current = readFileSync(url, "utf8")
    const updated = render(file, current, version, toolIds)
    if (updated === current) continue
    outOfDate.push(file)
    if (!check) writeFileSync(url, updated)
  }

  if (check && outOfDate.length > 0) {
    console.error(
      `${outOfDate.join(", ")} out of date; run \`pnpm run build && pnpm run manifests\` and commit the result.`,
    )
    process.exit(1)
  }
  if (check) console.log("The manifests are up to date.")
  else if (outOfDate.length > 0) console.log(`Updated ${outOfDate.join(", ")}.`)
  else console.log("The manifests are already up to date.")
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
