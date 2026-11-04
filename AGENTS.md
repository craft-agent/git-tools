# AGENTS

git-tools is one set of git tools for coding agents — the state of a working
tree, commits, history rewrites and stacked branches, worktrees and pushing —
delivered to several harnesses (OpenCode, Claude Code, Codex, Grok Build,
Antigravity, Hermes Agent) from this repository. It is built on github-tools'
tool contract and entry points, and works against any git remote. Releases are
GitHub Releases tagged `v<version>`; consumers pin a tag or the same npm
version.

## Layout

- `src/core/` — the tools. Each is a spec on github-tools' contract: a Zod
  v4 argument schema, an output schema, a toolset and a write class.
- The entry points (OpenCode plugin, MCP server, CLI, Hermes plugin) are
  built with github-tools' builders from this package's profile.
- `docs/conventions.md` — where these tools differ from github-tools'
  conventions, which hold for everything else.
- Tests sit beside the code they test (`*.test.ts`, `bun test`).

## Rules

- **Every tool follows [`docs/conventions.md`](docs/conventions.md)** and,
  where it says nothing, github-tools' conventions. A change to a convention
  changes that file first, with its reason.
- **git only.** No tool writes to GitHub; pull requests and native stacks are
  github-tools'. A safety rule that needs a fact only GitHub has reads it
  through github-tools' functions, only when `origin` is on GitHub.
- **`src/core/` knows no harness and no caller.** No harness, product or
  machine names, paths or session conventions in code, descriptions or
  messages. What differs between consumers is a setting an entry point passes
  in, with a neutral default. It uses `node:*` modules only, never a
  runtime's own globals, so it runs on Node and Bun.
- **Tool IDs are a public interface.** Permission rules and skills key on them
  (`git_<domain>_<verb>`); renaming one is a breaking change.
- **A tool's write class is its contract with the harness.** The class sets
  the annotations every entry point publishes, so it must be the strictest
  class the tool's arguments can reach. `read_only` registers no write tool;
  annotations are hints, never the boundary.
- **Every git call goes through the one runner**, which fixes a
  non-interactive, allowlisted environment and maps failures to error codes.

## Commands

- `pnpm test`, `pnpm run format`, `pnpm run format:check`
- Single file: `bun test <path>`
