# Security policy

## Supported versions

Only the latest release, or `main` before the first release, is supported; there are no backports.

## Reporting a vulnerability

Report privately through GitHub private vulnerability reporting for this repository: open the repository's Security tab and choose "Report a vulnerability", or go directly to https://github.com/jszaday/pi-bg/security/advisories/new. Do not open a public issue or pull request for a vulnerability.

Please include:

- The affected version or commit.
- A description of the impact: what an attacker or a misbehaving agent gains.
- Steps to reproduce, ideally a minimal configuration or test.
- Any suggested fix or mitigation.
- Whether and when you intend to disclose publicly.

## Scope

In scope:

- Process-group kill and the detached reaper: signalling a process group other than the task's own, or the reaper killing a process it should not.
- Project-config trust: `.pi/pi-bg.json` must be read only when Pi has trusted the project, and an untrusted project's file must be ignored.
- Log files under the system temporary directory: directories are created with mode 0700 and files with mode 0600. Logs hold the raw output of the task, which may contain secrets, and finished-task logs persist until retention cleanup. A way to read another user's logs, or to make pi-bg write or delete outside its own log directories, is in scope.

Out of scope:

- A task that starts its own session (`setsid`) and so survives `bg_kill` and shutdown; this is a documented limit (see Limits in the [README](README.md)).
- Vulnerabilities in Pi itself; report those to the Pi maintainers.
- Secrets that a task prints into its own output: the log stores what the command wrote.

## Response

This is a single-maintainer project. Reports are acknowledged on a best-effort basis, with no fixed response or fix timeline (SLA) and no bounty.

## Disclosure

Please practice coordinated disclosure: give the maintainer a reasonable opportunity to investigate and fix before publishing details. Credit is given in the advisory unless you ask otherwise.
