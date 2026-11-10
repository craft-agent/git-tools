import { acceptedFact } from "../commit/commit-describe"
import { git } from "../git"
import { commitsFact, forcePushFact } from "../git-facts"
import type { CallDescription, CallFact } from "../tool"
import { isAncestor } from "../tree"
import { hasCommit } from "./branch-state"
import { KIND_WORDS, requireLocalPins, type SendRequest, type SentKind } from "./send-plan"

/** The separator between the branches of one kind in the `Branches` fact. */
const BRANCH_SEPARATOR = ", "

/** The separator between the kinds in the `Branches` fact. */
const KIND_SEPARATOR = "; "

/** A branch of a send with the kind of push it makes. */
export type KindedBranch = { branch: string; kind: SentKind }

/** The kinds in the order the `Branches` fact lists them. */
const KINDS = Object.keys(KIND_WORDS) as SentKind[]

/**
 * The `Branches` fact: the branches grouped by the kind of push they make,
 * each group as `<branches> (<kind>)` and the groups joined with `; `. Each
 * template holds the kind words, so the entry point can translate them; the
 * branch names are its values.
 */
export function branchesFact(entries: KindedBranch[]): CallFact {
  const present = KINDS.filter((kind) => entries.some((entry) => entry.kind === kind))
  const text = present.map((kind) => `{${kind}} (${KIND_WORDS[kind]})`).join(KIND_SEPARATOR)
  const values = Object.fromEntries(
    present.map((kind) => [
      kind,
      entries
        .filter((entry) => entry.kind === kind)
        .map((entry) => entry.branch)
        .join(BRANCH_SEPARATOR),
    ]),
  )
  return { label: "Branches", value: { text, values } }
}

/** The kind of push a branch makes by what this repository knows: a new remote branch, a fast forward over a remote commit it holds, else a force. */
async function localKind(
  root: string,
  { sha, expect }: SendRequest["branches"][number],
  signal?: AbortSignal,
): Promise<SentKind> {
  if (expect === null) return "create"
  return (await isAncestor(root, expect, sha, signal)) ? "fast_forward" : "force"
}

/** How many commits leave: those of the pushed commits that none of the known remote commits and remote-tracking branches of `remote` hold. */
async function leavingCommits(root: string, request: SendRequest, signal?: AbortSignal): Promise<number> {
  const known: string[] = []
  for (const { expect } of request.branches) {
    if (expect !== null && (await hasCommit(root, expect, signal))) known.push(expect)
  }
  const tips = new Set(request.branches.map(({ sha }) => sha))
  const count = await git(["rev-list", "--count", ...tips, "--not", ...new Set(known), `--remotes=${request.remote}`], {
    cwd: root,
    signal,
  })
  return Number.parseInt(count, 10)
}

/**
 * What a call of `git_push_send` will do, for the person approving it, from
 * this repository alone (no remote is read): whether the push needs a force,
 * the branches and their kinds, and the commits that leave. The arguments
 * already pin every commit and lease, so there are no pins. It throws when a
 * local check of the request fails.
 */
export async function sendDescription(
  root: string,
  request: SendRequest,
  acceptFindings: string[] | undefined,
  signal?: AbortSignal,
): Promise<CallDescription> {
  await requireLocalPins(root, request, signal)
  const entries: KindedBranch[] = []
  for (const branch of request.branches) {
    entries.push({ branch: branch.branch, kind: await localKind(root, branch, signal) })
  }

  const accepted = [...new Set(acceptFindings)]
  const facts: CallFact[] = [
    ...(entries.some((entry) => entry.kind === "force") ? [forcePushFact()] : []),
    branchesFact(entries),
    commitsFact(await leavingCommits(root, request, signal)),
    ...(accepted.length > 0 ? [acceptedFact(accepted)] : []),
  ]
  const { remote } = request
  return {
    headline:
      entries.length === 1
        ? { text: "About to push {branch} to {remote}", values: { branch: entries[0]!.branch, remote } }
        : {
            text: "About to push {count} branches to {remote}",
            values: { count: String(entries.length), remote },
          },
    facts,
  }
}
