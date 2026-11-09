import { z } from "zod"
import { conflictMapSchema } from "../conflicts"

/** How many trailing lines of git's output a paused result carries. */
export const OUTPUT_TAIL_LINES = 40

const commitSchema = z.object({
  sha: z.string().describe("The short commit id."),
  subject: z.string().describe("The first line of the commit message."),
})

/** A commit as the paused result names it: its short id and its subject. */
export type StoppedCommit = z.output<typeof commitSchema>

const pausedSchema = z.object({
  reason: z
    .enum(["conflicts", "empty", "stopped"])
    .describe(
      '"conflicts": files hold conflicts to resolve. "empty": the commit has nothing left, since its change is already in the base. "stopped": something else stopped it, such as a failing hook or an exec step.',
    ),
  stopped_on: commitSchema
    .nullable()
    .describe("The commit being replayed when the rebase stopped; null when git names none."),
  conflicts: conflictMapSchema
    .nullable()
    .describe("The conflicted files with their marker regions; null unless the reason is conflicts."),
  unresolved: z
    .array(z.string())
    .optional()
    .describe("continue: the conflicted files that still hold conflict markers, so nothing was run."),
  output: z.string().describe(`The last ${OUTPUT_TAIL_LINES} lines of git's output.`),
  next: z.string().describe("What to do now: resolve and continue, skip, or abort."),
})

const layerSchema = z.object({
  branch: z.string().describe("The layer branch."),
  before: z.string().describe("The short id of the branch's tip before the rebase."),
  after: z.string().describe("The short id of the branch's tip now."),
})

/** What `git_rebase_start` and `git_rebase_resume` return: the rebase's status and the layers it moved. */
export const rebaseOutcomeSchema = z.object({
  status: z
    .enum(["done", "up_to_date", "paused", "aborted"])
    .describe(
      '"done": the rebase finished. "up_to_date": there was nothing to do and git was not run. "paused": it stopped, see paused. "aborted": the rebase was abandoned and the branches are back where they were.',
    ),
  branch: z
    .string()
    .nullable()
    .describe("The branch checked out now; null while the rebase is stopped, since HEAD is detached then."),
  top: z.string().describe("The branch the rebase runs on, the top of the stack."),
  onto: z
    .object({
      ref: z.string().nullable().describe("The ref the rebase goes onto, as it was named; null when none was."),
      sha: z.string().describe("The short id of the commit the rebase goes onto."),
    })
    .nullable()
    .describe("What the rebase goes onto; null when it is not known."),
  layers: z
    .array(layerSchema)
    .describe("Every layer branch the rebase moves, or moved back, bottom to top, with its tip before and now."),
  folded: z
    .number()
    .int()
    .describe("How many fixup!, squash! or amend! commits were folded in; 0 when it is not known."),
  needs_force_push: z
    .array(z.string())
    .describe("The layers' own remote branches (such as origin/feat) that the new tips no longer contain."),
  warnings: z.array(z.string()).describe("What was not checked and may still stop a push."),
  paused: pausedSchema.optional().describe("Why the rebase stopped and what to do; set when status is paused."),
})

/** What the rebase tools return. */
export type RebaseOutcome = z.output<typeof rebaseOutcomeSchema>
