# Tool conventions

The git tools follow github-tools'
[tool conventions](https://github.com/craft-agent/github-tools/blob/6d7ef6e7fe0d1bc9bf8ba0ca825b545aa3143dda/docs/conventions.md),
and this file records only where git differs. Each rule carries the reason it
was chosen; the discussion behind them is on
[#3](https://github.com/craft-agent/git-tools/issues/3).

## What holds as it is

Everything github-tools' conventions say that this file does not change:
one read tool per domain with a `method`, one write tool per operation,
snake_case, flat list arguments, plain-object results, the five write classes
and the annotations each sets, the harness confirming writes, `read_only`,
`tools`, `exclude_tools` and `confirm`, and the core contract a tool spec
follows.

## Scope

- **git only, with any remote.** No tool writes to GitHub. Pull requests,
  native stacks and reads of GitHub belong to github-tools, so this package
  works the same against any git host.
- **One exception: safety reads.** Where a git rule needs a fact only GitHub
  has — whether a branch is protected against force pushes, whether a
  squash-merged branch landed — it reads that through github-tools'
  functions, and only when `origin` is on GitHub. Elsewhere the rule falls
  back to what git alone can prove, and refuses or keeps rather than guesses.

## Names

- **Tool IDs are `git_<domain>_<verb>`.** git's commands are verbs (`add`,
  `commit`, `rebase`, `push`), unlike `gh`'s noun groups, so the domain is the
  object git acts on and the verb is git's command name. github-tools' own
  verbs (`read`, `ensure`, …) fill in where git has none.
- **Five domains, one toolset each**:

  | Domain     | Covers                                                                                     |
  | ---------- | ------------------------------------------------------------------------------------------ |
  | `repo`     | local reads: status, history, where a change came from (blame, pickaxe), conflicts         |
  | `commit`   | staging, the checks before a commit, committing, amending and fixups, checking each commit |
  | `rebase`   | rebasing, stacked branches (layer branches rebased together) and the rewrite rule          |
  | `worktree` | creating, listing and removing worktrees                                                   |
  | `push`     | pushing one or more branches                                                               |

  Five toolsets let a consumer allow committing without rewriting or pushing;
  one per command would add read tools without a useful boundary.

- **On by default: `repo`, `commit` and `rebase`**, the everyday local work.
  `worktree` and `push` are opt-in.

## Write classes

| Operation                                      | Class             | Why                                                                            |
| ---------------------------------------------- | ----------------- | ------------------------------------------------------------------------------ |
| Every domain's read, the push preview included | read              | changes nothing                                                                |
| Staging hunks                                  | idempotent change | staging the same hunks again leaves the same index; no file is lost            |
| Committing, a fixup commit                     | add               | adds a commit; nothing that was there goes                                     |
| Cutting layer branches, adding a layer         | add               | adds branches                                                                  |
| Creating a worktree                            | add               | adds a directory and a branch                                                  |
| Amending                                       | overwrite         | replaces the commit at HEAD                                                    |
| Rebasing, rebasing stacked branches            | overwrite         | rewrites history (the reflog can still restore it)                             |
| Removing a worktree                            | overwrite         | ignored files in it are lost; it is never forced, and an unlanded branch stays |
| Checking each commit                           | administrative    | runs a command the caller names, which can do anything                         |
| Pushing                                        | administrative    | publishes: others see it and CI runs                                           |

- **Local history rewrites are `overwrite`, not `administrative`.** They ask
  in every harness and a person can still allow them; `administrative` would
  make a client ask even under an allow rule, stopping the everyday fold of a
  fixup. A rewrite of pushed commits stays local until it is pushed, and
  pushing is `administrative`.
- **`openWorldHint` is `true` for a tool any of whose arguments can reach
  outside the machine** — a fetch, a push, a safety read of GitHub — and
  `false` only for one that stays on it. Reading a remote counts: the hint is
  about interacting with external entities, not only writing to them.

## Pinned writes

- **What a write relies on is pinned in its arguments, never in an opaque
  token.** The harness's approval shows a call's arguments, so a write that
  names what it expects shows the person exactly what will happen.
- **Pushing** takes, per branch, the commit to push and the remote commit it
  expects, and leases on that commit. The push preview, a method of the
  domain's read tool, returns exactly those arguments.
- **Hunk staging** takes the digest of the diff its listing showed, with the
  hunks it names, so a listing that went stale never stages other hunks.
- Either throws `stale` when what it pinned has changed.

## Results and errors

- **An operation that paused is a result.** A rebase, or a rebase of stacked
  branches, that stopped on conflicts or on a commit that became empty
  returns `status: "paused"` with the reason and what the caller needs to
  continue, skip or abort (the conflict map). Nothing failed: the repository
  is in a new state.
- **An operation that did not happen throws**, with structured `details`
  beside the code and message: lint violations, secret findings, hook output,
  the rewrite rule's refusals. The caller needs them to fix the cause, and a
  message string would lose their structure.
- **Codes added to the shared ones**:

  | Code                    | When                                                                            |
  | ----------------------- | ------------------------------------------------------------------------------- |
  | `not_a_repository`      | the working directory is not inside a git repository                            |
  | `dirty_tree`            | uncommitted changes stand in the way of the operation                           |
  | `operation_in_progress` | another rebase, merge or cherry-pick is in progress                             |
  | `rewrite_refused`       | the rewrite rule refuses to rewrite these commits                               |
  | `check_failed`          | a check before the operation failed; `details` says which (lint, secrets, hook) |
  | `git_missing`           | git is not installed                                                            |
  | `git_too_old`           | git is older than the tools need                                                |
  | `git_error`             | git failed for another reason; the message carries its text                     |

  A missing commit or branch is `not_found`. A pinned write whose state
  changed is `stale`, as is a push the remote moved under.

## Settings

Beside github-tools' settings, under this package's names:

- **`worktree_root`**: where task worktrees go.
- **The published-text rules**: words a pushed commit subject or branch name
  must not carry.

Both have neutral defaults, set when their domains are reviewed (#8, #9).

## The git runner

- **Every git call goes through one runner**, shaped like github-tools'
  `gh` runner.
- **An allowlisted environment**: the same variables the `gh` runner passes
  (search path, home, SSH agent, proxies, `gh`'s authentication, so
  `gh auth git-credential` keeps working for HTTPS pushes), plus
  `GIT_TERMINAL_PROMPT=0`, `GIT_EDITOR=true`, `GIT_SEQUENCE_EDITOR=true`,
  `GIT_PAGER=cat` and `NO_COLOR=1`. Nothing waits on a prompt or an editor,
  and the rest of the caller's environment, its secrets included, never
  reaches git or a hook.
- **The locale is not forced.** Tools parse only porcelain and plumbing
  formats, so git's messages and hook output reach the person in their own
  language.
- **A time limit** of 120 s by default, and a stopped call has its child
  killed (`SIGTERM`, then `SIGKILL` after two seconds). Checking each commit
  takes the caller's limit.
- **The git version is checked once per process** against the oldest git
  that has every option the tools use.
- **Hooks run where the person's own command would run them**: committing,
  rebasing, pushing, as the repository configures them, never with
  `--no-verify`. They are turned off only for the tools' own plumbing (a
  throwaway worktree and its checkout, a new worktree's checkout). There is
  no setting to turn them off: a commit that skips the repository's checks
  fails later, in CI.

## Skills

- **One skill per domain**: `git-repo`, `git-commit`, `git-rebase`,
  `git-worktree` and `git-push`, named for what they cover with the product in
  the name; the native entry points register them under the short names
  (`repo`, `commit`, …). A consumer that turns a toolset off loses no skill it
  can still use.
- **A skill says how to use its tools, never a working method.** How to cut a
  change into commits or word a message stays with the consumer's own
  instructions.

## Tests

- **Real repositories in a temporary directory**, with a local bare
  repository as the remote. git itself is the fixture: a fake would only
  restate what the tests assume.
- **GitHub reads go through github-tools' fake `gh`.** No test reaches the
  network.
