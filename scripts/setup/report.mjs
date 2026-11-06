/** What to do after the setup, as the README's step 3 gives it. */
export const NEXT_STEPS = `Next, rebuild and check, then commit the result:

  pnpm install
  pnpm run build && pnpm run manifests
  pnpm run typecheck && pnpm test && pnpm run smoke`

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`

const section = (title, lines) => (lines.length > 0 ? [`${title}:`, ...lines.map((line) => `  ${line}`), ""] : [])

function removedLines(plan) {
  const deleted = plan.entries.filter((entry) => entry.newPath === null).map((entry) => entry.path)
  return plan.removedDirs.map((dir) => {
    const files = deleted.filter((path) => path.startsWith(`${dir}/`)).length
    return `${dir}/ (${plural(files, "file")})`
  })
}

/** The plan as text: the identity table, then the files edited, moved, created and deleted. */
export function formatPlan(plan) {
  const edited = plan.entries.filter((entry) => entry.count > 0)
  const moved = plan.moves.map((move) => {
    const files = plan.entries.filter((entry) => entry.path?.startsWith(`${move.from}/`)).length
    return `${move.from}/ -> ${move.to}/ (${plural(files, "file")})`
  })
  const created = plan.entries.filter((entry) => entry.path === null).map((entry) => entry.newPath)
  return [
    ...section(
      "Replacements (old -> new)",
      plan.identity.map((entry) => `${entry.from} -> ${entry.to}`),
    ),
    ...section(
      `Edit ${plural(edited.length, "file")}`,
      edited.map((entry) => `${entry.newPath} (${plural(entry.count, "replacement")})`),
    ),
    ...section("Rename", moved),
    ...section("Create", created),
    ...section("Delete", removedLines(plan)),
  ]
    .join("\n")
    .trimEnd()
}
