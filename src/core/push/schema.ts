import { z } from "zod"
import { secretsSchema } from "../commit/secrets"
import { publishedTextFindingSchema } from "./published-text"

/** How many commits a branch's `commits` and `drops` list. */
export const MAX_LISTED_COMMITS = 30

/** How many branches one preview or one send takes. */
export const MAX_BRANCHES = 20

/** What pushing a branch does to the remote branch. */
export const PUSH_KINDS = ["none", "create", "fast_forward", "force"] as const

export type PushKind = (typeof PUSH_KINDS)[number]

/** The rules that refuse a push. */
export const REFUSAL_RULES = ["default_branch", "operation", "protected", "unknown_remote_commit"] as const

const commitListSchema = z.object({
  count: z.number().int().describe("How many commits there are."),
  items: z
    .array(
      z.object({
        sha: z.string().describe("The short commit id."),
        subject: z.string().describe("The first line of the commit message."),
      }),
    )
    .describe(`The commits, oldest first; at most ${MAX_LISTED_COMMITS}.`),
})

/** What a push pins for one branch: the commit to push and the remote commit it expects. */
export const pushedBranchSchema = z.object({
  branch: z.string().describe("The local branch, pushed to the branch of the same name on the remote."),
  sha: z.string().describe("The full id of the local tip to push."),
  expect: z
    .string()
    .nullable()
    .describe("The full id of the commit the remote branch is at, which the push leases on; null for a new branch."),
})

/** The arguments of the send tool: exactly what a preview read. */
export const sendSchema = z.object({
  remote: z.string().describe("The remote to push to."),
  branches: z.array(pushedBranchSchema).describe("The branches to push, bottom of the line first."),
})

const previewBranchSchema = pushedBranchSchema.extend({
  kind: z
    .enum(PUSH_KINDS)
    .describe(
      '"none": the remote branch is already at the tip. "create": the remote has no such branch. "fast_forward": the remote tip is an ancestor of the local tip. "force": it is not, so the push replaces the remote branch and needs a force push.',
    ),
  commits: commitListSchema.describe("The commits the push adds: those the remote does not have."),
  drops: commitListSchema
    .nullable()
    .describe(
      "For a force push whose remote commit is known here: the remote commits it drops, whose change is not on the local branch. Null otherwise.",
    ),
})

const refusalSchema = z.object({
  rule: z
    .enum(REFUSAL_RULES)
    .describe(
      '"default_branch": the remote\'s default branch is never pushed. "operation": a rebase, merge or other operation is in progress. "protected": GitHub blocks force pushes to the branch. "unknown_remote_commit": a force push over a remote commit that is not here.',
    ),
  branch: z.string().nullable().describe("The branch the rule refuses; null when it refuses the whole push."),
  message: z.string().describe("Why, and what to do instead."),
})

/** The secret scan of the commits a push adds. */
const pushSecretsSchema = secretsSchema.pick({ gitleaks: true, findings: true })

/** The secret scan of a push: whether gitleaks ran, and the findings. */
export type PushSecrets = z.output<typeof pushSecretsSchema>

/** The published-text rules applied to the branch names and commit subjects a push publishes. */
const publishedTextSchema = z.object({
  rules: z.number().int().describe("How many rules were checked; 0 when no rules are set, so nothing was checked."),
  findings: z.array(publishedTextFindingSchema).describe("The texts that match a rule."),
})

/** What pushing a line of branches would send, read from the remote now. */
export const previewSchema = z.object({
  root: z.string().describe("The absolute path of the working tree root."),
  remote: z.string().describe("The remote the branches are pushed to."),
  default_branch: z
    .string()
    .nullable()
    .describe("The remote's default branch, read from the remote; null when it is not known."),
  branches: z.array(previewBranchSchema).describe("The branches, bottom of the line first."),
  refusals: z.array(refusalSchema).describe("Why a push of these branches would be refused; empty when none."),
  warnings: z.array(z.string()).describe("What does not stop a push but is worth knowing."),
  secrets: pushSecretsSchema.describe(
    "The secret scan of the commits the remote lacks, each commit's own patch and gitleaks when installed; values are redacted.",
  ),
  published_text: publishedTextSchema,
  send: sendSchema
    .nullable()
    .describe(
      "The arguments that push exactly this: every branch that is not up to date. Null when something is refused or there is nothing to push. Findings are not in it; the caller passes the fingerprints it accepts separately.",
    ),
})

/** The preview of a push. */
export type PushPreview = z.output<typeof previewSchema>

/** One branch of a preview. */
export type PreviewBranch = PushPreview["branches"][number]

/** One reason a push would be refused. */
export type PushRefusal = PushPreview["refusals"][number]
