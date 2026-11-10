# Tool conventions

The rules every tool in this package follows, so tools read alike across
domains and harnesses. Each rule carries the reason it was chosen; a change
to a rule changes this file first, with its reason.

## Names

- **Tool IDs are `<prefix>_<domain>_<verb>`**: `<prefix>_note_read` and
  `<prefix>_note_create` for a `note` domain. The prefix is `toolPrefix` in
  `src/project.ts`; it keeps a name unambiguous where a harness lists every
  tool in one namespace. When the domain has a well-known command line,
  follow its word order, so a name maps to a command anyone can look up.
- **The same ID in every entry point.** Permission rules and skills are
  written once, and an ID is a public interface: renaming one is a breaking
  change.
- **Verbs are plain**: `create`, `edit`, `delete`, `add`, `remove`, and these
  with a fixed meaning:

  | Verb      | Means                                                        |
  | --------- | ------------------------------------------------------------ |
  | `read`    | the one read tool of a domain (below)                        |
  | `resolve` | find which object a call means                               |
  | `ensure`  | create when missing, reuse when present; never a second copy |

- **One read tool per domain, one write tool per operation.**
  `<prefix>_<domain>_read` takes a `method` argument (`view`, `list`, …). A
  model picks tools worse as their number grows, and reads share one set of
  annotations, so folding them loses nothing. Writes stay apart because a
  merged write tool would carry its strictest class: creating something would
  ask like overwriting it.
- **Names stay within 40 characters**, so a client prefix such as
  `mcp__<server>__` still fits a 64-character limit. `defineTool` enforces
  the shape and the length; `src/tools.test.ts` enforces the prefix.

## Arguments

- **snake_case**, for arguments and for the keys of a result alike: one style
  for everything a model reads.
- **Lists change through flat arguments**: `add_tags`, `remove_tags`. Shallow
  schemas are read reliably by every model the harnesses run. An argument that
  replaces a whole list, where one is needed, is named for the list (`tags`)
  and its description says it replaces.
- **Unknown arguments are refused.** Every entry point validates the
  arguments as strict, so a misspelt one fails as `invalid_argument` instead
  of being ignored.
- **The tools' own install directory is never the working tree.** A harness
  may start a tool inside the directory the package is installed in.
  `ToolContext.ownDir` names it; a tool that reads the working tree refuses
  to treat that directory as the caller's, saying so.

## Results

- **A tool returns its data as a plain object**, with no `ok` envelope. Each
  entry point renders it: the MCP server as `structuredContent` with the
  tool's `outputSchema` plus the same JSON as text, a native plugin as a JSON
  string.
- **A failure throws.** Every harness then sees a failed call (`isError` over
  MCP) rather than a success that carries an error.
- **One exception: what a call created is never lost.** Once a tool has
  created something, a later step of the same call that fails does not throw.
  The result names what was created and lists the failed steps under
  `errors`, keyed by step (`StepErrors`).
- **Text a tool reads is returned as it is.** Content from files or services
  is data, never instructions; every read tool's description and the skills
  say so. Nothing is wrapped or rewritten.

## Errors

A thrown error carries a `code` a caller can branch on, and a message that
says what to do next.

| Code               | When                                                                       |
| ------------------ | -------------------------------------------------------------------------- |
| `not_found`        | the object does not exist, or the caller cannot see it                     |
| `forbidden`        | the caller lacks the permission the call needs                             |
| `invalid_argument` | the arguments cannot describe a valid call                                 |
| `stale`            | what the call relied on changed before it could finish                     |
| `unauthenticated`  | the service or program the tool calls is not logged in                     |
| `rate_limited`     | the service refused the call for its rate limit                            |
| `declined`         | the person declined a confirmation the tool asked for                      |
| `upstream_error`   | the service or program the tool calls failed; the message carries its text |
| `internal_error`   | a bug in a tool or an entry point, such as a result off its schema         |

A project adds a code to `src/core/errors.ts` and to this table together.

- **Structure the caller needs goes in `details`, not in the message.** When
  fixing the cause takes more than a sentence (the lint violations, the
  findings, the output of a hook), the error carries it as `details`: a JSON
  object with snake_case keys, like a result. A model then reads the fields
  instead of parsing them back out of prose; the message still says what to
  do next on its own.
