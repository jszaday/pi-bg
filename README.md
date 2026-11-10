# pi-bg

[![CI](https://github.com/jszaday/pi-bg/actions/workflows/ci.yml/badge.svg)](https://github.com/jszaday/pi-bg/actions/workflows/ci.yml) [![license](https://img.shields.io/github/license/jszaday/pi-bg)](LICENSE)

Background tasks for the [Pi coding agent](https://github.com/earendil-works/pi) (`pi-coding-agent`). Pi's built-in `bash` tool blocks the agent until a command ends, so a dev server, a long build or a slow test run either stalls the session or has to be killed. pi-bg lets a running command move to the background while the agent keeps working, and gives the agent tools to check on it, wait for it and stop it.

## Status

Version 0.1.1, available from git (see Install). Tested against Pi 1.5.1; POSIX only (Linux and macOS). All six features below are implemented and covered by unit tests and live (gated) tests against a real Pi session. Open items are tracked in [GitHub issues](https://github.com/jszaday/pi-bg/issues).

Requirements: Pi (`pi-coding-agent`) 1.5.1, the version it is tested against; Node.js 22.19 or newer; a POSIX system (Linux or macOS).

## Features

- `ctrl+b` moves a running `bash` command to the background (the key is rebindable).
- A command can start in the background directly.
- `bg_wait` blocks the agent until a task ends, and is interrupted when a new steering message arrives, so the user is never locked out.
- Optional notifications to the agent when a task completes or fails.
- Queries for status, output and tail, including runtime and separate stdout and stderr.
- `bg_timeout`: a foreground command that runs longer than this moves to the background automatically. Default 30 s, overridable per call.

## Install

From git:

```
pi install git:github.com/jszaday/pi-bg
```

From a local checkout:

```
pi install /path/to/pi-bg
```

An npm release is planned.

Both the commands above write a package entry to `~/.pi/agent/settings.json`. Add `-l` to write it to `.pi/settings.json` instead; Pi reads project declarations only after the project is trusted. To try the extension for one run without installing it, pass `-e /path/to/pi-bg`. The package is loaded through the `pi.extensions` field of `package.json`, which points at `src/index.ts`. See Pi's package documentation for the other source forms.

## Example

Ask the agent: "Start the dev server in the background, then check that it came up." The agent calls `bash` with `run_in_background` set and gets back a task id and a log path. It then calls `bg_status` to see that the task is running, and `bg_output` to read the server's startup lines. When you are done, ask it to stop the server (`bg_kill`), or run `/bg kill all` yourself.

## Tools

`bash` replaces the built-in `bash` tool and adds five parameters: `bg_timeout` (seconds the call may run in the foreground before it is moved to the background; `0` disables this for the call), `run_in_background` (start the command as a background task at once), `notify` (`off`, `error` or `done` for this task) `description` (a short label shown in task lists) and `stdin` (give the command a writable stdin for `bg_write`; default off, so a program that reads stdin sees end of input). A call that is moved to the background returns a normal result with the task id; the command is not killed.

`bg_status` lists background tasks, or shows one task with the last lines of its output. It reports state, runtime, exit code and whether the task's notification has been delivered. A list shows running tasks first, most recent first, 10 per page (`limit`, `offset`); finished tasks are hidden unless `include_finished` is true.

`bg_output` reads a task's output. It returns the tail by default, or only new output after a byte cursor from the previous call, and it can filter lines with a regular expression and select stdout or stderr.

`bg_wait` blocks until a task ends (or until any or all of a set of tasks end) or until a timeout passes. The wait is interruptible: a user message, or Esc, returns control to the agent.

`bg_kill` stops one task by id, or all tasks. It sends SIGTERM to the task's process group and sends SIGKILL if the group is still alive after a short grace period. The optional `signal` (`INT`, `HUP`, `TERM`, `QUIT`, `USR1`, `USR2` or `KILL`) replaces the first signal; `KILL` skips the grace period. The fallback runner accepts only `KILL`.

`bg_write` writes text to the stdin of a running task that was started with `stdin` true, and with `eof` closes stdin so the program sees end of input. One call carries at most 64 KiB. A task started without stdin, or one that has ended, is rejected with an explanation. The fallback runner does not support `stdin`.

## Commands

`/bg` lists tasks and shows the tail of one (`/bg tail <id>`). It also stops tasks (`/bg kill <id>` or `/bg kill all`), sets the session timeout and notification level (`/bg timeout <s>`, `/bg notify <level>`) for the current session only, and moves the running command to the background (`/bg move`). `/bg help` lists the subcommands.

## Keys

The move key is `ctrl+b` by default. It is captured only while a movable `bash` command is running, so cursor-left in the editor works at other times. A hint line with a countdown to the automatic handoff appears beneath the command's "Elapsed" line after a short delay. In tmux, `ctrl+b` is also the tmux prefix, so press it twice to deliver one press to Pi. To use another key, set `key` in `pi-bg.json` (modifiers `ctrl`, `shift`, `alt`, `super` joined to one key, such as `ctrl+g`; case and `-` instead of `+` are accepted). A value that is not a key id is reported and the default key is used. The `keybindings.json` custom action is not supported: Pi accepts the entry but does not resolve it for extensions.

## Configuration

Settings come from three sources, highest precedence first: `/bg` session overrides, command-line flags, and config files. Per-call parameters override all of these.

Flags:

- `--bg-timeout <seconds>` sets the session timeout.
- `--bg-notify <level>` sets the notification level.
- `--no-bg` disables pi-bg: `bash` runs unchanged and the `bg_*` tools report that they are inactive.

Config files are JSON with the same keys as in the defaults table in [DESIGN.md](https://github.com/jszaday/pi-bg/blob/main/DESIGN.md#6-configuration), which is the single source for key names, meanings and default values:

- Global: `pi-bg.json` in Pi's agent directory (`getAgentDir()`, normally `~/.pi/agent`).
- Project: `.pi/pi-bg.json` in the working directory. It is read only when the project is trusted. An untrusted project's file is ignored.

An invalid key is not fatal. pi-bg reports the key, the problem and the default it used.

## Limits

- `/new`, resume, fork and quit stop every running background task, and so does `/reload` unless you set `lifecycle.keepOnReload` to `true` in `pi-bg.json`: then background tasks keep running through a reload and are available again afterwards (a task still in the foreground is stopped). Tasks are never persisted across Pi restarts.
- The process group is the unit of cleanup. A process that starts its own session (`setsid`) leaves the group and survives `bg_kill` and shutdown.
- A job a task starts with `&` (for example `sleep 300 &`) keeps running after the task shows `exited`; pi-bg leaves it alone until the session ends, then kills it (SIGKILL, no grace period), also after a Pi crash. It is not listed in `bg_status`.
- If Pi is killed with SIGKILL or crashes, a small detached watcher per task kills the task's process group within about a second of Pi disappearing (see [DESIGN.md](https://github.com/jszaday/pi-bg/blob/main/DESIGN.md), section 12). Without the watcher (unavailable on the platform, or the fallback runner, which exposes no pid), such tasks can survive as orphans.
- Output logs are written under the system temporary directory. Logs of finished tasks outlive the session and are removed after a retention period. A task whose log reaches the per-task cap stops writing to the log; it is not killed, and its in-memory tail keeps updating.
- Windows is not supported.

For the reasoning behind these limits, the open items and the planned work, see [DESIGN.md](https://github.com/jszaday/pi-bg/blob/main/DESIGN.md) sections 12 and 17 and the [open issues](https://github.com/jszaday/pi-bg/issues).

## Security and privacy

Task output is written unencrypted to log files under the system temporary directory, in directories readable only by their owner (mode 0700, files 0600). The logs can contain secrets that a command prints, and the logs of finished tasks persist until retention cleanup (7 days by default). Project-level config (`.pi/pi-bg.json`) is read only when the project is trusted. To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Prior art

[DESIGN.md](https://github.com/jszaday/pi-bg/blob/main/DESIGN.md) surveys these and records what was borrowed: Claude Code's background tasks (the `run_in_background` shape and completion notifications), pi-background (wrapping the bash operations to hand off a live command), pi-patty-bg-tasks, pi-bg-bash (byte-offset output reads, log layout, orphan reaper) and richardgill's background-bash (30 s per-call auto-background default). pi-bg is a new implementation and shares no code with them. A longer write-up is in [docs/prior_art.md](https://github.com/jszaday/pi-bg/blob/main/docs/prior_art.md).

## Development

```
npm ci
npm run check
```

`npm run check` runs the typecheck and the unit tests.

Tests use Vitest and live under `test/`: `core/` for pure logic, `adapters/` for process and log adapters, `tools/` for schemas, `fakes/` for the shared test kit, and `arch.test.ts` for module-boundary checks. `npm run test:gated` runs tests that need a real Pi and are skipped by default.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
