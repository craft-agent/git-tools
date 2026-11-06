import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"

/** The mode of a file the setup creates. */
const NEW_FILE_MODE = 0o644

/** How many paths one prettier run gets, to stay clear of the command line limit. */
const FORMAT_BATCH = 100

/** Writes `content` to a temporary file beside `target`, then renames it over `target`; the mode is kept. */
function writeAtomically(target, content, mode) {
  mkdirSync(dirname(target), { recursive: true })
  const temporary = join(dirname(target), `.${basename(target)}.setup-${process.pid}.tmp`)
  try {
    writeFileSync(temporary, content)
    chmodSync(temporary, mode)
    renameSync(temporary, target)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

/** Writes the plan's files first and removes the old ones after, so a failure never loses a file. */
export function applyPlan(root, plan) {
  const at = (path) => join(root, path)
  for (const { path, newPath, content } of plan.entries) {
    if (newPath !== null) writeAtomically(at(newPath), content, path === null ? NEW_FILE_MODE : statSync(at(path)).mode)
  }
  for (const { path, newPath } of plan.entries) {
    if (path !== null && newPath !== path) rmSync(at(path), { force: true })
  }
  for (const dir of [...plan.moves.map((move) => move.from), ...plan.removedDirs]) {
    rmSync(at(dir), { recursive: true, force: true })
  }
}

/**
 * Formats the written files with the repository's prettier, so tables and wrapped text are tidy again. Returns
 * a message saying what was done.
 */
export function formatWritten(root, plan) {
  const prettier = join(root, "node_modules", ".bin", "prettier")
  if (!existsSync(prettier))
    return "Formatting skipped: prettier is not installed; run `pnpm install && pnpm run format`."
  const written = plan.entries.filter((entry) => entry.newPath !== null).map((entry) => entry.newPath)
  for (let start = 0; start < written.length; start += FORMAT_BATCH) {
    const batch = written.slice(start, start + FORMAT_BATCH)
    const run = spawnSync(prettier, ["--write", "--ignore-unknown", "--log-level", "warn", ...batch], {
      cwd: root,
      stdio: "inherit",
    })
    if (run.status !== 0) return "Formatting failed; run `pnpm run format`."
  }
  return `Formatted ${written.length} files with prettier.`
}