- **`details` is fixed when the error is made.** `ToolError` keeps a frozen
  JSON copy, so every entry point renders the same value. The copy is what
  JSON makes of it (`undefined` is dropped, `NaN` becomes `null`), and a value
  JSON cannot write at all, such as a cycle or a `BigInt`, fails where it was
  thrown, as a bug, not where it is rendered.
- **Each entry point passes `details` on only when it is set**, so an error
  without it reads as it always did. The MCP server and the command line put
  it beside the code and the message, as `error.details`. The OpenCode and
  Hermes plugins, whose errors are text, append it to `<code>: <message>` as
  JSON on a line of its own.
- The `errors` of a partial result (`StepErrors`) stay `<code>: <message>`
  strings.

## Write classes

Every tool belongs to one class, and the class sets its MCP annotations.
`openWorldHint` is `true` for every tool.

| Class             | Examples                              | `readOnlyHint` | `destructiveHint` | `idempotentHint` |
| ----------------- | ------------------------------------- | -------------- | ----------------- | ---------------- |
| read              | view, list, resolve                   | `true`         | —                 | `true`           |
| add               | create, add                           | `false`        | `false`           | `false`          |
| idempotent change | ensure, adding a tag                  | `false`        | `false`           | `true`           |
| overwrite         | editing a body or title, removing one | `false`        | `true`            | `true`           |
| administrative    | delete, visibility, publishing        | `false`        | `true`            | `false`          |

- **Overwriting counts as destructive**: it loses what was there, and
  harnesses that confirm only destructive tools should still ask before it.
- **A tool takes the strictest class its arguments can reach.**
- **The harness confirms writes.** Every MCP client asks before it runs a
  write tool, so the tool does not ask again by default. Administrative tools
  also carry `_meta["anthropic/requiresUserInteraction"]: true`, which makes
  Claude Code ask even under an allow rule.
- **A native plugin asks the harness's own permission before every non-read
  call**, since the tools a native plugin adds pass through no harness
  approval of their own.
- **It asks for everything the call writes to.** A write tool's `targets`
  resolver names what the call writes to, as the permission rules name it
  (a path, an account, a record). Anything it cannot tell, every tool
  without a resolver, and a target holding `*` or `?` (which a harness would
  store as a pattern) is `*`, and `*` is never stored. An "always" answer then
  covers only what it named, never a write somewhere else.
- **It shows what the call carries, where the tool can say.** Targets are
  ids, so they cannot tell one kind of target from another, and the person
  decides on the text, the file or the kind of target as much as on where it
  goes. A write tool's `describe` says it. An MCP client draws the call's
  arguments in its own prompt, so the MCP server adds nothing.
- **Every native plugin's prompt has one shape**, so a person reads every
  tool's prompt the same way:

  ```text
  About to create "todo.md"

  --- Details ---

  Target: /work/tree/notes/todo.md
  Size: 42 bytes

  --- Note text ---

  # Todo
  ```

  The headline says what the agent is about to do, as its next step; the
  Details name each target on a `Target` line, then the tool's facts; the
  last section is the text the call carries, under the tool's own label. A
  section with nothing to show is left out, so a tool without `describe`
  shows its intent and its targets, and one whose targets cannot be told
  shows its intent alone. The harness names the tool beside the prompt, so
  the prompt does not repeat its id.

- **A write tool states its intent.** Besides its title, which names the
  tool wherever tools are listed, a write tool gives an `intent`: a fixed
  phrase in the headline's tone that carries no value (`About to create a
