# Changelog

## Unreleased

- Added: `bash` takes `stdin: true` to give a command a writable stdin, and the new `bg_write` tool writes to it (up to 64 KiB per call; `eof` closes stdin). Without `stdin` a task's stdin stays closed as before; the fallback runner rejects `stdin`, and writing to a task without stdin or one that has ended returns an explanation (#6).
- Fixed: a long session no longer keeps an output ring for every finished task; only the newest 50 do, and `bg_status` and `bg_output` read older tasks from their log files (#12).
- Fixed: `/bg tail` now shows the log tail of a finished task whose output was released from memory, and says so when that log is missing or unreadable (#26).
- Added: setting `lifecycle.keepOnReload` (default `false`): when `true`, `/reload` keeps running background tasks alive and the reloaded extension adopts them; quit, `/new`, resume, fork and Pi crashes still stop every task (#2).
- Added: a shells panel in the terminal UI (#15). With an empty editor, Down highlights the footer shell count and Enter opens the panel; `/bg` with no argument opens it too, while `/bg list` and RPC, print and json modes keep the text list. The panel lists tasks with live detail output and `x` to kill the selected shell.
- Changed: Down is captured only when pi-bg can confirm the editor has focus (no overlay, dialog or autocomplete menu); not yet run against a real Pi.
- Added: the `bg_monitor` tool turns new output lines of a running task into batched notifications, optionally filtered by a `grep` regex, so the agent can wait for specific output instead of polling `bg_output`; it stops after `max_notifications` messages (default 10) or when the task ends, and monitor messages are neither redelivered nor carried across a reload (#7).
- Security: the default log directory (`<tmpdir>/pi-bg-<uid>`) is now checked before use: a symbolic link, a non-directory or a directory owned by another user is refused with a message naming the fix, and a loose mode on our own directory is tightened to 0700 (#22).
- Added: `bg_kill` takes an optional `signal` (`INT`, `HUP`, `TERM`, `QUIT`, `USR1`, `USR2` or `KILL`; default `TERM`) for programs that shut down cleanly only on one of them; SIGKILL still follows after the grace period unless `KILL` is chosen. The fallback runner accepts only `KILL` and rejects other signals with an explanation (#10).
- Fixed: session shutdown now ends an active `bg_wait` (result `aborted`) and clears its timer instead of leaving it running (#13).
- Fixed: `bg_wait` now ends at once with `user_message` when the user's steer or follow-up was queued before the wait started (for example while the model was streaming), instead of running until its timeout (#19).
- Fixed: the move key now goes to the editor (cursor-left for `ctrl+b`) when the editor holds text, so editing a prompt during a foreground command works; with an empty editor it still moves the task (#11).

## 0.1.1 - 2026-11-09

- Fixed: a background job started with `&` inside a task is now killed at session shutdown and after a Pi crash, instead of surviving as an orphan (#18).
- Fixed: log cleanup now deletes only directories pi-bg created (those with an `owner.pid`), so unrelated directories under a custom `output.logDir` are kept; a relative `output.logDir` is rejected with a warning (#20).
- Fixed: config read errors, invalid JSON, log-cleanup failures and `kill_not_exited` now report their own cause and action, and `kill_not_exited` no longer mentions SIGTERM for the fallback runner (#21).
- Fixed: the `key` setting is validated and normalised (case, `-` as a separator); an invalid value warns and falls back to `ctrl+b`, and the hint shows the key in effect (#14).
- Changed: tested against Pi 1.5.1 (the dev dependency and the live gated suite).
- Security: dev-dependency updates for undici and minimatch; no runtime dependency is affected, because the published package has none (Pi, Pi TUI and typebox are peer dependencies only).
- Internal: CI runs the live (gated) test subset on every push and the full set weekly.

## 0.1.0 - 2026-11-09

- `bash` tool replaces the built-in: runs commands in the background with `run_in_background`, moves a call to the background after `bg_timeout` seconds (default 30, `0` disables), and accepts `notify` and `description` per call.
- Move a running command to the background with `ctrl+b` (rebindable with `key` in `pi-bg.json`) or with `/bg move`; double-press in tmux.
- The footer shows `k shells` while background tasks run; the widget below the editor is gone.
- The foreground hint, beneath the tool call's "Elapsed" line, shows a countdown to the automatic handoff, and `ctrl+b ctrl+b` under tmux or herdr.
- `bg_status` lists running tasks first (most recent first), hides finished ones unless `include_finished` is true, and pages with `limit` (default 10) and `offset`.
- `bg_status`, `bg_output`, `bg_wait` and `bg_kill` tools for listing, reading output, waiting (interruptible by a user message or Esc) and stopping background tasks.
- `/bg` command: list, tail, kill, and session-only `timeout` and `notify` overrides.
- Notifications when a task ends, delivered as a steer, follow-up or next-turn message, with per-task levels `off`, `error` and `done`.
- Configuration from global `pi-bg.json` and project `.pi/pi-bg.json` (project file only when trusted), and flags `--bg-timeout`, `--bg-notify` and `--no-bg`.
- Output logs under the system temporary directory, with per-task size cap and retention cleanup.
- All background tasks stop when the session shuts down, including `/reload`.
- POSIX only; inactive with a message on Windows.
