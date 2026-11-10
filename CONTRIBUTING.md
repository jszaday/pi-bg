# Contributing

pi-bg is maintained by one person, so review is best-effort. The design of record is [DESIGN.md](DESIGN.md); setup and usage are in the [README](README.md).

## Before you open a pull request

- **Small and focused.** One logical change per pull request, and each commit builds and passes the checks on its own. Send groundwork (a refactor, a new interface) first.
- **No drive-by changes.** No unrelated cleanup, reformatting or tool churn in the same change.
- **Docs in the same change.** If behavior, configuration or a documented fact changes, update the docs and the [CHANGELOG](CHANGELOG.md) in the same commit.
- **A test that fails without the change.** A bug fix or behavior change comes with one.
- **No new runtime dependency without discussion.** Open an issue first.

## Checks

```
npm ci
npm run check
```

`npm run check` runs the typecheck and the unit tests. Tests that need a real Pi are skipped by default (`npm run test:gated` runs them). A skipped test is not a pass: say in the pull request what skipped and why.

## Issues and logs

Scrub tokens, API keys, credentials and personal paths from every log, screenshot or command output you paste into an issue or pull request, and never include them even in part. Review what you are about to publish, including commit metadata. If you pasted a credential by accident, revoke it and do not repeat it publicly.

Report security problems privately, not in an issue: see [SECURITY.md](SECURITY.md).

## AI-assisted contributions

Contributions prepared with AI assistance are held to the same bar, because review checks the change, not how it was produced. You are accountable for every line you submit and should understand it well enough to defend it.

## Merging and license

Pull requests are rebase-merged to keep history linear. Contributions are accepted under the project's [MIT license](LICENSE) (inbound equals outbound); there is no contributor license agreement.