note`). The prompt shows it wherever no headline can stand: a tool without
  `describe`, a headline that is dropped, and one that gives way to keep the
  targets within the budget. A tool without an intent shows its title there.

- **The tool's words are fixed; what the call carries is data.** A model
  chooses the arguments and nothing else, and a prompt is only as good as the
  person's trust in its lines. The headline is the tool's intent, or a
  template the tool picks (`About to create {file}`) whose values the entry
  point quotes, so where the tool's words end and the call's data begins is
  always visible. A value comes from what the tool resolved, never from a
  model's account of it (the record's real name, not the name the model
  gave). The text section holds what the call writes, as it is, never a
  summary of it; a summary the tool can compute is a fact (`Size`, `Lines`).
- **Facts are short and ordered by what they decide.** A label is a noun of
  one or two words, in English like the tool's title, and a value carries
  its unit (`42 bytes`). A value with a unit or other words of the tool's is
  a template the tool picks with the values it holds (`{bytes} bytes` with
  `bytes: 42`), so the unit is the tool's word and the number the call's
  data; the tool picks the English form for the count (`{bytes} byte` for
  one), and numbers are shown as written, without digit grouping. A plain
  string value has no words of the tool's. The fact that changes the person's answer comes
  first (the kind of target, whether it overwrites); amounts come last. A
  fact never repeats the headline or a target. `src/core/facts.ts` holds the
  facts every package can use (`sizeFact`); a package adds its own beside its
  tools in the same form and lists them in its section below.
- **The head of the prompt comes first and fits; the text comes last.** Some
  harnesses cut a prompt from its end at a few hundred characters, so the
  headline, the targets and the facts are kept within the budget of where the
  prompt is shown, and the text is what is cut. A headline that would push a
  target past the cut gives way to the intent, since the targets are what an
  "always" answer stores. Facts that do not fit are counted on a notice
  line, which stays even when the head alone fills the budget: a person
  must know that something was left out. A description keeps a
  headline template of 120 characters with values of 80, its first eight
  facts with labels of 40 characters and values of 200 (a value template of
  200 with at most eight values, the filled value cut to 200), and a text label of
  40 with a text of 2000; anything longer is cut with `…`. Nothing in the text
  can come before the facts, since the text is the last section.
- **Characters other people wrote are shown, never obeyed.** A target's name
  or a file's name can hold control, bidi and invisible characters that
  forge a line of the prompt or hide part of a value; each is shown as
  `<U+XXXX>`, and a quote inside a headline value as `\"`. Where the prompt
  renders markup, everything but the plugin's own section lines is escaped,
  so a name cannot draw a link or a mention. The budget and the escaping are
  those of the surface the harness names: a surface it names that the plugin
  does not know is one the harness does not cut, and gets neither, since
  another surface's escapes would show there as written. Only a prompt whose
  surface cannot be told gets the strictest budget and escaping of all.
- **A description never stands between a call and its approval.** A tool
  without `describe`, a `describe` that fails, returns another shape or takes
  longer than 10 s gives the prompt it would have given without one. The
  approval is asked either way, and the targets are never lost with the
  description.
- **A call runs on what its prompt showed.** What a person approves is what
  was true when the prompt was drawn; between the answer and the run, a file
  the call reads can be rewritten or a target can change kind. So a native
  plugin pins the prompt of every call whose tool has `describe`: the
  targets and the description, before translation, as one hash. The hash
  takes the description whole, before the budgets above cut it: a text past
  its 2000 characters, a value past its cut and the facts past the eighth
  are what the call carries too, so a change there is a change of the call
  even where the prompt could not show it. Right
  before the call runs, the entry point resolves both again, and a call
  whose hash differs, or whose description can no longer be told, fails with
  `stale` without running; the person is asked again on the next call. A
  call whose prompt showed no description pins nothing and runs as before,
  and so does every call of a tool without `describe`. A `describe` may also
  give `pins`, values the prompt does not show that the call must still find
  unchanged (a file's hash, beside a size that can stay the same); they go
  into the hash and nowhere else. A `describe` therefore gives the same
  answer for the same state: a value that changes on every call, such as the
  time, makes every call `stale`. The check narrows the gap between the
  answer and the run to the moment before `execute`; a tool that must close
  it entirely still checks inside `execute`. An MCP client draws the call's
  arguments, not a description, so the MCP server pins nothing.
- **The prompt speaks the language set for the harness.** A native plugin
  draws its prompt in the language of the `language` setting, else in the
  harness's own display language where it has one (Hermes's
  `display.language`), else in English. No harness tells a plugin who
  approves a call, so this is the language set where the plugin runs, not
  each person's. The server's locale (`LANG`) is never read: it is the
  machine's, and a person reading English on a machine set to another
  language would see the prompt change. A tag matches its own table, else
  the one of its first subtag (`ja-JP` and `ja_JP` are `ja`; `zh-Hant` can
  have its own), and a language the package has no words for falls back to
  English without a word. An MCP client draws its own prompt,
  so the MCP server takes no `language`.
