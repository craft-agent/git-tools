import { worktreeAdd } from "../core/worktree/add"
import { WORKTREE_ROOT_OPTION } from "../core/worktree/layout"
import { worktreeRead } from "../core/worktree/read"
import { worktreeRemove } from "../core/worktree/remove"
import type { TempRepo } from "../testing/git-repo"
import { worktreeRootOf } from "../testing/worktree-fixtures"
import type { PluginDeps } from "./shared"
import type { V2Context, V2OperationError, V2Tool, V2WorktreeDefinition } from "./types"
import { createV2Setup } from "./v2"

/** Fixtures the tests of the OpenCode worktree strategy share. */

export const SESSION_ID = "ses_1"
export const PROJECT_ID = "prj_1"

/** The three worktree tools, which a harness here selects with the `worktree` toolset. */
const WORKTREE_SPECS = [worktreeRead, worktreeAdd, worktreeRemove]

export type HarnessOptions = {
  options?: Record<string, unknown>
  /** The directory of the session. */
  directory: string
  /** The session's project; `PROJECT_ID` when absent, none when `null`. */
  projectID?: string | null
  /** Leaves `ctx.worktree` out, as a harness without worktree strategies does. */
  withoutWorktree?: boolean
  /** What `worktree.refresh` does; it resolves when absent. */
  refresh?: NonNullable<V2Context["worktree"]>["refresh"]
}

/** A fake V2 context that keeps what the plugin registers and which projects it refreshed. */
export function harness(fake: HarnessOptions) {
  const tools = new Map<string, V2Tool>()
  const definitions: V2WorktreeDefinition[] = []
  const refreshed: string[] = []
  const projectID = fake.projectID === undefined ? PROJECT_ID : (fake.projectID ?? undefined)
  const ctx: V2Context = {
    options: fake.options,
    session: { get: async () => ({ projectID, location: { directory: fake.directory } }) },
    permission: { assert: async () => {} },
    tool: { transform: async (callback) => callback({ add: (tool) => tools.set(tool.name, tool) }) },
    skill: { transform: async () => {} },
    worktree: fake.withoutWorktree
      ? undefined
      : {
          transform: async (callback) => callback({ add: (definition) => definitions.push(definition) }),
          async refresh(input) {
            refreshed.push(input.projectID)
            return fake.refresh?.(input)
          },
        },
  }
  return { ctx, tools, definitions, refreshed }
}

/** The plugin options that turn the worktree toolset on and put the worktrees under the test's root. */
export function worktreeOptions(repo: TempRepo): Record<string, unknown> {
  return { toolsets: ["worktree"], [WORKTREE_ROOT_OPTION]: worktreeRootOf(repo) }
}

/** Sets the plugin up against a fake context for `repo`'s working tree, with the worktree toolset on unless `fake.options` says otherwise. */
export async function setUpWorktrees(
  repo: TempRepo,
  fake: Partial<HarnessOptions> = {},
  deps: PluginDeps = {},
): Promise<ReturnType<typeof harness>> {
  const fakeContext = harness({ directory: repo.dir, options: worktreeOptions(repo), ...fake })
  await createV2Setup(WORKTREE_SPECS, { env: {}, ...deps })(fakeContext.ctx)
  return fakeContext
}

/** The strategy the plugin registered. */
export function strategyOf(fakeContext: ReturnType<typeof harness>): V2WorktreeDefinition {
  return fakeContext.definitions[0]!
}

/** A stand-in for OpenCode's `Worktree.OperationError`. */
export class FakeOperationError extends Error {
  readonly forceRequired: boolean

  constructor(input: ConstructorParameters<V2OperationError>[0]) {
    super(input.message)
    this.forceRequired = input.forceRequired ?? false
  }
}
