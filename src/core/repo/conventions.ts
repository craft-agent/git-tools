import { stat } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { git, gitResult } from "../git"

/** How many recent non-merge commits `conventions` samples when no limit is given. */
export const DEFAULT_SAMPLE = 30
/** The most commits one call may sample. */
export const MAX_SAMPLE = 200
const SUBJECTS_MAX = 15
const CONVENTIONAL_SUBJECT_PATTERN = /^(\w+)(?:\(([^)]+)\))?!?:\s/

const CONFIG_FILES = [
  "commitlint.config.js",
  "commitlint.config.cjs",
  "commitlint.config.mjs",
  "commitlint.config.ts",
  ".commitlintrc",
  ".commitlintrc.json",
  ".commitlintrc.js",
  ".commitlintrc.yml",
  ".commitlintrc.yaml",
  ".gitmessage",
  ".czrc",
  ".cz.json",
  "cz.config.js",
  "CONTRIBUTING.md",
  ".github/CONTRIBUTING.md",
]

const PR_TEMPLATES = [
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
]

/** The result of `conventions`. */
export const conventionsSchema = z.object({
  sample_size: z.number().int().describe("The number of non-merge commit subjects sampled."),
  conventional_ratio: z
    .number()
    .describe("The share of subjects using conventional type and scope syntax, rounded to two decimals."),
  type_frequency: z.record(z.string(), z.number().int()).describe("Conventional commit types and their counts."),
  scopes: z.array(z.string()).describe("Distinct conventional commit scopes, in first-seen order."),
  config_files: z.array(z.string()).describe("Commit convention configuration files present in the working tree."),
  subjects: z.array(z.string()).describe(`The newest ${SUBJECTS_MAX} sampled commit subjects, at most.`),
  pr_template: z
    .string()
    .nullable()
    .describe("The first pull request template path present in the working tree, or null."),
})

async function isFile(root: string, path: string): Promise<boolean> {
  try {
    return (await stat(join(root, path))).isFile()
  } catch {
    return false
  }
}

/**
 * Signals for inferring a repository's commit and pull request conventions:
 * the latest `limit` non-merge subjects with their conventional types and
 * scopes, and the convention files in the working tree. An unborn HEAD gives
 * an empty sample; the inference itself is the caller's.
 */
export async function readConventions(
  root: string,
  limit: number,
  signal?: AbortSignal,
): Promise<z.output<typeof conventionsSchema>> {
  const options = { cwd: root, signal }
  const head = await gitResult(["rev-parse", "--verify", "--quiet", "HEAD"], options)
  let subjects: string[] = []
  if (head.code === 0) {
    const log = await git(["log", "--no-merges", `-${limit}`, "--format=%s"], options)
    subjects = log.split("\n").filter(Boolean)
  }
  const types = new Map<string, number>()
  const scopes = new Set<string>()
  let conventional = 0
  for (const subject of subjects) {
    const match = subject.match(CONVENTIONAL_SUBJECT_PATTERN)
    if (!match) continue
    conventional++
    types.set(match[1], (types.get(match[1]) ?? 0) + 1)
    if (match[2]) scopes.add(match[2])
  }
  const config_files: string[] = []
  for (const path of CONFIG_FILES) {
    if (await isFile(root, path)) config_files.push(path)
  }
  let pr_template: string | null = null
  for (const path of PR_TEMPLATES) {
    if (await isFile(root, path)) {
      pr_template = path
      break
    }
  }
  return {
    sample_size: subjects.length,
    conventional_ratio: subjects.length ? Number((conventional / subjects.length).toFixed(2)) : 0,
    type_frequency: Object.fromEntries(types),
    scopes: [...scopes],
    config_files,
    subjects: subjects.slice(0, SUBJECTS_MAX),
    pr_template,
  }
}
