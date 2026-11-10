# CLAUDE.md

Project-specific rules for pi-bg. Everything else follows the global defaults and CONTRIBUTING.md.

- Open work is tracked in GitHub issues, not in a `TODO.md` or `HANDOFF.md` (dropped in c0bb657). This overrides the global ledger convention. Record a deferral, its current behavior and its reopen trigger as an issue comment, and mark the spot in source with `TODO(#N)` naming the issue number.
- A limitation that cannot be fixed in this repo (blocked upstream or unverifiable here) goes in DESIGN.md section 17.1 Known limitations with its reopen trigger, and its issue is closed as not planned.
- Close issues by putting `Fixes #N` in the PR body and merging the PR. A commit that landed without it is closed by hand with a comment naming the commit.
- Docs and a `CHANGELOG.md` line ship in the same commit as the change (CONTRIBUTING.md).
