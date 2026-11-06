# AGENTS

git-tools is one set of git tools for coding agents — the state of a working
tree, commits, history rewrites and stacked branches, worktrees and pushing —
implemented once and delivered to several harnesses (OpenCode, Claude Code,
Codex, Grok Build, Antigravity, Hermes Agent) from this repository. It works
against any git remote. It was made from
[agent-tool-starter](https://github.com/craftsamo/agent-tool-starter), whose
skeleton it keeps; the starter's later changes are merged from its default
branch. Releases are GitHub Releases tagged `v<version>`; consumers pin a tag
or the same npm version.

## Layout

- `src/project.ts` — the package's identity: name, tool ID prefix, setting
  prefix and toolsets. The Hermes plugin's counterpart is `project.py` in its
  package.
- `src/core/` — the tool contract and the tools. Each tool is a spec with a
  Zod v4 argument schema, an output schema, a toolset and a write class;
  `execute` gets a `ToolContext`.
- `src/<entry>/` — one thin entry point per delivery, which turns the specs
  into that harness's tools: `src/opencode/` (native plugin), `src/mcp/` (the
  stdio MCP server the other plugins bundle), and `src/cli/`, the command line
  the Hermes plugin (Python, in `src/hermes/`) calls.
- `docs/conventions.md` — the rules every tool follows.
- Tests sit beside the code they test (`*.test.ts`, `bun test`).

## Rules

- **Every tool follows [`docs/conventions.md`](docs/conventions.md).** A
  change to a convention changes that file first, with its reason.
- **`src/core/` knows no harness, no caller and no project.** No harness,
  product or machine names, paths or session conventions in code,
  descriptions or messages; the project's names reach it only through the
  entry points. What differs between consumers is a setting an entry point
  passes in, with a neutral default. It uses `node:*` modules only, never a
  runtime's own globals, so it runs on Node and Bun.
- **git only.** No tool writes to GitHub; pull requests and native stacks are
  [github-tools](https://github.com/craft-agent/github-tools)'. A safety rule
  that needs a fact only GitHub has reads it from GitHub, only when `origin`
  is on GitHub.
- **Tool IDs are a public interface.** Permission rules and skills key on them
  (`git_<domain>_<verb>`); renaming one is a breaking change.
- **A tool's write class is its contract with the harness.** The class sets
  the annotations every entry point publishes, so it must be the strictest
  class the tool's arguments can reach. `read_only` registers no write tool;
  annotations are hints, never the boundary.
- **Every git call goes through the one runner**, which fixes a
  non-interactive, allowlisted environment and maps failures to error codes.
- **Every commit stays small.** The pre-commit hook rejects a commit over 500
  reviewable changed lines; split the change instead of raising the limit.

## Commands

- `pnpm test`, `pnpm run typecheck`, `pnpm run format`, `pnpm run format:check`
- Single file: `bun test <path>`
- `pnpm run build && pnpm run smoke`, `pnpm run manifests:check`
- Hermes plugin (Python): `python -m unittest discover -s src/hermes/tests`
