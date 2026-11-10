# Prior art

What already exists for running commands in the background under a coding agent, what pi-bg took from it, and where it deliberately differs. This is a condensed record of the survey that preceded the design; `DESIGN.md` has the resulting decisions. The survey was a snapshot of npm and GitHub taken in late 2026 against Pi 1.4.0, based on READMEs and targeted code reading. No extension was executed, so behavior claims are from source and documentation, not runs. Claude Code behavior is taken from its public documentation and GitHub issues and was not re-verified.

## Requirements used to compare

The survey scored each tool against six requirements: (1) a key moves a running command to the background; (2) a command can start in the background; (3) the agent can wait on a task without ignoring a new user message; (4) completion notifications are delivered, optionally passively; (5) the agent can query runtime state and tail output; (6) a foreground command moves itself to the background after a timeout (about 20 to 30 s, adjustable per call).

## Existing Pi extensions

About 15 background-task packages for Pi were examined. Most are young, single-maintainer projects. No one of them satisfied requirements 1, 3, 4 and 6 together.

| Extension | What it contributes | Gap relative to the requirements |
|---|---|---|
| [pringled/pi-extensions](https://github.com/Pringled/pi-extensions) (`pi-background`) | Literal `ctrl+b` handoff, consumed only while a movable command exists; wraps `BashOperations.exec` | 120 s fixed auto-background; wait is pattern-based, not a blocking wait |
| [patty-io/pi-patty-bg-tasks](https://github.com/patty-io/pi-patty-bg-tasks) | Closest feature match: bash override, auto-background, `attach`, `notify` flag, monitor | Uses `ctrl+shift+b`; any typed input backgrounds a foreground command; in-memory only |
| [gvanderclay/pi-bg-bash](https://github.com/gvanderclay/pi-bg-bash) | Best engineered: 0600 logs with size cap and GC, crash watcher that kills orphans, explicit "moved to background" result text | No timed auto-background by design; `ctrl+shift+b` needs kitty or modifyOtherKeys; no blocking wait |
| [richardgill/pi-extensions](https://github.com/richardgill/pi-extensions) (`background-bash`) | Per-call `timeout` that backgrounds (default 30 s, cap 60) | No shortcut, no wait |
| [chthub/pi-async-bash](https://github.com/chthub/pi-async-bash) | Races the native `execute()` against a timer | 60 s via a CLI flag only; after handoff only native snapshots are available |
| [Barty13/pi-wake-jobs](https://github.com/Barty13/pi-wake-jobs) | `job_status` with wait, clean and well tested | No bash override, no shortcut; wait ends only on abort |
| [aliou/pi-processes](https://github.com/aliou/pi-processes) | Rich process manager with watch and notify modes | Shortcut and auto-background only in an example, via an adopt channel |
| [mjakl/pi-processes](https://github.com/mjakl/pi-processes), [99percentpeople/pi-extensions](https://github.com/99percentpeople/pi-extensions), [milanglacier/pi-background-tasks](https://github.com/milanglacier/pi-background-tasks) | Explicit wait on exit, pattern or timeout; PTY attach; wake on output regex | No bash override or auto-background |
| [Leechael/pi-famulus](https://github.com/Leechael/pi-famulus), [yusukeshib/pi-babysit](https://github.com/yusukeshib/pi-babysit) | Auto-background after 20 s; wait with abort | Depend on an external binary; babysit disables built-in `bash` |
| [1aboveio/pi-better-harness](https://github.com/1aboveio/pi-better-harness) | Only one that persists tasks across reload | Large, sandbox-coupled |
| [iamwrm/pi-unified-exec](https://github.com/iamwrm/pi-unified-exec), [ByteTrue/pi-package-mono](https://github.com/ByteTrue/pi-package-mono), [ismailsaleekh/pi-background-tasks](https://github.com/ismailsaleekh/pi-background-tasks) | Yield-and-poll model; run/status/kill; delegated agents | Different model or much wider scope |

Cross-cutting findings that shaped the design:

- Process-group kill (detached spawn, signal the negative pid) is the common baseline and is what Pi's own bash does, so pi-bg signals groups too.
- Almost all extensions kill their jobs at `session_shutdown`, which also fires on `/reload`. pi-bg does the same and lists persistence as an open item.
- pi-bg-bash's log hygiene (private permissions, byte-offset reads, a cap) was adopted for output storage.
- Only one extension may register `bash`, so pi-bg checks that the tool it replaces is the built-in before wrapping, as pringled does.

## Pi extension API findings

Reading Pi's extension types and docs established what a handoff implementation can rely on, and what it cannot.

- Returning early while a process keeps running is possible: nothing ties the child to the tool-call promise except the abort `signal` the extension forwards. The extension must replace `bash` (same-name `registerTool`, as in Pi's `tool-override` example) and own the signal, because the tool-call signal is aborted on Esc.
- Two techniques work with stock APIs: wrap `BashOperations.exec` (pringled) or race the native `execute()` (pi-async-bash). pi-bg uses the first because the wrapper sees every output chunk from the start and can tee it to a real log; the race approach has only snapshots after handoff.
- `ctrl+b` is Pi's default `cursorLeft` binding. Claiming it unconditionally breaks cursor movement. pringled's approach, consuming it via `onTerminalInput` only while a movable command exists, was adopted. Whether `registerShortcut` can override a built-in binding is undocumented.
- Pi delivers a steering message only after the current tool batch ends, and Esc discards queued steers. No API makes a tool return when a steer is queued. The workable route (not shipped by any surveyed extension) is to observe the `input` event and `ctx.hasPendingMessages()` and resolve the wait early.
- `sendMessage` with `deliverAs` and `triggerTurn` covers passive and waking notifications; `triggerTurn: false` without `deliverAs` is context-only.
- `pi.exec` has no detached or process-group option, so spawning is done with Node directly.
- Remaining API gaps: no first-class detach for an in-flight built-in bash call, no event when a steer is queued other than `input`, no documented shortcut precedence, and a handoff leaves a normal-looking tool result in the transcript, so the result text must say the command moved to the background.

Sources: Pi repository and docs (`extensions.md`, `keybindings.md`, `sdk.md`) at <https://github.com/earendil-works/pi>.

## Claude Code as reference

Claude Code is the behavioral reference for the user-facing model. Documentation: <https://code.claude.com/docs/en/interactive-mode>, <https://code.claude.com/docs/en/tools-reference>, <https://code.claude.com/docs/en/headless>. Issue numbers below are in <https://github.com/anthropics/claude-code>.

Behavior borrowed:

- `ctrl+b` moves a running command to the background; `run_in_background` starts one there; a foreground timeout moves the command to the background instead of killing it, with a result naming the task id and output path.
- Output goes to a file the model reads with its normal read tool; completion arrives as a notification that wakes an idle session; guidance tells the model to end its turn rather than poll.
- A task list (`/tasks`) and a stop tool.

Where pi-bg differs:

- Auto-background default is 30 s and adjustable per call and per session, not a fixed 120 s.
- A dedicated `bg_output` (tail, cursor, grep) exists alongside the readable log path; Claude Code removed its `TaskOutput` tool in 2.1.277.
- `bg_wait` exists and returns on a user message or Esc. Claude Code documents no blocking wait, and a reported blocking wait could not be interrupted (#83817).
- A Monitor-style tool (output lines as notifications) is deferred.

Failure modes reported against Claude Code and the guard pi-bg adopted:

| Reported failure | Issues | Guard in pi-bg |
|---|---|---|
| Stale "new output" reminders re-firing, loops, token exhaustion | #7479, #11716, #12302, #14968 | One-way notification status, no periodic reminders, single redelivery on proven loss |
| Output directory ignores `TMPDIR` | #15700 | `os.tmpdir()`, config override, unit test with `TMPDIR` set |
| Orphans after SIGTERM or host crash | #102511, #102009, #106483 | Group signalling, kill on every shutdown path, optional reaper |
| Self-backgrounding command reported complete instantly | #93126 | Exit is that of the spawned process group leader; double-forking daemons are a documented limit |
| Blocking wait cannot be interrupted | #83817 | `bg_wait` returns on user message and Esc |
| Raw output dumped into context | #76335 | Bounded tails, `max_bytes`, cursors |
| Notification says done while a sub-task still runs | #92952 | Notify only on the task's own terminal state; no nested tasks |
| `ctrl+b` clashes with tmux or readline | #5376, #21008, #18054 | Key is rebindable; tmux double-press documented |

## Not verified

Claude Code's exact footer wording for shell tasks, its current output-file path and truncation semantics, and several Pi shortcut-precedence details were not confirmed. Download counts and commit history of the surveyed extensions were not collected.