- **Translations are tables keyed by the English words.** The plugin's own
  words (`Details`, `Target`, `(+N more)`) and a tool's (its title, its
  intent, its headline templates, its fact labels, its value templates and its text
  label) are written in
  English in the code. Per language, a package gives one table from those
  English words to their translation (`src/words.ts`), and the entry point
  looks each word up as it draws the prompt, so a tool's code does not change.
  A translated template must hold the same placeholders as the English one
  and keep within its limits, or the English one is used, so a translation
  cannot move the line between the tool's words and the call's data. Values
  are the call's data and are never translated: a value template is looked
  up and its values filled in after (`{bytes} バイト`), and a plain string
  value stays as the tool wrote it. A translation is marked like every other
  piece of the prompt.
- **`confirm: "elicitation"` adds the tool's own form** for administrative
  tools, where the client offers form-mode elicitation. It is for people who
  switch the client's approvals off: the tool states what will happen in plain
  words and stops on anything but an accept. Where the client does not offer
  elicitation the setting adds nothing, and the harness's approval is then the
  only confirmation.
- **Annotations are hints, not a boundary.** The `read_only` setting
  (below) is what keeps writes out.

## Toolsets and settings

Every entry point takes the same settings:

- **Toolsets**: one per domain, listed in `src/project.ts` with the ones on by
  default. A small default keeps the model's choice sharp.
- **`read_only`** registers no write tool, and wins over every other setting.
- **`tools` / `exclude_tools`** add or remove single tools; an exclusion wins
  over an inclusion.
- **`confirm`** is `harness` (the default) or `elicitation`; it says who asks
  before an administrative tool acts (see "Write classes"). The default leaves
  the question to the harness, whose approval every user already knows.
- **`language`** is the language of a native plugin's approval prompt (see
  "Write classes"); unset, the prompt follows the harness's display language
  or stays in English.
- **Options** are the package's own settings, the ones the tools themselves
  read, listed in `options` in `src/project.ts`. Each holds text and is named
  in snake_case; its flag is the name with `_` as `-`, its variable is
  `<envPrefix>_<NAME>` uppercased, and its plugin option or setting is the
  name itself. A flag wins over its variable, an option over its variable,
  and blank text counts as unset. They reach a tool as `context.options`,
  keyed by name, and one that is not given is absent: a neutral default means
  unset, and the tool then does nothing extra. A tool reads an option when it
  runs, so a change applies on the next call.

## The core contract

- A tool spec declares its ID, description, argument schema, output schema,
  toolset and write class; every entry point derives the same metadata from
  it. A write tool also declares `targets(args, context)`, which names what
  the call writes to.
- `execute(args, context)` gets the working directory, an abort signal, an
  optional `ownDir` (the directory the tools are installed in, never the
  working tree), the values of the package's own settings as `options` (see
  "Toolsets and settings"; `describe` and `targets` get them too) and an
  optional `confirm(request) => Promise<boolean>` hook.
  Nothing in it names a harness. An entry point supplies `confirm` when the
  `elicitation` setting is on; without it the harness's approval stands, and a
  tool that needs a confirmation treats a missing hook as the harness having
  approved the call.
- `src/core/` uses only the `node:*` modules and plain dependencies, never a
  runtime's own globals (`Bun.spawn`, `Bun.file`, …), so the same code runs on
  Node and on Bun. It knows no project either: names, prefixes and toolsets
  come from `src/project.ts` through the entry points.

## Programs a tool runs

- **Every program a tool runs goes through one runner** built on `exec`, with
  an explicit environment: what the program needs to find itself and
  authenticate is passed through, and nothing else, so a stray variable
  cannot redirect a call. Prompts and colors are switched off, so nothing
  waits on a person and output parses the same everywhere.
- **Every variable the tools read besides the settings is named in
  `toolVariables` in `src/project.ts`**, whether a tool reads it itself or
  passes it through to a program. Codex gives a plugin's server only a few
  basic variables (`PATH`, `HOME` and the like) and those its manifest names,
  and `pnpm run manifests` writes that list from the settings and
  `toolVariables`: a variable left out is set everywhere but in Codex.
