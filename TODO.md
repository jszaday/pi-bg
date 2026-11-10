# TODO

Deferred work, current state only. Each entry gives priority (P0 security/crash/data loss, P1 blocker, P2 important, P3 later), the current behavior, and the trigger to act. Remove an entry when its issue is closed.

## P3 #3 Orphan reaper does not cover the fallback runner

- Current behavior: the detached reaper that kills a task's process group after Pi disappears is not started for tasks run by the fallback runner, because that runner exposes no pid (#3).
- The fallback runner is chosen only when no shell resolves, which on POSIX means a nonexistent custom shell path (Pi's own bash tool also fails then), so this is a documented limitation and the issue stays open (#3).
- Trigger: a reported orphan from the fallback runner, or Windows support (#3, #8).

## P3 #4 Wait wake uses the input event, not a queue event

- Current behavior: `bg_wait` is woken early by the `input` event after a short settle delay, which can cause at worst one spurious early return of a model step (#4).
- Blocked upstream: Pi 1.5.1 exposes no extension-visible queue-update event (#4).
- Trigger: Pi ships a queue-update event, or abort-on-steer (#4).

## P3 #5 Non-bash tools cannot be backgrounded

- Current behavior: only `bash` can be moved to or started in the background (#5).
- Leaning won't-fix: Pi cannot detach a running tool call, so pi-bg has no way to background other tools (#5).
- Trigger: Pi gains a way to detach a running tool call, plus demand for backgrounding non-bash tools (#5).

## P3 #8 Windows is unsupported

- Current behavior: pi-bg goes inactive on Windows with an `unsupported_platform` message and leaves the built-in `bash` unchanged; process-group signalling and the shell adapter assume POSIX (#8).
- Candidate scope when taken up: Git-Bash-only support (#8).
- Trigger: a Windows CI runner exists (#8).

## P3 #9 No standalone start tool

- Current behavior: starting in the background goes through `bash` with `run_in_background`, which requires pi-bg to own the `bash` tool (#9).
- Trigger: a user reports another extension owning `bash`; then register `bg_start` only in that case (#9).
