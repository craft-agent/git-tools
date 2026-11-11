import { z } from "zod"

/** What adding a worktree returns. */
export const addedSchema = z.object({
  directory: z
    .string()
    .describe("The real path of the new worktree; use it as the working directory to work on the branch."),
  branch: z.string().describe("The branch checked out in the worktree."),
  new_branch: z.boolean().describe("Whether the call created the branch; false when it checked out an existing one."),
  base: z
    .object({
      ref: z.string().describe("What the branch was cut from, as given or resolved, such as origin/main."),
      sha: z.string().describe("The full id of the commit the branch starts at."),
    })
    .nullable()
    .describe("Where a new branch starts; null for an existing branch, which is checked out as it is."),
  fetched: z
    .boolean()
    .nullable()
    .describe(
      "Whether origin was fetched first and the fetch succeeded; null when nothing was fetched (an existing branch, or no origin).",
    ),
  warnings: z.array(z.string()).describe("What does not stop the call but is worth knowing, such as a failed fetch."),
})

/** The result of adding a worktree. */
export type AddedWorktree = z.output<typeof addedSchema>
