# git-tools

Git tools for coding agents: the state of a working tree, commits, history
rewrites and stacked branches, worktrees and pushing, against any git remote.
Built on [github-tools](https://github.com/craft-agent/github-tools)' tool
contract and delivered through the same entry points, so the tools read and
behave alike. Pull requests and native stacks on GitHub are github-tools'.

| Harness      | Delivery                                |
| ------------ | --------------------------------------- |
| OpenCode     | native plugin (planned)                 |
| Hermes Agent | native plugin (planned)                 |
| Claude Code  | plugin: MCP server and skills (planned) |
| Codex        | plugin: MCP server and skills (planned) |
| Grok Build   | plugin: MCP server and skills (planned) |
| Antigravity  | plugin: MCP server and skills (planned) |

The tools need `git`. Where `origin` is on GitHub, a few safety checks also
read it through the [GitHub CLI](https://cli.github.com/), authenticated as
you. [`docs/conventions.md`](docs/conventions.md) describes how the tools are
named and how they behave.

## Layout

- `src/core/` — the tools, free of any harness (planned).
- The entry points come from github-tools (planned).

## License

[MIT](LICENSE)
