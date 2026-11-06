# AGENTS

agent-tool-starter is a GitHub template repository for tool packages that
coding agents call. A project made from it implements its tools once and
delivers them to several harnesses (OpenCode, Claude Code, Codex, Grok Build,
Antigravity, Hermes Agent) from one repository.

## Rules

- **The starter knows no domain.** No tool, product or service of a project
  made from it appears in the skeleton; what differs between projects is a
  value the project sets in one place.
- **Every commit stays small.** The pre-commit hook rejects a commit over 500
  reviewable changed lines; split the change instead of raising the limit.

## Commands

- `pnpm test`, `pnpm run format`, `pnpm run format:check`
- Single file: `bun test <path>`
