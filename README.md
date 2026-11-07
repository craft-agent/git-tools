# git-tools

Git tools for coding agents: state, commits, rewrites and stacked branches, worktrees and pushing.

The tools cover the state of a working tree, commits, history rewrites and
stacked branches, worktrees and pushing, against any git remote. Pull requests
and native stacks on GitHub are
[github-tools](https://github.com/craft-agent/github-tools)'. The tools are
being built; the delivery below is in place, and the toolsets are listed under
[Tools and skills](#tools-and-skills) as they land.

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
install directory, which is never the caller's working tree.

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
default, `worktree` and `push` are opt-in. None has shipped yet.

| Toolset    | Covers                                                                   |
| ---------- | ------------------------------------------------------------------------ |
| `repo`     | local reads: status, history, where a change came from, conflicts        |
| `commit`   | staging, the checks before a commit, committing, amending and fixups     |
| `rebase`   | rebasing, stacked branches rebased together, and the rewrite rule        |
| `worktree` | creating, listing and removing worktrees                                 |
| `push`     | pushing one or more branches, against the remote commit each one expects |

## Adding a tool

1. Write the spec in `src/core/<domain>/<verb>.ts` with `defineTool`: an ID
   `<prefix>_<domain>_<verb>`, a title and description, the Zod argument and
   output schemas, its toolset and write class, and `execute(args, context)`.
   A write tool also gives `targets(args, context)`: what the call writes to,
   as a permission rule should name it.
2. Test it beside the spec (`<verb>.test.ts`), calling it through `invoke` as
   the entry points do. A tool that runs a program is tested against a fake of
   that program on `PATH`; no test reaches a real service.
3. List it in `src/tools.ts`. A new toolset goes into `toolsets` in
   `src/project.ts` (and `defaultToolsets` when it is on by default).
4. Add or update the toolset's skill, `skills/<prefix>-<toolset>/SKILL.md`.
5. Run `pnpm run build && pnpm run manifests` to list the tool in
   `plugin.yaml`, then describe it under "Tools and skills".

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
- **Codex** under `codex exec`, and **Grok Build** under `grok -p`, refuse a
  write they cannot ask about, unless it is allowed beforehand.
- **Grok Build** calls the plugin's tools through its `use_tool` tool, and the
  agent often names a tool without its server first. Grok checks the rules
  against the name as given, so the server-qualified rule alone does not match
  that first call. The second rule matches the short name; a write still
  matches neither.
- **Antigravity** asks before any MCP tool no rule allows, reads included, and
  names the plugin's server `git-tools_git-tools` (plugin,
  then server). `agy -p` refuses a tool it cannot ask about.
- **Hermes** `hermes chat -q` refuses a write it cannot ask about; `hermes -z`
  and `--yolo` skip approval, so writes then run unasked.

## Settings

Every entry point takes the same settings. A flag wins over its environment
variable, and an option or setting wins over the variable too.

| Setting         | Flag              | Variable                  | Meaning                                                                       |
| --------------- | ----------------- | ------------------------- | ----------------------------------------------------------------------------- |
| `toolsets`      | `--toolsets`      | `GIT_TOOLS_TOOLSETS`      | the toolsets that are on, or `all`; default those `src/project.ts` names      |
| `read_only`     | `--read-only`     | `GIT_TOOLS_READ_ONLY`     | registers no tool that writes; wins over every other setting                  |
| `tools`         | `--tools`         | `GIT_TOOLS_TOOLS`         | single tools to add by ID, whatever their toolset                             |
| `exclude_tools` | `--exclude-tools` | `GIT_TOOLS_EXCLUDE_TOOLS` | single tools to remove by ID; wins over `tools` and `toolsets`                |
| `confirm`       | `--confirm`       | `GIT_TOOLS_CONFIRM`       | MCP server only: `harness` (default) or `elicitation`, as the conventions say |

Lists are comma-separated in a flag or a variable. Where each harness reads them:

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
  ```

  The plugin passes its own environment to the command line it runs, so the
  variables work too. A running gateway keeps the environment it started with;
  restart it (`hermes gateway restart`) after changing one.

- **Claude Code, Grok Build and Antigravity** start the plugin's server without
  flags and pass it the client's environment, so set the variables in the
  environment the harness runs in.
- **Codex** passes a plugin's MCP server only a few basic variables (such as
  `PATH` and `HOME`), so the variables have no effect there. To change
  settings, or to give the server a variable it needs, add the server under
  `[mcp_servers]` in Codex's `config.toml` instead of using the plugin: flags
  go in `args`, `env_vars` names the variables to forward from Codex's
  environment, and `env` sets fixed values.

  ```toml
  [mcp_servers.git-tools]
  command = "npx"
  args = ["-y", "@craftsamo/git-tools@<version>", "--read-only"]
  env_vars = ["GIT_TOOLS_TOOLSETS"]
  ```

## Layout

- `src/project.ts` — the package's name, tool ID prefix, setting prefix and
  toolsets.
- `src/core/` — the tool contract and the tools, free of any harness and of
  the project's names.
- `src/tools.ts` — the list of every tool, which each entry point registers.
- `src/mcp/` — the MCP server, built to `dist/mcp.js` and run by
  `git-tools`.
- `src/opencode/` — the OpenCode plugin, built to `dist/opencode.js`.
- `src/cli/` — the command line the Hermes plugin calls, built to `dist/cli.js`
  and run by `git-tools-cli`.
- `src/hermes/`, `plugin.yaml` and `__init__.py` — the Hermes plugin.
- `skills/` — one skill per toolset, `skills/<name>/SKILL.md`, which every
  harness that takes skills loads from the package or plugin root.
- `plugin.json`, `mcp.json`, `.mcp.json`, `.claude-plugin/`, `.agents/plugins/`,
  `.antigravity-plugin/` and `mcp_config.json` — the plugin manifests of the
  other harnesses. The root `.mcp.json` is the configuration Grok Build reads
  (with `${CLAUDE_PLUGIN_ROOT}`, the variable both Grok Build and Claude Code
  expand); when working on this repository in Claude Code, decline the project
  MCP server it offers from that file.
- `opencode.jsonc` — OpenCode's configuration for working on this repository,
  not part of the package: it references the starter it was made from and
  github-tools, so an agent can read them beside this code.

How a release is made is in [`RELEASING.md`](RELEASING.md).

## License

[MIT](LICENSE)
