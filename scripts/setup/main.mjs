import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline/promises"
import { fileURLToPath } from "node:url"
import { applyPlan, formatWritten } from "./apply.mjs"
import { EXIT_REFUSED, SetupError } from "./errors.mjs"
import { HELP, parseArgs, resolveOptions } from "./options.mjs"
import { buildPlan } from "./plan.mjs"
import { assertCleanWorkTree, listTrackedFiles, readOrigin } from "./repo.mjs"
import { NEXT_STEPS, formatPlan } from "./report.mjs"

const ROOT = fileURLToPath(new URL("../../", import.meta.url))

async function confirm() {
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^y(es)?$/i.test((await prompt.question("Apply these changes? [y/N] ")).trim())
  } finally {
    prompt.close()
  }
}

/** Runs the setup for `argv` and returns the exit code. */
async function main(argv) {
  const parsed = parseArgs(argv)
  if (parsed.help) {
    console.log(HELP)
    return 0
  }
  const options = resolveOptions(parsed, readOrigin(ROOT))
  assertCleanWorkTree(ROOT)
  const plan = buildPlan(options, listTrackedFiles(ROOT), (path) => readFileSync(join(ROOT, path)))
  console.log(`${formatPlan(plan)}\n`)
  if (options.dryRun) {
    console.log("Dry run: nothing was written.")
    return 0
  }
  if (!options.yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new SetupError("Not a terminal, so there is nobody to ask; pass --yes to write without asking.")
    }
    if (!(await confirm())) {
      console.log("Nothing was written.")
      return EXIT_REFUSED
    }
  }
  applyPlan(ROOT, plan)
  console.log(`Done.\n${formatWritten(ROOT, plan)}\n\n${NEXT_STEPS}`)
  return 0
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  if (!(error instanceof SetupError)) throw error
  console.error(error.message)
  process.exitCode = error.exitCode
}
