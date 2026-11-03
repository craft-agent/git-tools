# AGENTS

agent-git is one set of git tools for coding agents — the state of a working
tree, commits, history rewrites, worktrees, stacks and publishing — delivered
to several harnesses (OpenCode, Claude Code, Codex, Grok Build, Antigravity,
Hermes Agent) from this repository. It is built on agent-github's tool
contract and entry points. Releases are GitHub Releases tagged `v<version>`;
consumers pin a tag or the same npm version.

## Layout

- `src/core/` — the tools. Each is a spec on agent-github's contract: a Zod
  v4 argument schema, an output schema, a toolset and a write class.
- The entry points (OpenCode plugin, MCP server, CLI, Hermes plugin) are
  built with agent-github's builders from this package's profile.
- Tests sit beside the code they test (`*.test.ts`, `bun test`).

## Rules

- **Every tool follows agent-github's `docs/conventions.md`**, plus the git
  deltas this repository records. A change to a convention changes its file
  first, with its reason.
- **`src/core/` knows no harness and no caller.** No harness, product or
  machine names, paths or session conventions in code, descriptions or
  messages. What differs between consumers is a setting an entry point passes
  in, with a neutral default. It uses `node:*` modules only, never a
  runtime's own globals, so it runs on Node and Bun.
- **Tool IDs are a public interface.** Permission rules and skills key on
  them; renaming one is a breaking change.
- **A tool's write class is its contract with the harness.** The class sets
  the annotations every entry point publishes, so it must be the strictest
  class the tool's arguments can reach. `read_only` registers no write tool;
  annotations are hints, never the boundary.

## Commands

- `pnpm test`, `pnpm run format`, `pnpm run format:check`
- Single file: `bun test <path>`
