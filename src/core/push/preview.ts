import { shortSha } from "../rewrite"
import type { ToolContext } from "../tool"
import { compareBranch, type BranchState, type CommitLine } from "./branch-state"
import { matchPublishedText, scanPushedCommits } from "./checks"
import { loadPublishedTextRules } from "./published-text"
import { readRemote } from "./remote-read"
import { findRefusals } from "./refusals"
import { MAX_LISTED_COMMITS, type PreviewBranch, type PushPreview } from "./schema"
import { resolveRemote, selectBranches } from "./select"
import { previewWarnings } from "./warnings"

/** What a preview is asked for: the end of a forked line, the branches to push instead of the line, the remote to push to. */
export type PreviewArgs = { top?: string; branches?: string[]; remote?: string }

function listed(commits: CommitLine[]) {
  return {
    count: commits.length,
    items: commits.slice(0, MAX_LISTED_COMMITS).map(({ sha, subject }) => ({ sha: shortSha(sha), subject })),
  }
}

function previewBranch(state: BranchState): PreviewBranch {
  const { branch, sha, expect, kind, commits, drops } = state
  return { branch, sha, expect, kind, commits: listed(commits), drops: drops === null ? null : listed(drops) }
}

/**
 * Reads what pushing the current line (or `branches`) to its remote would
 * send, from the remote as it is now: per branch the commit, the remote commit
 * it leases on, what kind of push it is and which commits the remote lacks;
 * what refuses the push; warnings; the secret and published-text checks of the
 * commits and names that would leave; and `send`, the arguments that push
 * exactly this (null when something is refused or nothing is to be pushed).
 * Nothing is changed.
 */
export async function previewPush(
  root: string,
  args: PreviewArgs,
  ctx: Pick<ToolContext, "options" | "signal">,
): Promise<PushPreview> {
  const { signal } = ctx
  const selected = await selectBranches(root, { top: args.top?.trim() || undefined, branches: args.branches }, signal)
  const branches = selected.map((entry) => entry.branch)
  const remote = await resolveRemote(root, branches, args.remote?.trim() || undefined, signal)
  const rules = await loadPublishedTextRules(ctx.options, signal)

  const live = await readRemote(root, remote, branches, signal)
  const states: BranchState[] = []
  for (const entry of selected) {
    states.push(await compareBranch(root, remote, entry, live.heads.get(entry.branch) ?? null, signal))
  }

  const refused = await findRefusals(root, remote, live.defaultBranch, states, signal)
  const warnings = [
    ...(await previewWarnings(root, remote, live.defaultBranch, selected, states, signal)),
    ...refused.warnings,
  ]
  const secrets = await scanPushedCommits(root, remote, states, signal)

  const pushed = states.filter((state) => state.kind !== "none")
  const send =
    refused.refusals.length === 0 && pushed.length > 0
      ? { remote, branches: pushed.map(({ branch, sha, expect }) => ({ branch, sha, expect })) }
      : null
  return {
    root,
    remote,
    default_branch: live.defaultBranch,
    branches: states.map(previewBranch),
    refusals: refused.refusals,
    warnings,
    secrets,
    published_text: { rules: rules.length, findings: matchPublishedText(rules, states) },
    send,
  }
}
