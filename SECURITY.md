# Security policy

agent-tool-starter is a template for tool packages that coding agents call as
the person running them. A flaw in its skeleton (the tool contract, the entry
points or the release jobs) carries into every project made from it, and can
let an agent do more than that person agreed to, so please report one
privately.

## Supported versions

Fixes go into the default branch. A project made from the starter takes a fix
by merging the starter's default branch, or by porting the change.

## Reporting a vulnerability

Report it through [GitHub Security Advisories](https://github.com/craftsamo/agent-tool-starter/security/advisories/new). Do not open a public issue or pull request for it. agent-tool-starter has no bug bounty.

A useful report says:

- what an attacker can do, and what they need to do it
- the entry point and harness affected, and the file and lines where it goes
  wrong
- the commit it was found on
- the steps to reproduce it

## What the starter trusts

- **The tools run as you.** A tool reaches whatever it reaches with the
  credentials of the person running the agent, and can do no more than they
  may.
- **The harness decides what runs.** A tool that writes is marked as one, and
  asks for confirmation where the harness offers a way to ask; the harness's
  own approval settings decide whether a call runs.
- **Content a tool reads is untrusted.** Text read from files or services is
  data for the agent, never instructions to it.

## Scope

In scope:

- A tool doing more than its documentation says, or writing while it is
  marked or documented as read-only.
- A write that skips the confirmation the tool documents, or runs against a
  target other than the one confirmed.
- A secret or token leaking into a tool's output or a log.

Out of scope:

- What an agent does with a tool after the person running it approved the
  call, including changes that are wrong. Review its work as you would
  anyone's.
- A harness configured to approve every call unasked.
- Flaws in a project made from the starter that its own code introduced;
  report those to that project.
- Flaws in a harness or a runtime; report those to their maintainers.

Hardening ideas that are not vulnerabilities are welcome as ordinary issues.

## Disclosure

We aim to confirm a report within a week, keep you informed in the advisory,
and publish the advisory once the fix is on the default branch. Reporters are
credited in it unless they ask not to be.
