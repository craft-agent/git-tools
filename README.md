# git-tools

Git tools for coding agents: state, commits, rewrites and stacked branches, worktrees and pushing.

The tools cover the state of a working tree, commits, history rewrites and
stacked branches, worktrees and pushing, against any git remote. Pull requests
and native stacks on GitHub are
[github-tools](https://github.com/craft-agent/github-tools)'. The toolsets are
listed under [Tools and skills](#tools-and-skills).

| Harness        | Delivery                                       | Pinned by                      |
| -------------- | ---------------------------------------------- | ------------------------------ |
| OpenCode V2    | native plugin (npm package, with skills)       | the version in the package     |
| OpenCode V1    | native plugin (npm package, no skills)         | the version in the package     |
| Claude Code    | plugin: MCP server and skills                  | the release tag, as the ref    |
| Codex          | plugin: MCP server and skills                  | the release tag, as the ref    |
| Grok Build     | plugin: MCP server and skills                  | the release tag, as `@ref`     |
| Antigravity    | plugin: MCP server and skills                  | the release tag's tree URL     |
| Hermes Agent   | native plugin (Python, calls the command line) | the release commit, as the SHA |
| other MCP host | MCP server from npm                            | the version in the package     |

The tools need [Node.js](https://nodejs.org/) 24 or later and `git`. Where
`origin` is on GitHub, a few safety checks also read it, authenticated as you.
[`docs/conventions.md`](docs/conventions.md) describes how the tools are named
and how they behave.

## Install

Install from a release, never from the default branch: a release is a tag whose
commit carries the built `dist/`, and the default branch does not. In the
commands below, `<version>` is a release's version (`1.2.3`) and `<sha>` is the
commit its tag names:

```sh
gh api repos/craft-agent/git-tools/commits/v<version> --jq .sha
```

### OpenCode

OpenCode V2 takes the package and its options in `opencode.json`:

```json
{
  "plugins": [{ "package": "@craftsamo/git-tools@<version>", "options": { "read_only": false } }],
  "permissions": [{ "action": "git_*", "resource": "*", "effect": "ask" }]
}
```

OpenCode V1 takes the package as a string, or as a pair with its options:

```json
{
  "plugin": [["@craftsamo/git-tools@<version>", { "read_only": false }]],
  "permission": { "git_*": "ask" }
}
```

OpenCode allows any action no rule names, so the plugin's request is granted
silently unless a rule says `ask`. Read tools never ask, so the `git_*` glob
is safe.

With the `worktree` toolset on and the profile not read-only, the V2 plugin
also registers a worktree strategy, so OpenCode's own new worktree and removal
follow the layout and the landed rule of the worktree tools: the name OpenCode
asks for becomes the branch, and a removal git refuses for changed files offers
OpenCode's force prompt where the harness supports it, while the tools
themselves never force. After `git_worktree_add` or `git_worktree_remove` the
plugin refreshes OpenCode's worktree list, so the change shows at once.
OpenCode's built-in worktree tools are left as they are; turn them off with
permission rules. V1 has no worktree strategies.

V1 registers no skills. Unpack the package and copy its `skills/*` folders into
`~/.config/opencode/skills/`:

```sh
npm pack @craftsamo/git-tools@<version>
tar -xzf craftsamo-git-tools-<version>.tgz
mkdir -p ~/.config/opencode/skills
cp -r package/skills/* ~/.config/opencode/skills/
rm -rf package craftsamo-git-tools-<version>.tgz
```

### Claude Code

```sh
claude plugin marketplace add craft-agent/git-tools#v<version>
claude plugin install git-tools@craft-agent
```

### Codex

```sh
codex plugin marketplace add craft-agent/git-tools --ref v<version>
codex plugin add git-tools@craft-agent
```

Codex turns `-` into `_` in server names, so it shows the tools as
`mcp__git_tools__git_*`. It starts the MCP server in the plugin's
install directory and passes no roots, so the server takes each call's directory
from what Codex sends with the call: its sandbox state, which the server asks
for, else the one workspace it names.

The plugin declares `default_tools_approval_mode = "writes"`: Codex asks before
every tool not marked read-only. A user's
`[plugins."<plugin>".mcp_servers.<server>]` setting can only tighten it. Setting
`auto` there yields `prompt` (reads asked too), since Codex treats `auto` and
`writes` as incomparable.

### Grok Build

```sh
grok plugin install craft-agent/git-tools@v<version> --trust
```

Grok starts the MCP server in the session's working directory.

### Antigravity

Install from the tree of the release tag, never from the default branch, which
has no built `dist/`; Antigravity clones the tag into
`~/.gemini/config/plugins/git-tools`.

```sh
agy plugin install https://github.com/craft-agent/git-tools/tree/v<version>
```

### Hermes Agent

Hermes installs a commit, not a tag, and the plugin installs disabled:

```sh
hermes plugins install craft-agent/git-tools --ref <sha>
hermes plugins enable git-tools
```

If a Hermes gateway is already running, restart it (`hermes gateway restart`) to
load the plugin.

The plugin runs the Node it found when Hermes started. If a version manager
removes that version while Hermes runs, a call looks for Node again; when it
finds none, restart Hermes from a shell where `node` runs.

When the package's writes depend on another Hermes plugin, such as a guard
that blocks writes no one is there to approve, name it in `require_plugins`.
Hermes keeps loading this plugin when that one fails to import or register,
and treats a manifest's `requires_plugins` as advisory. With the setting,
while a named plugin is not loaded, every write is refused before it is
approved, even under `--yolo`, `approvals.mode: off` or a remembered answer,
naming the plugin that is missing. Reads still run.

```yaml
plugins:
  entries:
    git-tools:
      settings:
        require_plugins: [write-guard]
```

### Any other MCP host

Add the server to the host's MCP configuration. Flags go in `args`:

```json
{
  "mcpServers": {
    "git-tools": {
      "command": "npx",
      "args": ["-y", "@craftsamo/git-tools@<version>", "--read-only"]
    }
  }
}
```

## Tools and skills

Each toolset comes with a skill that tells an agent how to use its tools.
There is one toolset per domain; `repo`, `commit` and `rebase` are on by
default, `worktree` and `push` are opt-in.

A skill names its toolset under `metadata` in its frontmatter
(`metadata: { toolset: commit }`, written as a block). OpenCode V2 and Hermes
register it only when the settings register at least one of that toolset's
tools, so a profile with the toolset off, or with all its tools removed, does
not see it; a skill without a toolset is always registered. Claude Code,
Codex, Grok Build and Antigravity install the skill folder whole and pass the
settings only to the MCP server, so they list every skill whatever the
settings select. OpenCode V1 registers no skills, and its copied skills are
all listed too.

| Toolset    | Covers                                                                   |
| ---------- | ------------------------------------------------------------------------ |
| `repo`     | local reads: status, history, where a change came from, conflicts        |
| `commit`   | staging, the checks before a commit, committing, amending and fixups     |
| `rebase`   | rebasing, stacked branches rebased together, and the rewrite rule        |
| `worktree` | creating, listing and removing worktrees                                 |
| `push`     | pushing one or more branches, against the remote commit each one expects |

### `repo`

One read tool, which changes nothing and reaches no remote. The `git-repo`
skill says when to use each method.

| Tool            | Method        | Reads                                                                                                                                                      |
| --------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git_repo_read` | `status`      | the branch and its upstream, how it stands against the remote default branch, files by state, an operation in progress, stashes, worktrees, the last fetch |
|                 | `conflicts`   | what a merge, rebase, cherry-pick or revert left: its sides, and each conflicted file's marker regions or its lockfile command                             |
|                 | `conventions` | recent commit subjects with their conventional types and scopes, and the commit config files and pull request template in the tree                         |
|                 | `origin`      | the commit a change came from, by sha, blame or pickaxe, with its full message                                                                             |

### `commit`

One read tool for the checks before a commit, and four write tools. The
`git-commit` skill says how they fit together.

| Tool                | Class             | Does                                                                                                                                                                                                                                                                                                  |
| ------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git_commit_read`   | read              | `lint`: a candidate message against the neutral rules and the repository's commitlint; `secrets`: credentials in the staged changes, the unstaged changes or a range; `hunks`: the unstaged hunks with the digest of their diff; `amend`: whether to correct a commit by amend, fixup or a new commit |
| `git_commit_stage`  | idempotent change | stages the hunks of a listing, pinned by its digest                                                                                                                                                                                                                                                   |
| `git_commit_create` | add               | commits what is staged with the checked message, or a fixup of an earlier commit                                                                                                                                                                                                                      |
| `git_commit_amend`  | overwrite         | replaces HEAD with the staged changes and a message, under the rule for rewriting commits                                                                                                                                                                                                             |
| `git_commit_verify` | administrative    | runs a command at each commit of the branch in a throwaway worktree                                                                                                                                                                                                                                   |

### `rebase`

One read tool for the stack of the checked-out branch, and three write tools.
A stack is read from ancestry, so a branch alone is a stack of one layer. The
`git-rebase` skill says how they fit together.

| Tool                | Class     | Does                                                                                                                                                                       |
| ------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git_rebase_read`   | read      | `stack`: the layers of the branch's line, bottom to top, with their commits and fixups, how each stands to its remote branch, and whether the whole stack may be rewritten |
| `git_rebase_start`  | overwrite | rebases every layer onto the latest default branch, or folds the fixups in place, under the rule for rewriting commits; a stop on conflicts is a paused result             |
| `git_rebase_resume` | overwrite | continues, skips or aborts a stopped rebase                                                                                                                                |
| `git_rebase_split`  | add       | cuts the branch into lower layer branches at given commits, or adds an empty layer on top                                                                                  |

### `worktree`

One read tool that lists the worktrees, and two write tools that add one where
the layout puts it and remove one without losing work. The toolset is opt-in.
The `git-worktree` skill says how they fit together, and the layout is under
[Settings](#settings).

| Tool                  | Class     | Does                                                                                                                                                                                                                               |
| --------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git_worktree_read`   | read      | `list`: every worktree of the repository from git alone: its directory, branch and commit, whether it is the main one or the caller's, locked or gone, and whether it sits where the layout puts it                                |
| `git_worktree_add`    | add       | adds a worktree for a branch at `<root>/<repository>/<branch>`: an existing branch as it is, a new one cut from `from`, else from origin's fetched default branch, with no upstream and no hooks on the checkout                   |
| `git_worktree_remove` | overwrite | removes a worktree, never forced: refuses changed files, commits no ref holds and an operation in progress; deletes its branch only once proven landed (ancestry, or a merged pull request on GitHub), and says why a branch stays |

### `push`

One read tool that previews a push, and one write tool that pushes exactly
what the preview returned, leased on the remote commit each branch expects.
The toolset is opt-in. The `git-push` skill says how they fit together.

| Tool            | Class          | Does                                                                                                                                                                                                                                                    |
| --------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git_push_read` | read           | `preview`: per branch of the line, read live from the remote, the kind of push, the commits the remote lacks and what a force drops; refusals, warnings, the secret scan and the published-text rules; and `send`, the arguments that push exactly this |
| `git_push_send` | administrative | pushes the preview's `send` in one atomic push with a lease per branch, after checking it again; a branch or remote that moved is `stale`, and nothing is pushed                                                                                        |

### Grants (`grants`)

Off by default. Delegates bounded writes for jobs where no person can answer.

| Tool               | What it does                                             | Class          |
| ------------------ | -------------------------------------------------------- | -------------- |
| `git_grant_create` | ask a person to delegate one tool's writes within limits | administrative |
| `git_grant_read`   | list grants and their use, or read the usage log         | read           |
| `git_grant_revoke` | remove a grant so no more calls run under it             | overwrite      |

Every write tool can be granted for its targets, calls per hour and expiry.
A tool adds what a grant can also limit by declaring `bounds` and giving
`measure(args, context)` in its spec; see the
[conventions](docs/conventions.md#writes-no-one-is-there-to-approve).
No tool of this package declares `bounds` yet.

## Adding a tool

1. Write the spec in `src/core/<domain>/<verb>.ts` with `defineTool`: an ID
   `<prefix>_<domain>_<verb>`, a title and description, the Zod argument and
   output schemas, its toolset and write class, and `execute(args, context)`.
   A write tool also gives `targets(args, context)`: what the call writes to,
   as a permission rule should name it. A tool whose settings can put some
   calls out of reach whatever the person answers gives
   `gate(args, context)`, which throws for such a call; it is refused before
   anyone is asked, and before `execute`.
2. Test it beside the spec (`<verb>.test.ts`), calling it through `invoke` as
   the entry points do. A tool that runs a program is tested against a fake of
   that program on `PATH`; no test reaches a real service.
3. List it in `src/tools.ts`. A new toolset goes into `toolsets` in
   `src/project.ts` (and `defaultToolsets` when it is on by default), a
   setting of the package's own into `options` (and `OPTIONS` in `project.py`
   with `config_schema` in `plugin.yaml`), and a variable the tool reads
   besides the settings into `toolVariables`.
4. Add or update the toolset's skill, `skills/<prefix>-<toolset>/SKILL.md`,
   whose frontmatter names the toolset under `metadata`.
5. Run `pnpm run build && pnpm run manifests` to list the tool in
   `plugin.yaml` and its variables in Codex's manifest, then describe it under
   "Tools and skills".

[`docs/conventions.md`](docs/conventions.md) has the rules each step follows.

## Reads and writes

Every read tool is named `<prefix>_<domain>_read`. Reads can run unasked;
writes are confirmed by the harness.

| Harness     | Reads without asking                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| OpenCode    | always; the plugin asks only before a write                                                            |
| Claude Code | the rule `mcp__plugin_git-tools_git-tools__*_read` in `permissions.allow` of `~/.claude/settings.json` |
| Codex       | always; Codex runs tools that declare `readOnlyHint` unasked, as the read tools do                     |
| Grok Build  | `grok --allow 'MCPTool(git-tools__*_read)' --allow 'MCPTool(git_*_read)'` (both rules; see below)      |
| Antigravity | the rule `mcp(git-tools_git-tools/<tool id>)` in `permissions.allow`, one for each read tool           |
| Hermes      | always; the plugin asks only before a write                                                            |

Where a write is asked about, and where it is not:

- **OpenCode** grants any action no rule names, so a write runs unasked unless
  a rule asks for it: add the `git_*` rule shown under [OpenCode](#opencode).
- **Codex** asks before every write because of the plugin's approval mode.
  Under `codex exec` it refuses with "MCP tool call requires approval, but
  approval policy is never". For bounded jobs, see
  [Writes no one is there to approve](#writes-no-one-is-there-to-approve).
- **Grok Build** under `grok -p` refuses a write it cannot ask about, unless it
  is allowed beforehand.
- **Grok Build** calls the plugin's tools through its `use_tool` tool, and the
  agent often names a tool without its server first. Grok checks the rules
  against the name as given, so the server-qualified rule alone does not match
  that first call. The second rule matches the short name; a write still
  matches neither.
- **Antigravity** asks before any MCP tool no rule allows, reads included, and
  names the plugin's server `git-tools_git-tools` (plugin,
  then server). `agy -p` refuses a tool it cannot ask about.
- **Hermes** `hermes chat -q` refuses a write it cannot ask about; `hermes -z`
  and `--yolo` skip approval, so writes then run unasked. For bounded jobs, see
  [Writes no one is there to approve](#writes-no-one-is-there-to-approve).

A call a tool's `gate` refuses never runs, whatever the answer. OpenCode and
Hermes refuse it before they ask, so no prompt shows it; Hermes blocks it with
the tool's error. Claude Code, Codex, Grok Build and Antigravity draw their
own prompt before the MCP server sees the call, so they may still ask about
it; the server then refuses it.

## Writes no one is there to approve

A grant limits a job's writes to one tool, for at most 90 days. The person
decides the rest: the targets (named ones, or `*` for any), the bounds the
tool declares (one left out is no limit) and the calls per hour (left out,
any number). Every call made under a grant is logged. A grant never
overrides the host's permissions. The
[conventions](docs/conventions.md#writes-no-one-is-there-to-approve) give the
contract.

1. In a session where a person answers, supply the key described under
   [Settings](#settings), turn on the `grants` toolset alongside the job's
   toolset, and ask the agent to delegate. It calls `git_grant_create`;
   the prompt shows the tool, targets, rate, days, every bound the tool
   declares (`no limit` for one left out) and the reason.
   Approve once.
2. Set the same key and `unattended` for the job only, for example
   `GIT_TOOLS_UNATTENDED=true`. Otherwise grants are not checked.
3. Let the host allow the write tool in that run, as below. The grant still
   bounds each call.
4. Revoke with `git_grant_revoke`, or list grants and their use with
   `git_grant_read`.

What lets a write reach the package when no one can answer, for example
`git_commit_create`:

- **OpenCode** `opencode run` rejects every question unless an allow rule
  names the tool (`"permission": { "git_commit_create": "allow" }`) or the
  run starts with `--auto`.
- **Claude Code** `claude -p` needs the tool in `--allowedTools`, as
  `mcp__plugin_git-tools_git-tools__git_commit_create`.
- **Codex** `codex exec` needs `approval_mode = "approve"` for that tool under
  the plugin's MCP server in `config.toml`
  (`[mcp_servers.<server>.tools.<tool>]`), since the plugin's default asks
  before every write.
- **Grok Build** `grok -p` needs both allow rules:
  `--allow 'MCPTool(git-tools__git_commit_create)'` and
  `--allow 'MCPTool(git_commit_create)'`, for the qualified and short names
  described under [Reads and writes](#reads-and-writes).
- **Antigravity** `agy -p` needs
  `mcp(git-tools_git-tools/git_commit_create)` in
  `permissions.allow`.
- **Hermes** `hermes chat -q` denies by `approvals.single_query_mode` unless
  allowed. `-z` and `--yolo` skip approvals and run the write; the grant is
  then the only bound.

### Limits

- A run with every approval skipped (Hermes `-z` or `--yolo`, an
  always-approve mode, an explicit `allow` for `git_grant_create`, or a
  global OpenCode V1 `allow`) shows no prompt. A grant created there is not a
  person's answer, and it can be as wide as any target, no bound and no rate
  for 90 days: create grants only where the harness asks.
- An earlier copy of the grants directory put back whole is not detected.
  Expiry, at most 90 days, bounds what it can restore.
- Anyone who can read the key can sign grants. Keep it where the agent's
  tools cannot read it.
- The OpenCode V2 plugin forces a question for `git_grant_create`
  through a hook; only hosts that offer that hook run it.

The OpenCode V2 service and Hermes gateway keep the environment they started
with; see [Settings](#settings) before changing the job's variables.

## Settings

Every entry point takes the same settings. A flag wins over its environment
variable, and an option or setting wins over the variable too.

| Setting                | Flag                     | Variable                         | Meaning                                                                                                                 |
| ---------------------- | ------------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `toolsets`             | `--toolsets`             | `GIT_TOOLS_TOOLSETS`             | the toolsets that are on, or `all`; default those `src/project.ts` names                                                |
| `read_only`            | `--read-only`            | `GIT_TOOLS_READ_ONLY`            | registers no tool that writes; wins over every other setting                                                            |
| `unattended`           | `--unattended`           | `GIT_TOOLS_UNATTENDED`           | no person can answer: a write runs only under a grant that covers it; off by default                                    |
| `grants_dir`           | `--grants-dir`           | `GIT_TOOLS_GRANTS_DIR`           | where grants and their use are kept; default `$XDG_STATE_HOME/git-tools/grants`, else `~/.local/state/git-tools/grants` |
| `tools`                | `--tools`                | `GIT_TOOLS_TOOLS`                | single tools to add by ID, whatever their toolset                                                                       |
| `exclude_tools`        | `--exclude-tools`        | `GIT_TOOLS_EXCLUDE_TOOLS`        | single tools to remove by ID; wins over `tools` and `toolsets`                                                          |
| `confirm`              | `--confirm`              | `GIT_TOOLS_CONFIRM`              | MCP server only: `harness` (default) or `elicitation`, as the conventions say                                           |
| `language`             | `--language`             | `GIT_TOOLS_LANGUAGE`             | native plugins only: the approval prompt's language, such as `ja`                                                       |
| `emoji`                | —                        | —                                | Hermes only: the emoji shown beside each toolset, by toolset name (`""` for none)                                       |
| `require_plugins`      | —                        | —                                | Hermes only: the plugins that must be loaded; while one is not, every write is refused before it is approved            |
| `published_text_rules` | `--published-text-rules` | `GIT_TOOLS_PUBLISHED_TEXT_RULES` | the path of a JSON file of published-text rules (see the push toolset); unset, nothing is checked                       |
| `worktree_root`        | `--worktree-root`        | `GIT_TOOLS_WORKTREE_ROOT`        | the path where task worktrees go; unset, `~/worktrees`                                                                  |

`GIT_TOOLS_GRANT_KEY` is a variable only, never a flag or a plugin
option. Use at least 32 characters, for example from `openssl rand -hex 32`,
stored where the host keeps secrets. Without it no write runs while
unattended and no grant can be created. Codex forwards it alongside the
settings' variables, as described below.

Lists are comma-separated in a flag or a variable. A package's own settings,
listed in `options` in `src/project.ts`, take a row each here and are read the
same way. A `path` is trimmed; `~` and `~/…` (also with the platform separator)
stand for the home directory (`HOME` when it is absolute, else the account's).
It must then be absolute and reaches the tool normalized, without a filesystem
check. Blank paths count as unset. Refused values are `invalid_argument`, naming
the flag, variable or option and what it must be. Hermes passes paths to the
command line, which checks them. The layout is
`<root>/<repository>/<branch>`, with each `/` of the branch written `-`; the
repository is the last part of `origin`'s URL without `.git`, else the folder
name of the main checkout. Where each harness reads them:

- **OpenCode** takes the plugin `options` shown above, with lists as arrays and
  `read_only` as a boolean, and falls back to the variables. V2 runs plugins in
  its background service, which keeps the environment it started with: a
  variable set where `opencode run` starts has no effect until the service is
  restarted in that environment (`opencode service restart`). V1 runs plugins
  in its own process.
- **Hermes** takes `plugins.entries.git-tools.settings` in
  `config.yaml`:

  ```yaml
  plugins:
    entries:
      git-tools:
        settings:
          read_only: false
          exclude_tools: []
          published_text_rules: /home/me/.config/git-tools/published-text.json
          worktree_root: ~/worktrees
  ```

  Without a `language` setting, the approval card follows Hermes's own
  `display.language` (or `HERMES_LANGUAGE`), the language of its approval
  buttons, and else stays in English. The plugin passes its own environment
  to the command line it runs, so the variables work too. A running gateway keeps the environment it started with;
  restart it (`hermes gateway restart`) after changing one.

- **Claude Code, Grok Build and Antigravity** start the plugin's server without
  flags and pass it the client's environment, so set the variables in the
  environment the harness runs in.
- **Codex** passes a plugin's MCP server only a few basic variables (such as
  `PATH` and `HOME`) and those the plugin's manifest names, which are the
  variables above: set them in the environment Codex runs in. A variable the
  tools read besides the settings belongs in `toolVariables` in
  `src/project.ts`; `pnpm run manifests` adds it to the manifest after the
  settings' variables. To pass flags, or to give the server a variable the
  package does not name, add the server under `[mcp_servers]` in Codex's
  `config.toml` instead of using the plugin: flags go in `args`, `env_vars`
  names the variables to forward from Codex's environment, and `env` sets
  fixed values.

  ```toml
  [mcp_servers.git-tools]
  command = "npx"
  args = ["-y", "@craftsamo/git-tools@<version>", "--read-only"]
  env_vars = ["GIT_TOOLS_TOOLSETS"]
  ```

## Layout

- `src/project.ts` — the package's name, tool ID prefix, setting prefix,
  toolsets, tool options and the other variables its tools read.
- `src/core/` — the tool contract and the tools, free of any harness and of
  the project's names.
- `src/tools.ts` — the list of every tool, which each entry point registers.
- `src/words.ts` — the translations of the tools' words, per language, which
  the native plugins use in their approval prompts.
- `src/mcp/` — the MCP server, built to `dist/mcp.js` and run by
  `git-tools`.
- `src/opencode/` — the OpenCode plugin, built to `dist/opencode.js`.
- `src/cli/` — the command line the Hermes plugin calls, built to `dist/cli.js`
  and run by `git-tools-cli`.
- `src/hermes/`, `plugin.yaml` and `__init__.py` — the Hermes plugin.
- `skills/` — one skill per toolset, `skills/<name>/SKILL.md`, which every
  harness that takes skills loads from the package or plugin root; the native
  plugins load only those of the toolsets that are on.
- `.claude-plugin/`, `.codex-plugin/`, `.agents/plugins/`, `.mcp.json`,
  `.antigravity-plugin/` and `mcp_config.json` — the plugin manifests of the
  other harnesses. Codex reads `.codex-plugin/plugin.json`; a root
  `plugin.json` would make it load the plugin as an Agent Plugin, whose tool
  budget hides tools past a fixed size. The root `.mcp.json` is the
  configuration Grok Build reads (with `${CLAUDE_PLUGIN_ROOT}`, the variable
  both Grok Build and Claude Code expand); when working on this repository in
  Claude Code, decline the project MCP server it offers from that file.
- `opencode.jsonc` — OpenCode's configuration for working on this repository,
  not part of the package: it references the starter it was made from and
  github-tools, so an agent can read them beside this code.

How a release is made is in [`RELEASING.md`](RELEASING.md).

## License

[AGPL-3.0 with Commons Clause](LICENSE)
