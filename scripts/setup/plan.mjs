import { SetupError } from "./errors.mjs"
import { EXAMPLE_DIRS, EXAMPLE_SKILL_DIR, editForExample } from "./example.mjs"
import { STARTER, createReplacer, deriveIdentity, isQuotedStringFile, toSnake } from "./identity.mjs"
import { removeMarkedBlocks } from "./markers.mjs"
import { OPENCODE_CONFIG, opencodeConfig } from "./opencode-config.mjs"
import { editPackageJson } from "./package-json.mjs"
import { SPOT_FILES, editSpots } from "./spots.mjs"
import { resetVersion } from "./version.mjs"

/** The folder of the setup itself, which it deletes when done. */
export const SETUP_DIR = "scripts/setup"

/** Files the setup leaves alone however they read. */
const UNTOUCHED_FILES = new Set(["pnpm-lock.yaml"])

const GITKEEP = "skills/.gitkeep"
const HERMES_DIR = `src/hermes/${toSnake(STARTER.name)}_hermes`
const EXPECTED_FILES = [...SPOT_FILES, "src/project.ts", "src/tools.ts", "plugin.yaml", `${HERMES_DIR}/project.py`]

const isUnder = (path, dir) => path.startsWith(`${dir}/`)

function directoryMoves({ name, prefix, keepExample }) {
  const moves = [{ from: HERMES_DIR, to: `src/hermes/${toSnake(name)}_hermes` }]
  if (keepExample) moves.push({ from: EXAMPLE_SKILL_DIR, to: `skills/${prefix}-notes` })
  return moves.filter((move) => move.from !== move.to)
}

function movedPath(path, moves) {
  const move = moves.find((candidate) => isUnder(path, candidate.from))
  return move ? move.to + path.slice(move.from.length) : path
}

function assertStarter(paths, read) {
  const project = paths.includes("src/project.ts") ? read("src/project.ts").toString("utf8") : ""
  if (!project.includes(`name: "${STARTER.name}"`)) {
    throw new SetupError(`src/project.ts does not name \`${STARTER.name}\`; the setup has probably run already.`)
  }
  const missing = EXPECTED_FILES.filter((file) => !paths.includes(file))
  if (missing.length > 0) throw new SetupError(`The starter's ${missing.join(", ")} is missing; the tree was changed.`)
}

/** The text of a file after every edit that applies to its path, with the number of replacements made. */
function editText(path, text, options, replace) {
  const stages = [
    (current) => editSpots(path, current, options),
    (current) => (path.endsWith(".md") ? removeMarkedBlocks(current, options, path) : { text: current, count: 0 }),
    (current) => editForExample(path, current, options),
    (current) => (path === "package.json" ? editPackageJson(current) : { text: current, count: 0 }),
    (current) => resetVersion(path, current),
  ]
  return stages.reduce(
    (result, stage) => {
      const next = stage(result.text)
      return { text: next.text, count: result.count + next.count }
    },
    replace(text, isQuotedStringFile(path)),
  )
}

function assertNoCollisions(entries, paths) {
  const existing = new Set(paths)
  const targets = new Set()
  for (const { path, newPath } of entries) {
    if (newPath === null) continue
    if ((newPath !== path && existing.has(newPath)) || targets.has(newPath)) {
      throw new SetupError(`${newPath} would be written twice or over a file of the starter.`)
    }
    targets.add(newPath)
  }
}

/**
 * Computes every change without writing: `read(path)` gives a tracked file's bytes. Returns
 * `{ identity, entries, moves, removedDirs }`, where each entry is `{ path, newPath, content, count }`:
 * `path` null is a file to create, `newPath` null one to delete, both set and different one to move, and `count`
 * the replacements made in its text. Throws a `SetupError` before anything is written.
 */
export function buildPlan(options, paths, read) {
  assertStarter(paths, read)
  const identity = deriveIdentity(options, JSON.parse(read("package.json").toString("utf8")).description)
  const replace = createReplacer(identity)
  const moves = directoryMoves(options)
  const removedDirs = options.keepExample ? [SETUP_DIR] : [SETUP_DIR, ...EXAMPLE_DIRS]

  const entries = []
  for (const path of paths) {
    if (removedDirs.some((dir) => isUnder(path, dir))) {
      entries.push({ path, newPath: null, content: null, count: 0 })
      continue
    }
    const newPath = movedPath(path, moves)
    const bytes = read(path)
    const isText = !UNTOUCHED_FILES.has(path) && !bytes.includes(0)
    const before = isText ? bytes.toString("utf8") : null
    const edited = isText ? editText(path, before, options, replace) : null
    const changed = edited !== null && edited.text !== before
    if (changed || newPath !== path) {
      entries.push({ path, newPath, content: changed ? edited.text : bytes, count: changed ? edited.count : 0 })
    }
  }

  const kept = paths.filter((path) => !removedDirs.some((dir) => isUnder(path, dir)))
  if (!options.keepExample && !kept.some((path) => path.startsWith("skills/"))) {
    entries.push({ path: null, newPath: GITKEEP, content: "", count: 0 })
  }
  entries.push({ path: null, newPath: OPENCODE_CONFIG, content: opencodeConfig(), count: 0 })
  assertNoCollisions(entries, paths)
  return { identity, entries, moves, removedDirs }
}
