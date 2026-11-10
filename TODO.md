Interim list; each item is being moved to a GitHub issue, after which this file is removed and the TODO(tag) markers in src name the issue number instead.

# pi-bg: work ledger

Behavior and rationale are in `DESIGN.md` (cited as "DESIGN section N"); the build plan, contracts and spike findings are in git history and in the code. This file holds only the open items. Priorities: P0 security/crash/data loss, P1 blocker for the release, P2 important, P3 later. Each entry names the current behavior and the trigger to act.

- P2 `TODO(persist)`: persistence of tasks across session resume and reload. Current behavior: all tasks are killed on every `session_shutdown`, ids in an old transcript report "stopped when Pi exited". Trigger: users complain that `/reload` kills servers.
- P3 `TODO(reaper)`: the orphan reaper is shipped (DESIGN section 12). Remaining: tasks run by the Pi-ops fallback runner (no pid) and platforms where `createReaper()` returns null are not watched, so a SIGKILL of Pi leaves them as orphans. Trigger: the fallback runner is used in practice.
- P2 `TODO(wait-queue-event)`: replace the `input`-based wake with a Pi queue event when Pi exposes one. Trigger: a Pi release adding it.
- P3 `TODO(generic-tools)`: backgrounding for tools other than `bash`.
- P3 `TODO(stdin)`: write to a background task's stdin.
- P3 `TODO(monitor)`: a Monitor-style tool that turns output lines into notifications.
- P3 `TODO(windows)`: Windows support.
- P3 `TODO(bg-start)`: a standalone start tool if `bash` ownership conflicts occur.
- P3 `TODO(kill-signal)`: signal choice on `bg_kill`.
- P3 `TODO(editor-aware-key)`: pass ctrl+b to the editor when it is non-empty. Current behavior: the key is consumed as the handoff whenever a task is movable. `ctx.ui.getEditorText()` works mid-tool (spike S4), so the accessor exists (breadcrumb in `src/pi/input.ts`). Trigger: users report losing ctrl+b in the editor.
- P3 `TODO(runtime-gc)`: finished-task runtime entries. Current behavior: each task keeps a bounded output ring, but entries are never GC'd across the session (breadcrumb in `src/pi/kill.ts`). Trigger: very long sessions with thousands of tasks.
- P3 `TODO(wait-dispose)`: `WaitCoordinator` has no dispose method. Current behavior: an active `bg_wait` keeps its timer (up to `maxTimeoutSeconds`) after `session_shutdown` (breadcrumb in `src/pi/lifecycle.ts`). Trigger: a leaked timer is observed to keep Pi alive or fire after shutdown.
- P3 `TODO(key-validate)`: pi-tui exports no key-id validator (`parseKeyId` is internal), so the `key` config is not validated. Current behavior: a typo in `pi-bg.json` never matches and gives no warning (breadcrumb in `src/pi/input.ts`). Trigger: pi-tui exporting a validator.
- P3 `TODO(task-panel)`: an overlay panel for tasks beyond the widget and `/bg`.
