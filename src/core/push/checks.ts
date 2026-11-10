import { scanCommits } from "../commit/secrets"
import type { BranchState } from "./branch-state"
import {
  publishedTextFindings,
  type PublishedText,
  type PublishedTextFinding,
  type PublishedTextRule,
} from "./published-text"
import type { PushSecrets } from "./schema"

/** A revision expression that selects no commit, for a scan of a push with nothing to send. */
const NO_COMMITS = ["--all", "--not", "--all"]

/**
 * Scans the commits the remote lacks, across the branches that are pushed
 * (each once), by each commit's own patch and with gitleaks when installed, so
 * a secret one commit adds and a later one removes is found. The commits are
 * the tips that are pushed, less what the known remote commits and the
 * remote-tracking branches of `remote` hold.
 */
export async function scanPushedCommits(
  root: string,
  remote: string,
  states: BranchState[],
  signal?: AbortSignal,
): Promise<PushSecrets> {
  const pushed = states.filter((state) => state.kind !== "none")
  if (pushed.length === 0) return scanCommits(root, NO_COMMITS, signal)
  const tips = new Set(pushed.map((state) => state.sha))
  const known = new Set(pushed.flatMap((state) => (state.known && state.expect !== null ? [state.expect] : [])))
  return scanCommits(root, [...tips, "--not", ...known, `--remotes=${remote}`], signal)
}

/**
 * Matches `rules` against the names of the branches that are pushed and the
 * subjects of the commits the remote lacks; a commit is reported under the
 * first branch that carries it.
 */
export function matchPublishedText(rules: PublishedTextRule[], states: BranchState[]): PublishedTextFinding[] {
  const texts: PublishedText[] = []
  for (const { branch, kind, commits } of states) {
    if (kind === "none") continue
    texts.push({ field: "branch", branch, text: branch })
    for (const { sha, subject } of commits) texts.push({ field: "subject", branch, sha, text: subject })
  }
  return publishedTextFindings(rules, texts)
}
