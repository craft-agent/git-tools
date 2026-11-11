import { z } from "zod"
import { isToolError, ToolError } from "../errors"
import { ghGraphql, githubRepo, PROTECTION_READ_TIMEOUT_MS, type GhOptions, type GithubRepo } from "../gh"
import { gitResult } from "../git"
import { REMOTE_REFS_PREFIX } from "../rewrite"
import { isAncestor } from "../tree"
import { hasOrigin, ORIGIN_REMOTE } from "./add-plan"
import { fetchOrigin, originDefault } from "./add-run"
import type { Landed } from "./remove-schema"

/** The time limit of the read of merged pull requests: the protection read's, which fits an approval prompt's. */
const LANDED_READ_TIMEOUT_MS = PROTECTION_READ_TIMEOUT_MS

/** How many merged pull requests of a branch name the read looks at. */
const MERGED_PULL_REQUESTS_READ = 50

/** The merged pull requests whose head ref is `$branch`: `states: MERGED` leaves out open and closed ones. */
const MERGED_QUERY = `query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $branch, states: MERGED, first: ${MERGED_PULL_REQUESTS_READ}) {
      nodes { number headRefOid headRepository { nameWithOwner } }
    }
  }
}`

const mergedReplySchema = z.object({
  repository: z
    .object({
      pullRequests: z.object({
        nodes: z.array(
          z
            .object({
              number: z.number().int(),
              headRefOid: z.string(),
              headRepository: z.object({ nameWithOwner: z.string() }).nullable(),
            })
            .nullable(),
        ),
      }),
    })
    .nullable(),
})

/** What the proof of a landed branch found, and what could not be checked on the way. */
export type ProvenLanded = { landed: Landed | null; warnings: string[] }

/**
 * The number of a merged pull request of `repo` whose head is the commit `tip`
 * of `branch`, onto any base, or null when there is none. A pull request from a
 * fork, or from a repository since deleted, never counts. Throws `not_found`
 * when GitHub has no such repository, and whatever `ghGraphql` throws.
 */
async function mergedPullRequest(
  repo: GithubRepo,
  branch: string,
  tip: string,
  options: Omit<GhOptions, "timeoutMs">,
): Promise<number | null> {
  const data = await ghGraphql<unknown>(
    MERGED_QUERY,
    { owner: repo.owner, name: repo.name, branch },
    { ...options, timeoutMs: LANDED_READ_TIMEOUT_MS },
  )
  const reply = mergedReplySchema.safeParse(data)
  if (!reply.success) throw new ToolError("upstream_error", "GitHub's reply about the pull requests could not be read.")
  if (!reply.data.repository) throw new ToolError("not_found", `${repo.owner}/${repo.name} is not on GitHub`)
  const own = `${repo.owner}/${repo.name}`.toLowerCase()
  const match = reply.data.repository.pullRequests.nodes.find(
    (node) => node?.headRefOid === tip && node.headRepository?.nameWithOwner.toLowerCase() === own,
  )
  return match?.number ?? null
}

/**
 * Whether `branch`, whose tip is `tip`, has landed. With an `origin`, it is
 * fetched first (a failed or slow fetch is a warning, and the proof then rests
 * on the last fetch), and the branch has landed when `tip` is an ancestor of
 * origin's default branch. When that does not prove it and `origin` is on
 * GitHub, a merged pull request of that repository whose head commit is `tip`,
 * onto any base, does (a squash or rebase merge leaves no ancestry). A failed
 * read of GitHub is a warning, and the branch counts as not landed. A
 * repository with no `origin` has nothing to prove it against.
 */
export async function provenLanded(request: {
  root: string
  branch: string
  tip: string
  signal?: AbortSignal
}): Promise<ProvenLanded> {
  const { root, branch, tip, signal } = request
  const warnings: string[] = []
  if (!(await hasOrigin(root, signal))) return { landed: null, warnings }

  const fetched = await fetchOrigin(root, signal)
  const base = await originDefault(root, signal)
  if (!fetched) {
    warnings.push(`fetching ${ORIGIN_REMOTE} failed: ${base?.ref ?? "its default branch"} is as of the last fetch`)
  }
  if (base && (await isAncestor(root, tip, `${REMOTE_REFS_PREFIX}${base.ref}`, signal))) {
    return { landed: { by: "ancestry", into: base.ref }, warnings }
  }

  const url = await gitResult(["remote", "get-url", ORIGIN_REMOTE], { cwd: root, signal })
  const repo = url.code === 0 ? githubRepo(url.stdout) : null
  if (!repo) return { landed: null, warnings }
  try {
    const number = await mergedPullRequest(repo, branch, tip, { cwd: root, signal })
    if (number !== null) return { landed: { by: "pull_request", number }, warnings }
  } catch (error) {
    if (!isToolError(error)) throw error
    warnings.push(`could not read GitHub's pull requests for ${branch}: ${error.message}; the branch stays`)
  }
  return { landed: null, warnings }
}