- **Every call has a time limit**, and a call that is stopped, by that limit
  or by cancellation, has its child process killed: `SIGTERM`, then `SIGKILL`
  after two seconds. A hung program neither holds a harness forever nor
  outlives its call.
- **The runner maps the program's failures to the error codes above.**

## Tests

- Tests sit beside the code they test (`*.test.ts`) and run on `bun test`;
  CI also starts the built MCP server, plugin and command line under Node and
  lists their tools, so a runtime-only API cannot slip in unnoticed.
- No test reaches a real service. A tool that runs a program is tested
  against a fake of that program on `PATH`.
- A test file stays within about 300 lines, split by topic
  (`<name>.<topic>.test.ts`), so one commit can carry a change and its test.

## The git tools

The rules below are git-tools' own, on top of everything above; where one
changes a rule above, it says so. The discussion behind them is on
[#3](https://github.com/craft-agent/git-tools/issues/3).

### Scope

- **git only, with any remote.** No tool writes to GitHub. Pull requests,
  native stacks and reads of GitHub belong to
  [github-tools](https://github.com/craft-agent/github-tools), so this
  package works the same against any git host.
- **One exception: safety reads.** Where a git rule needs a fact only GitHub
  has — whether a branch is protected against force pushes, whether a
  squash-merged branch landed — it reads that from GitHub, and only when
  `origin` is on GitHub. Elsewhere the rule falls back to what git alone can
  prove, and refuses or keeps rather than guesses.
- **How a safety read goes.** It runs through a runner of its own for the
  GitHub CLI (`gh`), built on `exec` with the same allowlisted environment as
  the git runner, and every read has a time limit. The rewrite rule reads
  whether GitHub blocks force pushes (branch protection or a ruleset) with one
  `gh api graphql` query per repository and branch the rewrite holds on a
  GitHub remote, and 8 s to answer. A branch that is protected is a refusal. A
  read that fails (`gh` missing or not logged in, no access, a time-out, a
  branch GitHub does not have) is a warning, not a refusal: the rewrite stays
  local, and GitHub refuses the force push itself.
- **A stack is read from ancestry, and no record of it is kept.** It is the
  current branch's line: the local branches between the remote default branch
  and the top, below the current one, on its tip, or above it, grouped by tip
  into layers. Where the branches above fork, the line is ambiguous and the
  caller names the top. Because nothing is written to git config or a file,
  a stack made by any tool, or by hand, reads the same. The rewrite rule
  treats the remote branches of the layers as the branch's own, and refuses a
  rewrite that would leave layers above on the old commits, or an amend that
  would leave other branches on the old commit (`layers_above`); a lower layer
  is fixed with a fixup committed on the top and a rebase of the whole stack.

### Domains and names

- **The domain is the object git acts on, the verb is git's command name.**
  git's commands are verbs (`add`, `commit`, `rebase`, `push`), unlike a CLI
  of noun groups, so a tool ID is `git_<object>_<command>`. The verbs above
  (`read`, `ensure`, …) fill in where git has none.
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

### Write classes of git operations

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
  `false` only for one that stays on it, whose spec sets `openWorld: false`.
  This replaces the rule above that it is `true` for every tool: reading a
  remote counts, since the hint is about interacting with external entities,
  not only writing to them.

### Pinned writes

- **What a write relies on is pinned in its arguments, never in an opaque
  token.** The harness's approval shows a call's arguments, so a write that
  names what it expects shows the person exactly what will happen.
- **Pushing** takes, per branch, the commit to push and the remote commit it
  expects, and leases on that commit. The push preview, a method of the
  domain's read tool, returns exactly those arguments.
- **Hunk staging** takes the digest of the diff its listing showed, with the
  hunks it names, so a listing that went stale never stages other hunks.
- Either throws `stale` when what it pinned has changed.

### Approval prompts of git tools

- **Every write tool states its intent**, and a domain that adds a write tool
  adds its intent with it, so no git write is asked for under its title
  alone.
- **Each domain keeps its words beside its tools**, in a `words.ts` of its
  directory: the titles, the intents, and the headline templates, fact
  labels, value templates and text labels its `describe` writes.
  `src/words.ts` joins them with the shared facts, and no English word is in
  two tables. Each domain's test checks that its table holds exactly the words
  its tools write, so a word the tools stop using does not linger.
- **The facts the git tools add**, beside the shared `Size`. A fact any
  domain could show lives in `src/core/git-facts.ts`; a domain's own fact
  stays beside its tools:

  | Fact                | Value                                     | Shown by                                               |
  | ------------------- | ----------------------------------------- | ------------------------------------------------------ |
  | `Push`              | `needs a force push`, only when it does   | amending, rebasing                                     |
  | `Accepted findings` | the fingerprints of the findings let pass | committing, amending                                   |
  | `Change`            | `message only`, `staged changes`, …       | amending                                               |
  | `Branch`            | the branch's name                         | committing, amending                                   |
  | `Files`             | `{files} files`                           | staging hunks, committing, amending, resuming a rebase |
  | `Hunks`             | `{hunks} of {total}`                      | staging hunks                                          |
  | `Lines`             | `{added} added, {removed} removed`        | staging hunks, committing, amending                    |
  | `Commits`           | `{commits} commits`                       | checking each commit, rebasing                         |
  | `Layers`            | the branches moved or put back, `a → b`   | rebasing, resuming a rebase                            |
  | `After`             | the layer branch whose layers landed      | rebasing                                               |
  | `Fixups`            | `{fixups} to fold`                        | rebasing                                               |
  | `New branches`      | each new branch and where it starts       | cutting layer branches, adding a layer                 |
  | `Base`              | the base's short sha and subject          | checking each commit                                   |
  | `Setup`             | the setup command, as given               | checking each commit                                   |
  | `Directory`         | where the commands run, when not the root | checking each commit                                   |
  | `On failure`        | `stop at the first failure`, or not       | checking each commit                                   |
  | `Time limit`        | `{seconds} s per run`                     | checking each commit                                   |

  A fact the person's answer turns on comes first: amending a commit the
  branch has pushed says so before anything else, since the next push must
  then force.

### Results and errors of git operations

- **An operation that paused is a result.** A rebase, or a rebase of stacked
  branches, that stopped on conflicts or on a commit that became empty
  returns `status: "paused"` with the reason and what the caller needs to
  continue, skip or abort (the conflict map). Nothing failed: the repository
  is in a new state.
- **An operation that did not happen throws**, with structured `details`
  beside the code and message: lint violations, secret findings, hook output,
  the rewrite rule's refusals. The caller needs them to fix the cause, and a
  message string would lose their structure.
- **Codes added to the ones above**:

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

### Settings of git-tools

Beside the settings above:

- **`worktree_root`**: where task worktrees go.
- **The published-text rules** (the option `published_text_rules`): words a
  pushed commit subject or branch name must not carry, held in a JSON file
  whose absolute path the option gives. The package ships no words: unset,
  nothing is checked, since the words a reader should not see are the
  consumer's, not the package's
  ([#9](https://github.com/craft-agent/git-tools/issues/9)).

`worktree_root` has a neutral default, set when its domain is reviewed
([#8](https://github.com/craft-agent/git-tools/issues/8)).

### The git runner

- **Every git call goes through one runner**, built on `exec` as the rule
  above says.
- **An allowlisted environment**: the search path, home, the SSH agent,
  proxies and `gh`'s authentication, so `gh auth git-credential` keeps working
  for HTTPS pushes, plus `GIT_TERMINAL_PROMPT=0`, `GIT_EDITOR=true`,
  `GIT_SEQUENCE_EDITOR=true`, `GIT_PAGER=cat` and `NO_COLOR=1`. Nothing waits
  on a prompt or an editor, and the rest of the caller's environment, its
  secrets included, never reaches git or a hook.
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

### Skills of git-tools

- **One skill per domain**: `git-repo`, `git-commit`, `git-rebase`,
  `git-worktree` and `git-push`, named for what they cover with the product in
  the name; the native entry points register them under the short names
  (`repo`, `commit`, …). A consumer that turns a toolset off loses no skill it
  can still use.
- **A skill says how to use its tools, never a working method.** How to cut a
  change into commits or word a message stays with the consumer's own
  instructions.

### Tests of git-tools

- **Real repositories in a temporary directory**, with a local bare
  repository as the remote. git itself is the fixture: a fake would only
  restate what the tests assume.
- **GitHub reads are tested against a fake `gh` on `PATH`**, as the rule
  above says; no test reaches the network.
