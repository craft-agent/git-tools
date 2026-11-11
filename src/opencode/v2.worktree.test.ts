import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { PROJECT } from "../project"
import { tempRepo, type TempRepo } from "../testing/git-repo"
import { worktreeRootOf } from "../testing/worktree-fixtures"
import type { V2WorktreeDefinition } from "./types"
import { PROJECT_ID, SESSION_ID, setUpWorktrees, strategyOf, worktreeOptions } from "./worktrees.testing"

type CreatedWorktree = Awaited<ReturnType<V2WorktreeDefinition["create"]>>

const repos: TempRepo[] = []
const signal = new AbortController().signal

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

async function open(): Promise<TempRepo> {
  const repo = await tempRepo()
  repos.push(repo)
  return repo
}

const context = { sessionID: SESSION_ID, signal }

describe("V2 worktree strategy registration", () => {
  test("registers once, under the project's name, when the worktree toolset is on", async () => {
    const repo = await open()

    const { definitions, tools } = await setUpWorktrees(repo)

    expect(definitions.map((definition) => definition.id)).toEqual([`${PROJECT.name}.worktrees`])
    expect([...tools.keys()]).toEqual(["git_worktree_read", "git_worktree_add", "git_worktree_remove"])
  })

  test("registers with only a worktree tool that writes selected, whatever the toolsets", async () => {
    const repo = await open()

    const { definitions } = await setUpWorktrees(repo, { options: { tools: ["git_worktree_remove"] } })

    expect(definitions).toHaveLength(1)
  })

  test("does not register with the toolset off, read-only, or without a worktree tool that writes", async () => {
    const repo = await open()
    const withoutWriters = { ...worktreeOptions(repo), exclude_tools: ["git_worktree_add", "git_worktree_remove"] }

    for (const options of [
      {},
      { tools: ["git_worktree_read"] },
      { ...worktreeOptions(repo), read_only: true },
      withoutWriters,
    ]) {
      const { definitions } = await setUpWorktrees(repo, { options })
      expect(definitions).toEqual([])
    }
  })

  test("sets up without failing when the harness has no worktree support", async () => {
    const repo = await open()

    const { tools, definitions } = await setUpWorktrees(repo, { withoutWorktree: true })

    expect(tools.size).toBe(3)
    expect(definitions).toEqual([])
  })
})

describe("V2 worktree inventory refresh", () => {
  test("git_worktree_add refreshes the session's project once after it succeeds", async () => {
    const repo = await open()
    const { tools, refreshed } = await setUpWorktrees(repo)

    const result = await tools.get("git_worktree_add")!.execute({ branch: "task/x" }, context)

    expect(existsSync(join(worktreeRootOf(repo), "origin", "task-x"))).toBe(true)
    expect(result.output).toMatchObject({ branch: "task/x" })
    expect(refreshed).toEqual([PROJECT_ID])
  })

  test("git_worktree_remove refreshes the session's project once after it succeeds", async () => {
    const repo = await open()
    const { tools, refreshed } = await setUpWorktrees(repo)
    const { output } = await tools.get("git_worktree_add")!.execute({ branch: "task/x" }, context)
    refreshed.length = 0

    await tools.get("git_worktree_remove")!.execute({ directory: (output as CreatedWorktree).directory }, context)

    expect(refreshed).toEqual([PROJECT_ID])
  })

  test("a failed call does not refresh", async () => {
    const repo = await open()
    const { tools, refreshed } = await setUpWorktrees(repo)

    await expect(tools.get("git_worktree_add")!.execute({ branch: "-bad" }, context)).rejects.toThrow(
      "invalid_argument",
    )
    await expect(
      tools.get("git_worktree_remove")!.execute({ directory: join(repo.home, "nope") }, context),
    ).rejects.toThrow("not_found")

    expect(refreshed).toEqual([])
  })

  test("a failing refresh does not fail the call", async () => {
    const repo = await open()
    const { tools, refreshed } = await setUpWorktrees(repo, {
      refresh: async () => {
        throw new Error("service unavailable")
      },
    })

    const result = await tools.get("git_worktree_add")!.execute({ branch: "task/x" }, context)

    expect(result.output).toMatchObject({ branch: "task/x" })
    expect(refreshed).toEqual([PROJECT_ID])
  })

  test("a read tool does not refresh", async () => {
    const repo = await open()
    const { tools, refreshed } = await setUpWorktrees(repo)

    await tools.get("git_worktree_read")!.execute({ method: "list" }, context)

    expect(refreshed).toEqual([])
  })

  test("a session with no project, or a harness with no refresh, refreshes nothing and fails nothing", async () => {
    const repo = await open()
    const noProject = await setUpWorktrees(repo, { projectID: null })
    const noRefresh = await setUpWorktrees(repo)
    noRefresh.ctx.worktree!.refresh = undefined

    await noProject.tools.get("git_worktree_add")!.execute({ branch: "task/a" }, context)
    await noRefresh.tools.get("git_worktree_add")!.execute({ branch: "task/b" }, context)

    expect(noProject.refreshed).toEqual([])
    expect(noRefresh.refreshed).toEqual([])
  })

  test("a harness with no worktree support runs the call as before", async () => {
    const repo = await open()
    const { tools } = await setUpWorktrees(repo, { withoutWorktree: true })

    const result = await tools.get("git_worktree_add")!.execute({ branch: "task/x" }, context)

    expect(result.output).toMatchObject({ branch: "task/x" })
  })
})

describe("the registered strategy", () => {
  test("is the one a refresh lists, with the layout the tools use", async () => {
    const repo = await open()
    const fake = await setUpWorktrees(repo)
    const { output } = await fake.tools.get("git_worktree_add")!.execute({ branch: "task/x" }, context)

    expect(await strategyOf(fake).list(repo.dir)).toEqual([
      { directory: repo.dir, type: "root" },
      { directory: (output as CreatedWorktree).directory, type: "worktree" },
    ])
  })
})
