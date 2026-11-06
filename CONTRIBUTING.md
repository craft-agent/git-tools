# Contributing to agent-tool-starter

Thank you for helping. This guide covers how to propose a change, set up the repository, and get a pull request merged. The rules the code itself follows are in [AGENTS.md](AGENTS.md), which AI coding agents read too.

## Before you start

- Search the [issues](https://github.com/craftsamo/agent-tool-starter/issues) and [pull requests](https://github.com/craftsamo/agent-tool-starter/pulls?q=is%3Apr) first, closed ones included.
- Open an issue before starting a large change or a new feature, so it can be agreed first.
- A fix for a bug or a documentation error can go straight to a pull request.
- Report a vulnerability privately as [SECURITY.md](SECURITY.md) describes, not in an issue or pull request.

## Setup

You need Node.js `>=24`.

```sh
git clone https://github.com/craftsamo/agent-tool-starter.git
cd agent-tool-starter
corepack enable
pnpm install
```

## Checks

Run these before you push:

```sh
pnpm run format:check
pnpm run typecheck
pnpm test
python -m unittest discover -s src/hermes/tests
pnpm run build
pnpm run manifests:check
pnpm run smoke
```

The Hermes plugin needs Python 3.11 or later and no packages. After a change to a tool's ID, run `pnpm run build && pnpm run manifests` to update `plugin.yaml`.

## Commits

Commits follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): subject`, in the imperative.

| Type       | For                                              |
| ---------- | ------------------------------------------------ |
| `feat`     | A new tool, option, skill or harness integration |
| `fix`      | Something that did not work as documented        |
| `docs`     | Documentation only                               |
| `ci`       | This repository's own CI and release jobs        |
| `refactor` | Restructuring without a change in behavior       |
| `test`     | Tests only                                       |
| `chore`    | Anything else, such as tooling or a version      |

The scope names the area, such as `core`, `opencode`, `mcp`, `hermes`, `skills` or `ci`. Keep each commit to one change that passes the checks on its own; the body says why, when the subject cannot.

## Pull requests

- Branch from the default branch and keep a pull request to one change.
- Describe what it changes and why, how you checked it, and the issue it closes.

A maintainer labels the pull request. The label decides how far the next version moves:

| Label            | Next version                  |
| ---------------- | ----------------------------- |
| `breaking`       | major                         |
| `feature`        | minor                         |
| `fix`            | patch                         |
| `documentation`  | patch                         |
| `dependencies`   | patch                         |
| any other        | patch                         |
| `skip-changelog` | left out of the release notes |

## License

By contributing, you agree that your contributions are licensed under the project's [license](LICENSE).
