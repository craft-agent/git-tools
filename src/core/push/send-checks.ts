import { sortFindings } from "../commit/commit-run"
import { ToolError } from "../errors"
import type { PushPreview } from "./schema"

/** Throws `push_refused`, with the refusals in `details`, when the preview refuses the push. */
export function requireNotRefused(preview: PushPreview): void {
  if (preview.refusals.length === 0) return
  throw new ToolError("push_refused", preview.refusals.map((refusal) => refusal.message).join(" "), {
    details: { refusals: preview.refusals },
  })
}

/**
 * Throws `check_failed` for the first check whose findings are not all
 * accepted by fingerprint: the secrets, then the published text. Returns the
 * accepted fingerprints of both when nothing stops the push.
 */
export function requireChecksPass(preview: PushPreview, acceptFindings: string[] | undefined): string[] {
  const { gitleaks } = preview.secrets
  const secrets = sortFindings(preview.secrets.findings, acceptFindings)
  if (secrets.rejected.length > 0) {
    throw new ToolError(
      "check_failed",
      "The commits to push hold what looks like credentials; remove them from the commits, or pass the fingerprints of the false positives in accept_findings after reading each, then preview and push again.",
      { details: { check: "secrets", gitleaks, findings: secrets.rejected, accepted: secrets.accepted } },
    )
  }

  const text = sortFindings(preview.published_text.findings, acceptFindings)
  if (text.rejected.length > 0) {
    throw new ToolError(
      "check_failed",
      "The branch names or commit subjects to push match the published-text rules; reword the commit or rename the branch as each hint says, or pass the fingerprints in accept_findings after reading each, then preview and push again.",
      { details: { check: "published_text", findings: text.rejected, accepted: text.accepted } },
    )
  }
  return [...new Set([...secrets.accepted, ...text.accepted])]
}
