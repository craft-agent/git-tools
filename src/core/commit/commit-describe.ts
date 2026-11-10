import { createHash } from "node:crypto"
import { git, gitResult } from "../git"
import type { CallFact } from "../tool"
import { parseNumstat } from "./commit-landed"
import { scanSecrets } from "./secrets"

/** The files the index changes against HEAD and the lines they add and remove; a binary file counts as a file with no lines. */
export async function stagedChanges(
  root: string,
  signal: AbortSignal | undefined,
): Promise<{ files: number; added: number; removed: number }> {
  const files = parseNumstat(await git(["diff", "--cached", "--numstat", "-z", "--no-renames"], { cwd: root, signal }))
  return {
    files: files.length,
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
  }
}

/**
 * The pins of what a commit would hold: `head`, the sha of HEAD (empty when
 * unborn), and `index`, the SHA-256 of the staged entries (modes, blob ids,
 * stages and paths). Counts alone cannot tell two staged contents apart; this
 * can. Reads only, writing no object and refreshing no index.
 */
export async function indexPins(root: string, signal: AbortSignal | undefined): Promise<Record<string, string>> {
  const head = await gitResult(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: root, signal })
  const entries = await git(["ls-files", "--stage", "-z"], { cwd: root, signal })
  return {
    head: head.code === 0 ? head.stdout.trim() : "",
    index: createHash("sha256").update(entries).digest("hex"),
  }
}

/** The `Accepted findings` fact for these fingerprints. */
export function acceptedFact(fingerprints: string[]): CallFact {
  return { label: "Accepted findings", value: fingerprints.join(", ") }
}

/**
 * The `Accepted findings` fact: the fingerprints in `accept` that the scan of
 * the staged changes found, deduped in scan order. `undefined` when none are
 * accepted or none matches.
 */
export async function acceptedFindingsFact(
  root: string,
  accept: string[] | undefined,
  signal: AbortSignal | undefined,
): Promise<CallFact | undefined> {
  if (accept === undefined || accept.length === 0) return undefined
  const allowed = new Set(accept)
  const { findings } = await scanSecrets(root, { target: "staged" }, signal)
  const matched = [...new Set(findings.map((finding) => finding.fingerprint).filter((print) => allowed.has(print)))]
  return matched.length === 0 ? undefined : acceptedFact(matched)
}
