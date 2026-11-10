# Changelog

## Unreleased

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
