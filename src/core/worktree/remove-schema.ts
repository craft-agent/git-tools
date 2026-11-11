import { z } from "zod"

/** Why a branch was kept when its worktree was removed. */
const KEPT_REASONS = ["detached", "default_branch", "checked_out", "not_landed", "delete_failed"] as const

/** The proof that a branch landed: its commits are in origin's default branch, or a merged pull request carried them. */
const landedSchema = z.discriminatedUnion("by", [
  z.object({
    by: z.literal("ancestry"),
    into: z.string().describe("The remote branch that holds the branch's tip, such as origin/main."),
  }),
  z.object({
    by: z.literal("pull_request"),
    number: z
      .number()
      .int()
      .describe("The number of the merged pull request from this repository whose head is the tip."),
  }),
])

/** What removing a worktree returns. */
export const removedSchema = z.object({
  directory: z.string().describe("The real path of the worktree that was removed, as it was before."),
  branch: z.string().nullable().describe("The branch that was checked out in it; null when HEAD was detached."),
  pruned: z
    .boolean()
    .describe("True when the directory was already gone and only git's record of the worktree was pruned."),
  branch_deleted: z.boolean().describe("Whether the branch was deleted, because it was proven to have landed."),
  landed: landedSchema
    .nullable()
    .describe("How the branch was proven to have landed; null when it was not (or was not looked at)."),
  kept_because: z
    .enum(KEPT_REASONS)
    .nullable()
    .describe(
      "Why the branch stays: detached (there is none), default_branch, checked_out (in another worktree), not_landed (no proof) or delete_failed (git refused, see warnings); null when it was deleted.",
    ),
  warnings: z
    .array(z.string())
    .describe("What does not stop the call but is worth knowing, such as a failed fetch or a failed read of GitHub."),
})

/** The result of removing a worktree. */
export type RemovedWorktree = z.output<typeof removedSchema>

/** How a branch was proven to have landed. */
export type Landed = z.output<typeof landedSchema>
