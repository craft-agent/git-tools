# agent-git

Git tools for coding agents: the state of a working tree, commits, history
rewrites, worktrees, stacks and publishing. Built on
[agent-github](https://github.com/craftsamo/agent-github)'s tool contract and
delivered through the same entry points, so the tools read and behave alike.

| Harness      | Delivery                                |
| ------------ | --------------------------------------- |
| OpenCode     | native plugin (planned)                 |
| Hermes Agent | native plugin (planned)                 |
| Claude Code  | plugin: MCP server and skills (planned) |
| Codex        | plugin: MCP server and skills (planned) |
| Grok Build   | plugin: MCP server and skills (planned) |
| Antigravity  | plugin: MCP server and skills (planned) |

The tools need `git`; those that publish to GitHub also need the
[GitHub CLI](https://cli.github.com/), authenticated as you.

## Layout

- `src/core/` — the tools, free of any harness (planned).
- The entry points come from agent-github (planned).

## License

[MIT](LICENSE)
