# Security policy

agent-git gives coding agents tools that read and change git repositories,
and push them to their remotes, as the person running them. A flaw in it can
let an agent do more than that person agreed to, so please report one
privately.

## Supported versions

Fixes go into the latest release. Consumers pin a release tag, so they get a
fix by moving to the new tag.

## Reporting a vulnerability

Report it through [GitHub Security Advisories](https://github.com/craftsamo/agent-git/security/advisories/new). Do not open a public issue or pull request for it. agent-git has no bug bounty.

A useful report says:

- what an attacker can do, and what they need to do it
- the tool and harness affected, and the file and lines where it goes wrong
- the version (the release tag the consumer pins)
- the steps to reproduce it against the latest release

## What agent-git trusts

- **The tools run as you.** Every tool runs git, and a safety check may read
  GitHub through `gh`, as the person running the agent, and can do no more
  than that account may. No tool writes to GitHub.
- **The harness decides what runs.** A tool that writes is marked as one, and
  asks for confirmation where the harness offers a way to ask; the harness's
  own approval settings decide whether a call runs.
- **Content read from a repository is untrusted.** Commit messages, file
  contents, pull request text and logs are data for the agent, never
  instructions to it.

## Scope

In scope:

- A tool doing more than its documentation says, or writing while it is
  marked or documented as read-only.
- A write that skips the confirmation the tool documents, or runs against a
  target other than the one confirmed.
- A secret or token leaking into a tool's output, an issue, a comment, a
  commit or a log.

Out of scope:

- What an agent does with a tool after the person running it approved the
  call, including changes that are wrong. Review its work as you would
  anyone's.
- A harness configured to approve every call unasked.
- Flaws in GitHub, the GitHub CLI, git or a harness; report those to their
  maintainers.

Hardening ideas that are not vulnerabilities are welcome as ordinary issues.

## Disclosure

We aim to confirm a report within a week, keep you informed in the advisory,
and publish the advisory once a fixed release is out. Reporters are credited
in it unless they ask not to be.
