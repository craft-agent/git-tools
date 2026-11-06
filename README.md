# agent-tool-starter

A starter for tool packages that coding agents call: one implementation of the
tools, delivered to each agent harness in the form that suits it best.

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

The tools need [Node.js](https://nodejs.org/) 24 or later.
[`docs/conventions.md`](docs/conventions.md) describes how the tools are named
and how they behave.

## Install

Install from a release, never from the default branch: a release is a tag whose
commit carries the built `dist/`, and the default branch does not. In the
commands below, `<version>` is a release's version (`1.2.3`) and `<sha>` is the
commit its tag names:

```sh
gh api repos/craftsamo/agent-tool-starter/commits/v<version> --jq .sha
```

### OpenCode

OpenCode V2 takes the package and its options in `opencode.json`:

```json
{
  "plugins": [{ "package": "@craftsamo/agent-tool-starter@<version>", "options": { "read_only": false } }],
  "permissions": [{ "action": "example_*", "resource": "*", "effect": "ask" }]
}
```

OpenCode V1 takes the package as a string, or as a pair with its options:

```json
{
  "plugin": [["@craftsamo/agent-tool-starter@<version>", { "read_only": false }]],
  "permission": { "example_*": "ask" }
}
```

OpenCode allows any action no rule names, so the plugin's request is granted
silently unless a rule says `ask`. Read tools never ask, so the `example_*` glob
is safe.

V1 registers no skills. Unpack the package and copy its `skills/*` folders into
`~/.config/opencode/skills/`:

```sh
npm pack @craftsamo/agent-tool-starter@<version>
tar -xzf craftsamo-agent-tool-starter-<version>.tgz
mkdir -p ~/.config/opencode/skills
cp -r package/skills/* ~/.config/opencode/skills/
rm -rf package craftsamo-agent-tool-starter-<version>.tgz
```

### Claude Code

```sh
claude plugin marketplace add craftsamo/agent-tool-starter#v<version>
claude plugin install agent-tool-starter@craftsamo
```

### Codex

```sh
codex plugin marketplace add craftsamo/agent-tool-starter --ref v<version>
codex plugin add agent-tool-starter@craftsamo
```

Codex turns `-` into `_` in server names, so it shows the tools as
`mcp__agent_tool_starter__example_*`. It starts the MCP server in the plugin's
install directory, which is never the caller's working tree.

### Grok Build

```sh
grok plugin install craftsamo/agent-tool-starter@v<version> --trust
```

Grok starts the MCP server in the session's working directory.

### Antigravity

Install from the tree of the release tag, never from the default branch, which
has no built `dist/`; Antigravity clones the tag into
`~/.gemini/config/plugins/agent-tool-starter`.

```sh
agy plugin install https://github.com/craftsamo/agent-tool-starter/tree/v<version>
```

### Hermes Agent

Hermes installs a commit, not a tag, and the plugin installs disabled:

```sh
hermes plugins install craftsamo/agent-tool-starter --ref <sha>
hermes plugins enable agent-tool-starter
```

If a Hermes gateway is already running, restart it (`hermes gateway restart`) to
load the plugin.

### Any other MCP host

Add the server to the host's MCP configuration. Flags go in `args`:

```json
{
  "mcpServers": {
    "agent-tool-starter": {
      "command": "npx",
      "args": ["-y", "@craftsamo/agent-tool-starter@<version>", "--read-only"]
    }
  }
}
```

## Tools and skills

Each toolset comes with a skill that tells an agent how to use its tools. The
starter ships no tools yet.

## Reads and writes

Every read tool is named `<prefix>_<domain>_read`. Reads can run unasked;
writes are confirmed by the harness.

| Harness     | Reads without asking                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| OpenCode    | always; the plugin asks only before a write                                                                              |
| Claude Code | the rule `mcp__plugin_agent-tool-starter_agent-tool-starter__*_read` in `permissions.allow` of `~/.claude/settings.json` |
| Codex       | always; Codex runs tools that declare `readOnlyHint` unasked, as the read tools do                                       |
| Grok Build  | `grok --allow 'MCPTool(agent-tool-starter__*_read)' --allow 'MCPTool(example_*_read)'` (both rules; see below)           |
| Antigravity | the rule `mcp(agent-tool-starter_agent-tool-starter/<tool id>)` in `permissions.allow`, one for each read tool           |
| Hermes      | always; the plugin asks only before a write                                                                              |

Where a write is asked about, and where it is not:

- **OpenCode** grants any action no rule names, so a write runs unasked unless
  a rule asks for it: add the `example_*` rule shown under [OpenCode](#opencode).
- **Codex** under `codex exec`, and **Grok Build** under `grok -p`, refuse a
  write they cannot ask about, unless it is allowed beforehand.
- **Grok Build** calls the plugin's tools through its `use_tool` tool, and the
  agent often names a tool without its server first. Grok checks the rules
  against the name as given, so the server-qualified rule alone does not match
  that first call. The second rule matches the short name; a write still
  matches neither.
- **Antigravity** asks before any MCP tool no rule allows, reads included, and
  names the plugin's server `agent-tool-starter_agent-tool-starter` (plugin,
  then server). `agy -p` refuses a tool it cannot ask about.
- **Hermes** `hermes chat -q` refuses a write it cannot ask about; `hermes -z`
  and `--yolo` skip approval, so writes then run unasked.

## Settings

Every entry point takes the same settings. A flag wins over its environment
variable, and an option or setting wins over the variable too.

| Setting         | Flag              | Variable                           | Meaning                                                                       |
| --------------- | ----------------- | ---------------------------------- | ----------------------------------------------------------------------------- |
| `toolsets`      | `--toolsets`      | `AGENT_TOOL_STARTER_TOOLSETS`      | the toolsets that are on, or `all`; default those `src/project.ts` names      |
| `read_only`     | `--read-only`     | `AGENT_TOOL_STARTER_READ_ONLY`     | registers no tool that writes; wins over every other setting                  |
| `tools`         | `--tools`         | `AGENT_TOOL_STARTER_TOOLS`         | single tools to add by ID, whatever their toolset                             |
| `exclude_tools` | `--exclude-tools` | `AGENT_TOOL_STARTER_EXCLUDE_TOOLS` | single tools to remove by ID; wins over `tools` and `toolsets`                |
| `confirm`       | `--confirm`       | `AGENT_TOOL_STARTER_CONFIRM`       | MCP server only: `harness` (default) or `elicitation`, as the conventions say |

Lists are comma-separated in a flag or a variable. Where each harness reads them:

- **OpenCode** takes the plugin `options` shown above, with lists as arrays and
  `read_only` as a boolean.
- **Hermes** takes `plugins.entries.agent-tool-starter.settings` in
  `config.yaml`:

  ```yaml
  plugins:
    entries:
      agent-tool-starter:
        settings:
          read_only: false
          exclude_tools: []
  ```

- **Claude Code and Antigravity** start the plugin's server without flags and
  pass it the client's environment, so set the variables in the environment the
  harness runs in.
- **Codex and Grok Build** pass no environment to a plugin's MCP server, so the
  variables have no effect there. To change settings in Codex, add the server
  under `[mcp_servers]` in Codex's config with flags in `args` (as in
  [Any other MCP host](#any-other-mcp-host)) instead of using the plugin.

## Layout

- `src/project.ts` — the package's name, tool ID prefix, setting prefix and
  toolsets.
- `src/core/` — the tool contract and the tools, free of any harness and of
  the project's names.
- `src/tools.ts` — the list of every tool, which each entry point registers.
- `src/mcp/` — the MCP server, built to `dist/mcp.js` and run by
  `agent-tool-starter`.
- `src/opencode/` — the OpenCode plugin, built to `dist/opencode.js`.
- `src/cli/` — the command line the Hermes plugin calls, built to `dist/cli.js`
  and run by `agent-tool-starter-cli`.
- `src/hermes/`, `plugin.yaml` and `__init__.py` — the Hermes plugin.
- `skills/` — one skill per toolset, `skills/<name>/SKILL.md`, which every
  harness that takes skills loads from the package or plugin root.
- `plugin.json`, `mcp.json`, `.mcp.json`, `.claude-plugin/`, `.agents/plugins/`,
  `.antigravity-plugin/` and `mcp_config.json` — the plugin manifests of the
  other harnesses. The root `.mcp.json` is the configuration Grok Build reads
  (with `${CLAUDE_PLUGIN_ROOT}`, the variable both Grok Build and Claude Code
  expand); when working on this repository in Claude Code, decline the project
  MCP server it offers from that file.

How a release is made is in [`RELEASING.md`](RELEASING.md).

## License

[MIT](LICENSE)
