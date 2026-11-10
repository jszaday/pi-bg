# pi-bg: design

pi-bg is a Pi (pi-coding-agent 1.5.1) extension that lets bash commands run in the background: start them there, move them there with a key, auto-move them after a timeout, wait on them without blocking the user, and be told when they finish. This document is the design of record. Open work is tracked in [GitHub issues](https://github.com/jszaday/pi-bg/issues); this file does not restate it.

## 1. Scope, requirements, terms

Labels. `S1` to `S8` are spikes (small prototypes with a pass criterion, run and then removed from the tree; their findings are folded in here and they remain in git history), `Q1` to `Q8` are open coordinator decisions, `W0` to `W11` are workstreams; the planning notes that defined them were removed from the tree and remain in git history. "Surveyed extensions" are the existing Pi background-task packages studied before this design (pringled `pi-background`, patty `pi-patty-bg-tasks`, `pi-bg-bash`, `pi-async-bash`, richardgill `background-bash`, `pi-famulus`, `pi-wake-jobs`, `pi-unified-exec`, and others). Claude Code issue numbers (`#7479` and so on) are in the `anthropics/claude-code` GitHub repository; they and the Claude Code behavior described are taken from public docs and issue threads, not re-verified. The survey and Claude Code notes behind this design are condensed in `docs/prior_art.md`; the Pi source reading was done by research passes whose findings appear in the evidence table of section 2 with the source symbol for each claim.

Requirements (from the user):

1. R1: a key (default `ctrl+b`) moves the currently running tool to the background.
2. R2: the agent can start a tool in the background from the outset.
3. R3: the agent can wait on a background task until a new steering instruction arrives (an interruptible wait).
4. R4: an optional passive notification (a steering message) on task completion or error.
5. R5: the agent can query a task's runtime and the tail of its output.
6. R6: `bg_timeout`: a call runs as a normal foreground call until it exceeds the timeout, then is moved to the background, not killed. Session default about 20 to 30 s, overridable per call.

Locked decisions: new build (borrow ideas, no forks); TypeScript with no runtime dependency beyond what Pi provides; tasks are killed when the session exits (persistence is deferred); the built-in `bash` is replaced through a same-name `registerTool`; testable logic lives in pure modules separate from Pi glue; the key is rebindable and captured only while a movable tool is running; guard against Claude Code's known failure modes (section 15).

Interpretation made here: "tool" means the `bash` tool in v1. Pi has no way to detach an arbitrary in-flight tool call, and only process-backed work can outlive its tool call safely. Generalizing is deferred (issue #5). Platform: POSIX (Linux, macOS) only in v1; on Windows the extension stays inactive and says why.

Terms.
- **Task**: one command run by pi-bg, with an id (`bg1`, `bg2`, ...), a lifecycle state and an output log.
- **Foreground / background**: a foreground task is held by an open `bash` tool call, which blocks the agent. A background task has no open tool call; the agent turn continues.
- **Handoff**: the transition of a running foreground task to background. The `bash` tool call returns a normal result ("moved to background as bg3") while the process keeps running. Three reasons: `requested` (R2), `bg_timeout` (R6), `user` (R1).
- **Movable**: a foreground task that can still be handed off (running, not yet terminal).
- **Hard timeout**: the existing `bash` `timeout` parameter. It kills the command. It is distinct from `bg_timeout`, which never kills.
- **Steer / follow-up**: Pi's two queues for user messages submitted while the agent is working. A steer is delivered to the model after the current batch of tool calls finishes; a follow-up after the agent would otherwise stop.
- **Notification**: a message pi-bg injects into the conversation to tell the model a task ended. **Ack** means evidence that the model has seen it.

## 2. Evidence status

Every claim below that rests on Pi behavior carries one of four marks. Executed means observed against Pi 1.4.0 in a prototype run (the spikes S1 to S8, removed from the tree after their findings were folded in here; they remain in git history, and the gated live tests under `test/gated` re-check the main ones). Verified means read in Pi 1.4.0 source (by a research pass for this design), not executed. Reported means taken from a clone's code, a README or Node documentation, not from Pi source. Unverified means inferred or not read. Each unverified or reported item the design depends on had a spike with a pass criterion in the former planning notes (git history), and the fallbacks are listed after the table. No surveyed extension was executed either.

| Item | Status | Basis | Regression test |
|---|---|---|---|
| A same-name `registerTool({name:"bash"})` replaces the built-in; on a name clash between extensions the first loaded wins and the loser gets a load error naming the conflict (`Tool "bash" conflicts with <owner>`); `pi.getAllTools()` reports the winner in `sourceInfo.path` (a file path, `<inline:name>` for an inline factory, `builtin:bash` for the built-in), in both load orders | executed | `ExtensionRunner.getAllRegisteredTools`; both orders probed | `test/pi/lifecycle.test.ts` (owner check) |
| A replacing tool inherits the built-in call/result renderers if it supplies none | verified | `withBuiltInRenderers` | none |
| `execute` may return while the child process keeps running; Pi does not kill or complain; the tool promise is awaited, never abandoned, so an uncooperative tool also blocks Esc | executed | `executePreparedToolCall`, `AgentSession.abort`; after abort the detached group kept running | `test/gated/handoff` |
| The tool-call `signal` is the agent-run abort (Esc); a queued steer does not abort it | verified | agent loop | none |
| Steers are consumed only between turns, after the whole tool batch; Esc clears all queues and restores the text to the editor, but only in interactive mode (`restoreQueuedMessagesToEditor` clears the queues, then aborts); `session.abort()` alone, and so SDK, RPC and print runs, leave queued steers in place | executed | `getSteeringMessages`, `restoreQueuedMessagesToEditor`; steer-then-Esc was emulated with `clearQueue()` then `abort()`, the TUI itself was driven only for the notification case below | `test/gated/wait`, `test/gated/notify` |
| The `input` event fires when the user submits text while a tool runs, before queuing, carrying `streamingBehavior` `steer` or `followUp`; returning `continue` queues normally | executed | `AgentSession.prompt`, `_runInputHandlers`; also `tool_execution_start` fires before `execute()` runs, so a test must wait for `execute` to begin before treating a wait as registered | `test/gated/wait` |
| `ctx.hasPendingMessages()` is true when any steer or follow-up is queued, including messages pi-bg itself queued; it is a function on the tool context (false before a steer, true right after `steer()` returns) | executed | `AgentSession` | `test/gated/wait` |
| `registerShortcut("ctrl+b")` overrides `tui.editor.cursorLeft` (not in the reserved list), with a conflict warning; the handler cannot pass the key through, so cursor-left would be lost for the whole session | verified | `ExtensionRunner.getShortcuts`, `CustomEditor.handleInput` | none |
| `ctx.ui.onTerminalInput` runs before the editor and extension shortcuts, can consume per key, and returns an unsubscribe; it fires while a tool runs with the editor focused (typed characters still reach the editor), so the `registerShortcut` fallback is unused; `ctx.ui.getEditorText()` returns the live text mid-tool | executed | `TUI.addInputListener`; real TUI in tmux | `test/gated/key` |
| Users can rebind keys in `keybindings.json`; an extension can match a key id with `matchesKey`. Custom action ids in `keybindings.json` are accepted without warning but not resolved: `getKeybindings().getKeys(id)` is empty and `/hotkeys` omits them (the raw value is readable only through the undocumented `getUserBindings()`), so `key` is a `pi-bg.json` entry | executed | `KeybindingsManager`; ctrl+g from config worked, ctrl+b was then left alone | `test/gated/key` |
| The built-in bash `exec` rethrows non-abort errors thrown by a custom `BashOperations.exec` unchanged (the sentinel message must not be `aborted` or start with `timeout:`); it ignores `shellPath` when custom `operations` are given, so the runner resolves the shell itself, while `commandPrefix` is still applied by the tool before `exec` (the command arrives as `prefix\ncommand`) | executed | bash tool source and a real `AgentSession` | `test/gated/handoff` |
| The native tool turns an `exec` error `Error("timeout:<secs>")`, also when thrown from a custom `exec`, into its "Command timed out after N seconds" result, built from the error message rather than the option; it validates `timeout` before `exec` and passes it through unchanged | executed | bash tool source and a real `AgentSession` | `test/gated/handoff` |
| `createLocalBashOperations` does not expose the child pid (nor a spawn hook); it tracks the detached pid for cleanup on Pi's exit signals; abort is SIGKILL of the process group at once, so shell `trap` handlers never run | executed | `createLocalBashOperations`, `killProcessTree`; conformance run of native against own spawn | `test/adapters/runners.test.ts` |
| Pi's stdout and stderr arrive merged in `onData` as Buffers with no stream tag | executed | `BashOperations.exec` signature; conformance run | `test/adapters/runners.test.ts` |
| A notification sent with `sendMessage` while the agent streams or a tool runs goes through the steer queue and is delivered once, after the whole tool batch; Esc discards it (custom messages are not mirrored to the editor, so nothing is restored); `followUp` is discarded too; `deliverAs: "nextTurn"` survives Esc, is delivered with the next user prompt and does not wake an idle agent | executed | `sendCustomMessage`, `restoreQueuedMessagesToEditor`; real TUI in tmux with a scripted provider | `test/gated/notify` |
| `session_shutdown` async handlers are awaited before exit or before the next session starts, on every path (quit, reload, new, resume, Ctrl+C twice, Ctrl+D, SIGTERM, SIGHUP); Pi never kills an extension's detached tasks itself; `exit` does not fire on reload, new or resume (the process stays), so only this hook covers them; a synchronous `exit` handler also runs on quit and the signals | executed | real Pi in tmux, eight paths | `test/gated/shutdown` |
| `sendMessage` with `triggerTurn:true` while idle starts a turn; the ack is `message_end` with `message.role === "custom"` and the `customType`, once per delivery on every path, never seen when Esc discarded the steer | executed | `sendCustomMessage` | `test/gated/notify` |
| `os.tmpdir()` honors `TMPDIR` | reported | Node docs | covered by a W4 unit test |
| Task ids can be rebuilt from `ctx.sessionManager.getBranch()` on `session_start`: toolResult `details` of a resumed session file are readable | executed | `SessionManager.open`, `createAgentSession` resume | `test/pi/lifecycle.test.ts` |
| `agent_settled` carries `{aborted}` (true after Esc, also fires false on normal settling); `session_shutdown` and `session_start` carry a reason (quit, reload, new, resume, fork; Ctrl+C, Ctrl+D, SIGTERM and SIGHUP report `quit`). A captured `pi` after `/reload` throws "extension ctx is stale" (the notification is lost, detectably), so timers are cancelled on shutdown | executed | event types, `AgentSession`; real Pi | `test/gated/notify`, `test/gated/shutdown` |
| `ctx.mode` is `tui`, `rpc`, `json` or `print`; tool results may carry `structuredContent` | verified | `ExtensionContext`, `AgentToolResult` types | none |
| `ctx.isProjectTrusted` is a function on the `session_start` context; it follows the host's `projectTrusted` flag, and the SDK default when no flag is passed is trusted, so a host building a session through the SDK passes an explicit value | executed | richardgill code; SDK probe | `test/pi/config-load.test.ts` (guards with `typeof`, absence is untrusted) |
| `settings.json` preserves unknown top-level keys across Pi's own save, once `settingsManager.flush()` has run (writes are queued) | executed | SDK probe | none (Q5 option B stays a decision, not a blocker) |

Fallbacks the spikes would have triggered (no spike failed; kept as the reasons the design is shaped this way):
- S1 (wait wake-up): if `hasPendingMessages` is missing from the tool context, `confirmQueued` returns `undefined` and the wait releases at the 50 ms settle point without confirmation (the same rule as section 8.2); if the `input` event does not fire mid-tool, fall back to polling `hasPendingMessages()` every 100 ms and accept spurious early returns caused by pi-bg's own notifications (the `bg_wait` result says `user_message` only when no task ended).
- S2 (handoff): resolve `exec` with exit 0 and replace the result (section 4.1); if the `timeout:<secs>` error is not mapped, the tool throws its own error with the native text from `format`.
- S3 (spawn parity): keep the Pi-ops adapter as the default and give up split streams, pid and graceful stop (Q2 option B).
- S4 (key): if listeners do not run mid-tool, register `registerShortcut` on a non-conflicting key (`ctrl+shift+b`, as patty does) and document it; R1 then is met on terminals that deliver that key only.
- S5 (ack): no ack. Treat `sent` as final, keep the single `nextTurn` redelivery on `agent_settled` with `aborted`, and rely on `bg_status` showing `notified: false`.
- S6 (shutdown): if `session_shutdown` is not awaited, rely on the synchronous `exit` backstop (SIGKILL of the groups) and drop graceful stop on shutdown.
- S8 (API probes): branch scan unavailable: seed ids at 1 and rely on the per-session log directory so stale ids cannot alias; `isProjectTrusted` absent: project config is ignored; `settings.json` drops unknown keys: use only the own file (Q5 option A).
- S7 (ownership): if the owner cannot be detected, skip the warning; `bash` still works through whichever extension won, and the `bg_*` tools answer "inactive" (section 13).

## 3. Architecture

Two layers with one dependency direction: Pi glue depends on the pure core; the core depends on nothing but TypeScript and ports (interfaces) it declares.

The pure core (`src/core`) holds all logic worth testing:
- `task`: the task state machine, a pure reducer from (task, event) to task. The task record is data only: live handles (process, log writer, tail buffer, timers) are held by glue in a per-task runtime record next to the registry, not in it. A task that starts with `run_in_background` is created already in state `background` with handoff reason `requested`. States: `foreground`, `background`, `exited`, `killed`, `timed_out`, `spawn_failed`. The last four are terminal and absorbing (no event leaves them; a late event is recorded as ignored). A handoff event on a terminal task is a no-op, which settles the race between ctrl+b and a natural exit.
- `registry`: the collection of tasks, id allocation, queries (`running`, `movable`), subscriptions.
- `tail`: incremental line splitter, bounded ring buffer of recent lines, ANSI and carriage-return normalization for display, grep.
- `timeout-policy`: from a task spec, computes the handoff deadline and the kill deadline; resolves the effective `bg_timeout` from the precedence chain.
- `notify-policy`: decides what to notify, coalesces completions, tracks per-task notification status (`none`, `pending`, `sent`, `acked`, `suppressed`), implements the once-only latch and the single redelivery after a detected loss.
- `wait`: the wait coordinator. Pure in that its inputs are events (task terminal, user message seen, timeout, abort) delivered by the glue, and time comes from an injected clock.
- `config`: validation and merge of config sources into a `BgConfig`, with warnings.
- `format`: all model-facing and user-facing text, including every failure message, the footer and `/bg` output. (Tool parameter schemas live next to it in `src/tools`, because they need TypeBox; they are not part of the dependency-free core.)

Ports (declared in `src/contract.ts`, implemented outside the core): `Clock`, `ProcessRunner`, `LogStore`, `NotificationSink`, `UiSink`. The runner port hides how a process is spawned (section 4).

Pi glue (`src/pi`) is thin and holds no policy: tool registration (`bash`, `bg_status`, `bg_output`, `bg_wait`, `bg_kill`), the move-key listener, the `input` and lifecycle event handlers, the footer status and `/bg` command, the notification message renderer, config file loading, and the composition root that wires ports to adapters. Adapters (`src/adapters`) implement ports against Node (`child_process`, `fs`) or Pi's `BashOperations`. Tool results use snake_case on the wire (as in section 5) and camelCase internally; one mapping module in the glue owns the conversion.

This follows the repo conduct (testable logic in pure modules, higher-level facilities built from lower-level primitives, one canonical behavior model with platform realizations behind ports). The seam placement mirrors pi-bg-bash's split modules; no surveyed extension ports the process behind an interface, which is what makes the fake runner possible.

## 4. Execution model and handoff

### 4.1 Decision

Foreground commands run through Pi's own built-in bash tool definition (`createBashToolDefinition`) constructed per call with a custom `BashOperations` whose `exec` delegates to the `ProcessRunner` port. A handoff is done by the operation rejecting with a unique sentinel error after the runner has been re-attached to pi-bg's own control; the replacing `bash` tool catches it and returns a normal "moved to background" result. Commands with `run_in_background:true` skip the built-in tool and start the runner directly with an immediate result.

This is the pringled technique (wrap `BashOperations.exec`), chosen over racing the native `execute()` (pi-async-bash) because the wrapper sees every output chunk from the start and can tee it into the task log; the race approach only has native snapshots after handoff, so R5 would have no real log. pi-bg-bash resolves `exec` with a fake exit code and rewrites the result text afterward; a rejection is simpler because the native tool then emits no misleading exit-code text, but see the risk below.

Departures from pringled, each small: the sentinel is detected by a side table keyed on tool call id, not by error identity, so a native tool that re-wraps the error still works; the handoff is also reachable from `run_in_background` and from the timer, uniformly; and everything the handoff needs (timers, log, ring buffer, notification status) lives in the registry and the per-task runtime record rather than closures.

Risk and fallback: the native tool rethrows the sentinel unchanged (section 2), so no fallback is needed; the exit-0 variant (resolve `exec` with exit code 0, then replace the result in the replacing tool's `execute`, pi-bg-bash's pattern) was also run and works, and both are hidden behind one function in `bash-tool`.

### 4.2 Process runner adapters

`ProcessRunner.start(spec, sink)` returns `{pid?, exited: Promise<ExitInfo>, kill(mode)}` and advertises capabilities `{pid, splitStreams, gracefulTerm}`. Two adapters:

- Pi-ops adapter: wraps `createLocalBashOperations`. Reuses Pi's shell resolution, environment, detached spawn, process-tree kill and its tracked-pid cleanup on Pi's exit signals. Limits: no pid, merged streams, kill is SIGKILL of the tree with no grace period.
- Own-spawn adapter: `child_process.spawn` detached into its own process group, stdout and stderr piped separately, SIGTERM with a grace period then SIGKILL to the group. Gives the pid, split streams (R5 wording "stdout/stderr"), graceful stop, and the pid needed by the orphan reaper (section 12). Cost: it duplicates Pi's shell setup (shell path, command prefix, environment).

Recommendation: own-spawn as the default, with the Pi-ops adapter as fallback, selected after a conformance run of both runners against the built-in (quoting, env, prefix, cwd, exit and signal codes, 10 MB output, closed stdin, group kill, timeout and abort text, `TMPDIR`; the native runner lacks only pid and split streams) and by the coordinator decision Q2 (former planning notes, git history). The rest of the design is written against the capabilities, not the adapter: `bg_output` accepts a `stream` parameter and answers `combined` always, `stdout`/`stderr` only when the runner can split.

## 5. Tool surface

Five tools. `bash` is the replaced built-in with three new parameters; four new tools carry the `bg_` prefix. Schemas are TypeBox (provided by Pi). One tool per verb with small schemas is preferred over one multiplexed tool (patty's `jobs`) because each schema is shorter to read and models misuse union parameters less; the cost is five tool entries in the prompt. Alternative rejected: a separate `bg_start` (pringled `bg_run`); `bash` with `run_in_background` already is the start verb and matches Claude Code, and a duplicate start path would need its own clash and guideline handling. Reopen if S7 shows `bash` is routinely owned by another extension (then a standalone start tool is the only way to offer R2). Ownership is detected at `session_start` with `pi.getAllTools()` and the tool's source info, as pringled does (S7).

Ids are `bg<N>` per session, monotonic, never reused; on `session_start` the counter is reseeded above any id seen in earlier tool results on the branch (pringled's scheme) so a resumed transcript's `bg3` cannot collide.

### 5.1 `bash`

Parameters:
- `command: string`
- `timeout?: number` seconds. Hard kill, measured from start across the foreground and background phases. Absent means no limit (same as the built-in).
- `bg_timeout?: number` seconds the call may run in the foreground before handoff. `0` disables automatic handoff for this call. Absent means the session default.
- `run_in_background?: boolean` start as a background task at once. Default false.
- `notify?: "off" | "error" | "done"` notification level for this task. Absent means the config default.
- `description?: string` short label shown in lists; stored as `TaskSpec.label`.

If `timeout` is less than or equal to the effective `bg_timeout`, handoff can never happen and the command is simply killed at `timeout`, exactly as the built-in does; the native timeout text applies. The tool description states that `bg_timeout` should be smaller than `timeout`.

Results:
- Completed in the foreground: the native result, unchanged (truncation, full-output file, exit-code text, renderers all native).
- Handed off: a non-error result. Content text (template in `format`): "Still running after 30s (bg_timeout), so it was moved to the background as bg3. It was not killed. You will be notified when it ends (notify=done). Last 20 lines: ... Log: <path>. Use bg_wait, bg_output or bg_kill with id bg3. Note: changes the command makes to its working directory do not carry over." The reason line varies: "You asked for background execution" (`requested`), "The user moved it to the background with ctrl+b" (`user`). `details` stays compatible with the native bash details type and adds `pi_bg: {task_id, reason, log_path, pid?}`. `structuredContent` carries `{task_id, state: "background", reason, runtime_s, output_tail, log_path, log_degraded}`.
- Spawn failure or a limit hit: an error result (section 13).

### 5.2 `bg_status`

Parameters: `id?: string` (absent lists all tasks); `tail_lines?: number` (default 10 for one task, 0 for the list); `include_finished?: boolean` (default false: only running tasks are listed; finished tasks stay available by id for the whole session); `limit?: number` (default 10 tasks per page); `offset?: number` (default 0). A list shows running tasks first, then finished ones, most recently started first within each group. The text ends with a note on the page (`Showing 1-10 of 23. Use offset 10 for the next page.`) and on hidden finished tasks.

Result (structured): `{tasks: TaskSummary[], total?, next_offset?, hidden_finished?}` (the last three on list calls only; `next_offset` is absent on the last page) where `tasks` is `TaskSummary[]` and `TaskSummary = {id, label, command (cut at 200 chars), state, started_at (ISO), runtime_s, exit_code?, signal?, pid?, total_bytes, notify, notified (boolean), log_path, log_degraded (boolean), last_lines?: string[]}`. Text is a compact table for a list, a block with the tail for one id. Calling it on a terminal task counts as the agent having seen the result and latches its notification (section 9).

### 5.3 `bg_output`

Parameters: `id: string`; `tail_lines?: number` (default 50); `since?: number` byte cursor from a previous call (returns only new output, bounded); `grep?: string` JavaScript regular expression applied per line; `context?: number` lines around each grep hit; `max_bytes?: number` (default 16000); `stream?: "combined" | "stdout" | "stderr"` (default combined).

Result: `{id, state, exit_code?, output, returned_bytes, total_bytes, next_cursor, truncated, stream, log_path, log_degraded}`. With `since`, `next_cursor` lets the agent poll incrementally without re-reading (pi-bg-bash's byte-offset reads); a half-written final line is withheld until complete or the task ends. Display text is ANSI-stripped with carriage-return progress lines collapsed; the log keeps raw bytes. An invalid regular expression is an error naming the parse error. Reading a terminal task latches its notification.

### 5.4 `bg_wait`

Parameters: `ids?: string[]` (default all running background tasks); `mode?: "any" | "all"` (default `any`: return when any listed task ends); `timeout_s?: number` (default 120, maximum 3600, from config; the default is two minutes so a forgotten wait returns control to the model soon, and the one-hour maximum is an arbitrary bound, tunable).

Result: `{reason, waited_s, tasks: TaskSummary[]}` with `reason` one of `finished` (the mode condition met), `timeout`, `user_message` (a steer or follow-up was submitted, see section 8), `aborted` (Esc), `no_tasks` (nothing to wait on). Finished tasks include a tail of 10 lines. Tasks the wait reports as finished are latched: the glue calls `NotificationPolicy.markAgentSaw` for each (no later notification for them). The same call is made by `bg_status`, `bg_output` and `bg_kill` when they report a terminal task.

### 5.5 `bg_kill`

Parameters: `id?: string`, `all?: boolean` (exactly one required). Kills the process group: SIGTERM, then SIGKILL after `kill.termGraceMs` (3 s) if it is still alive; with a runner that cannot send SIGTERM (Pi-ops adapter) it is SIGKILL at once. The runner owns the escalation timer.

Result: `{killed: id[], already_finished: id[], failed: {id, error}[]}`. A killed task enters `killed` and its notification is suppressed (the agent caused it and sees the result here). Kills with cause `bg_kill`, `command` (the `/bg kill` command) or `shutdown` suppress notifications; `turn_abort` (Esc on a foreground task) never reaches the notification policy because the task is not in the background.

### 5.6 Prompt guidance

The `bash` tool's `promptGuidelines` tell the model to background anything that may run long or near its timeout (so the output stays in a log, not the context), to never sleep or poll (a task-end notification wakes it, or it calls `bg_wait`), and to manage tasks by id with `bg_status`, `bg_output`, `bg_kill` and `bg_wait`. The guidance is a string constant in `format` so it can be tuned in one place.

## 6. Configuration

Precedence, highest first: per-call parameter; `/bg timeout <s>` and `/bg notify <level>` session overrides (in memory only, never persisted); CLI flags `--bg-timeout`, `--bg-notify`, `--no-bg`; project file `.pi/pi-bg.json`, honored only when the project is trusted (`ctx.isProjectTrusted`, when present); global file `pi-bg.json` in Pi's agent directory (`getAgentDir()`); built-in defaults. The file/flag split is the pattern of the surveyed clones (richardgill's own-file config, pringled's settings keys); Pi documents no convention. An own file avoids depending on whether `settings.json` preserves unknown keys (unverified). Location is a coordinator decision (Q5).

Keys and defaults:

| Key | Default | Meaning |
|---|---|---|
| `bgTimeoutSeconds` | 30 | R6 session default; 0 disables automatic handoff |
| `notify.default` | `done` | `off`, `error` (non-zero exit, kill by timeout, spawn failure), `done` (every end except a kill caused by `bg_kill`, `/bg kill` or shutdown) |
| `notify.delivery` | `steer` | `steer`, `followUp`, `nextTurn` |
| `notify.wake` | true | start a turn when the agent is idle |
| `notify.batchMs` | 500 | coalescing window; long enough to merge tasks that finish together, short enough to be unnoticed |
| `key` | `ctrl+b` | move-to-background key id (section 7); normalised at load (case, `-` as separator), an invalid id warns and falls back to the default |
| `hintAfterMs` | 2000 | delay before the hint line shows |
| `wait.defaultTimeoutSeconds` / `wait.maxTimeoutSeconds` | 120 / 3600 | |
| `output.tailLines` / `output.maxBytes` | 50 / 16000 | `bg_output` defaults |
| `output.ringBytes` | 65536 | in-memory recent output per task |
| `output.maxLogBytes` | 268435456 | per-task log cap; see section 10 |
| `output.logRetentionDays` | 7 | log directory garbage collection |
| `output.logDir` | null | null means the session directory under `os.tmpdir()`; otherwise an absolute path (a relative path is rejected with a warning and the default is used, because it would depend on where Pi was started) |
| `enabled` | true | false (set by `--no-bg`) makes pi-bg's `bash` a pass-through to the native tool and the `bg_*` tools answer inactive |
| `maxRunningTasks` | 16 | concurrent background tasks; a safety bound against runaway loops, not a tuned value |
| `kill.termGraceMs` | 3000 | SIGTERM to SIGKILL delay |

The 30 s default is the top of the requested 20 to 30 s band, chosen because it matches the closest prior art (richardgill) and keeps ordinary builds foreground; the coordinator can change it (Q6). Invalid config is never fatal: each bad key is reported once with its path and the default used (section 13).

## 7. ctrl+b: handling and defense

### 7.1 Behavior

Pi already binds `ctrl+b` to editor cursor-left. pi-bg registers one `ctx.ui.onTerminalInput` listener at `session_start` (TUI mode only). For each key the listener asks the registry whether any foreground task is movable. If none, it returns nothing and the key flows to the editor, so cursor-left is intact whenever no tool is running. If at least one is movable and the key matches the configured key id, it hands off every movable task and returns `{consume: true}`. Parallel tool calls (Pi's default) are all moved, because the user sees one blocked screen, not individual calls.

The key is captured from the moment a foreground task starts, not from when the hint appears. The hint line appears after `hintAfterMs` (2 s) to avoid flicker for fast commands. It is drawn in the `bash` tool call itself, on the line beneath Pi's "Elapsed" timer (`renderResult` wrapper in `src/pi/bash-render.ts`), and disappears when the call ends or moves. It reads `moves to background in 28s (ctrl+b to background now)`, counting down once a second to the earliest automatic handoff, or just `ctrl+b to background now` when no handoff is planned. Under tmux or herdr (`TMUX` or `HERDR_ENV` set) the default key shows as `ctrl+b ctrl+b`, because the first press is taken as the multiplexer prefix. This differs from pringled, which captures only once the hint shows, so a press in the first seconds moves the cursor instead; users who press ctrl+b expect it to work, and a fast command that has already ended no longer counts as movable anyway. The trade: while a tool runs, a user editing steering text loses ctrl+b as cursor-left. Reopen trigger: complaints, or S4 finding an editor-text accessor, in which case pass the key through when the editor is non-empty.

The configured key id is matched with Pi's `matchesKey`, which never matches an unrecognised id, so config loading normalises the value (`src/pi/key-id.ts`: modifiers `ctrl`, `shift`, `alt`, `super`, case-insensitive, `+` or `-` after a modifier) and on failure warns and uses the default; the hint shows the key in effect. The key grammar is a small copy of pi-tui's, typed against its `KeyId`, and can drift. Rebinding is the `key` config entry; custom ids in `keybindings.json` are not resolved by Pi (section 2), so reading them is not offered. A later optional read of the raw `getUserBindings()["pi-bg.move"]` when `key` is unset is possible but rests on an undocumented path; reopen if Pi documents extension keybinding ids.

In tmux, the default prefix is also `ctrl+b`; the user presses it twice to deliver one to Pi (Claude Code documents the same). Documented; the `key` option exists for people who prefer another binding.

In print, json and rpc modes there is no terminal listener and no key; R2 and R6 work regardless.

### 7.2 Alternatives rejected

- `registerShortcut("ctrl+b", ...)`. Verified to override cursor-left, but the registration is global and static, and its handler cannot decline the key (`CustomEditor.handleInput` swallows the key whenever a shortcut matches). The user's locked requirement (captured only while a movable tool runs) cannot be met. Reopen if Pi adds a conditional or pass-through shortcut.
- `ctrl+shift+b` (patty, pi-bg-bash, aliou `pi-processes` example). Pi-safe, but needs the kitty keyboard protocol or modifyOtherKeys, which many terminals and tmux do not deliver; and it is not the key the user asked for.
- Any typed input backgrounds the running command (patty). It steals the user's message: typing a steering instruction would move the task, abort the turn and re-queue the text. Rejected outright.
- A slash command only (`/bg move`). Cannot be typed mid-tool without the same steer-queue problem. Kept as a secondary affordance (`/bg move` is cheap to add through the same code path) but not the primary.

### 7.3 Unverified and how it is closed

Closed: `onTerminalInput` listeners and the editor receive keys while a tool executes (executed in tmux; evidence table in section 2). Two spike observations remain as limits: `/reload` (duplicate registration, unsubscribe) and terminals other than xterm-256color under tmux were not run, and inside tmux the default prefix ctrl+b swallows a single press, so tmux users press it twice (the README says so).

## 8. Interruptible wait (R3)

### 8.1 The problem

Pi delivers a steer only after the whole current batch of tool calls ends (verified), and awaits a tool's promise indefinitely. So a naive `bg_wait` that blocks until a task ends would ignore the user's new instruction until it returns. The two prior-art waits end only on Esc, which discards the queued steer instead (verified: Esc clears the queues and restores the text to the editor), or poll in short slices that burn turns.

### 8.2 Decision

`bg_wait` returns early when a user message is submitted. The mechanism combines two verified signals, neither of which consumes or alters the message:

1. A global `input` event handler records that a user message with `streamingBehavior` `steer` or `followUp` was submitted while a wait is active, and returns `{action: "continue"}` so Pi queues it normally.
2. The wait coordinator releases the wait a fixed `queueSettleMs` (50 ms) after that signal, at the first check where `ctx.hasPendingMessages()` is not false, and in any case after 250 ms. A wait is never released by `hasPendingMessages()` alone.

The delay is not decoration. Pi awaits `input` handlers before it queues the message. If the wait resolved inside the handler, the tool batch could finish and the loop could poll the steer queue before the message is queued; the user's message would then be delivered one turn late. A macrotask delay is enough to let the queueing (which runs right after the handler returns) finish; the `hasPendingMessages()` check is only a sanity check, since it can already be true because of a notification pi-bg queued itself. If a listed task ends and a user message arrives at the same instant, `finished` wins (the model receives the result either way, and the user's message is delivered right after). The wait result says `user_message`, tells the model that the user's message follows, and lists the task states. The model reads the steer on its very next step.

Both steers and follow-ups end a wait. A follow-up is not urgent, but the agent would otherwise sit in the wait up to its timeout while the user thinks it is working; ending the wait lets the follow-up be delivered promptly. `hasPendingMessages()` cannot tell the two apart, and the cost of a spurious early return is one extra model step.

Other wake conditions, in the same coordinator: a listed task ends (`finished`), the timeout (`timeout`), and the tool `signal` aborting (`aborted`; background tasks are left running). Esc therefore still works, and kills nothing.

Interaction with notifications: a task being waited on is latched when the wait returns, so no separate notification follows; tasks not in the wait notify normally and may arrive as steers after the batch.

### 8.3 Alternatives rejected

- Wait ends only on abort (pi-wake-jobs, patty `attach`). Meets none of R3: the user must Esc, which throws their steer away.
- No wait tool; rely on the model ending its turn and being woken by the notification (Claude Code's approach). Works for pure "tell me when done", and it is still the recommended pattern in the prompt guidance. It does not meet R3, which asks for the agent to stay in its loop and still yield to the user.
- Short poll slices (pi-unified-exec `yield_until`). Each slice is a model step; it costs tokens and latency, and the model may stop polling.
- Patch Pi for a first-class "abort this tool when a steer is queued". Out of scope for an extension; this is the preferred long-term fix. Reopen trigger: Pi exposes a queue event to extensions (`queue_update` currently reaches only session subscribers) or aborts tool signals on steer.
- `hasPendingMessages()` polling alone, with no `input` handler. Simpler and free of the queueing race, but it also counts messages pi-bg itself queues (notifications for other tasks), which would end waits spuriously. The `input` event is the discriminator for user messages.

### 8.4 Status

Executed (spike S1, now `test/gated/wait`): with a real Pi session and a scripted provider, a steer at random times during a `bg_wait` released it in 50 to 60 ms (the 50 ms settle; the 250 ms cap was never reached because `hasPendingMessages()` was already true), the message was delivered exactly once and never dropped in 100 consecutive trials per seed, a follow-up behaved the same (delivered after the agent would have stopped), and plain abort released the wait as `aborted` in about 1 ms. A negative control that released synchronously inside the `input` handler showed no late delivery in 1.4.0: queueing completes before the tool batch ends by microtask ordering, so the settle is cheap insurance (50 ms latency) against an implementation detail, not something the test proves necessary. It is kept.

## 9. Notifications (R4)

### 9.1 When and how

When a task reaches a terminal state, the notification policy checks the task's level (`off`, `error`, `done`) against the outcome and, if due, queues it. Completions arriving within `batchMs` are coalesced into one message (one turn, not N). Delivery is `pi.sendMessage` with custom type `pi-bg:task`, `display: true`, and options `{deliverAs: <config delivery, default "steer">, triggerTurn: <wake>}`. Verified behavior of `sendMessage`: while the agent is streaming it goes through the steer queue and arrives after the current tool batch; while idle with `triggerTurn: true` it starts a turn (the Claude Code behavior). The text is one short block per task: id, label, outcome (exit code or signal, runtime), the last 10 lines, the log path, and the hint to use `bg_output`. A message renderer shows it compactly in the TUI.

Default level `done` follows Claude Code (it always notifies) and the majority of the survey; `error` and `off` serve the "optional" in R4. The default, and steer versus follow-up, are a user-visible choice for the coordinator (Q3).

### 9.2 Once-only and loss handling (the Claude Code "stale reminder" failure)

Claude Code's repeated stale "new output available" reminders came from re-arming reminders without a terminal state. Here:

- Each task has a notification status that only moves forward: `none`, `pending`, `sent`, `acked`, or `suppressed`. A task is notified at most once; no periodic "still running" reminder exists in v1, by design.
- The status becomes `suppressed` without sending when the agent already knows the outcome: a `bg_wait`, `bg_status`, `bg_output` or `bg_kill` result covered the terminal state, or `notify` was `off`.
- `sent` is not the same as seen. Esc clears queued steers and follow-ups (executed, section 2), and a notification queued as a steer is among them. pi-bg therefore also tracks `acked`: the custom `message_end` for the message (`role` custom, `customType` `pi-bg:task`, matched to tasks by the ids in `details`), which fires once per delivery on every path and coincides with the message being in the transcript. If `agent_settled` reports `aborted` while a message is `sent` and not `acked`, the policy returns the task to `pending` exactly once and redelivers with `deliverAs: "nextTurn"` (it survives Esc and is delivered with the user's next prompt; `steer` and `followUp` would be discarded again, and an immediate send at idle would start a turn right after the user's Esc). A second loss is not retried; `bg_status` still shows the task as finished with `notified: false`, so the model can discover it by querying. The ack proves transcript inclusion, not attention; the `before_provider_request` event was not testable without a real provider.
- Compaction can drop an acked notification from context. No re-send; the model can query `bg_status`, which keeps finished tasks for the whole session.

pi-bg-bash and pi-wake-jobs both ship re-arm/hold logic for this problem, evidence it is real; their bookkeeping is global tables keyed by symbols across extensions. pi-bg keeps it inside `notify-policy` with a single observable status field and tests it as a state machine.

## 10. Output storage (R5)

Each task writes its raw combined output (and, with a splitting runner, separate stdout and stderr files) to a log. Location: `output.logDir` or, by default, `<os.tmpdir()>/pi-bg-<uid>/<sessionId>/<taskId>.log`. `os.tmpdir()` honors `TMPDIR` (Claude Code's #15700 failure was a hardcoded `/tmp/claude`); no path is hardcoded and a unit test sets `TMPDIR`. Directories are 0700 and files 0600 (pi-bg-bash; logs may contain secrets). Log paths are put in every result so the user and the model can open them with `read`; nothing is hidden state.

In memory, each task keeps a bounded ring of recent output (`output.ringBytes`) for cheap tails, notification excerpts. Deep reads (`since`, grep, large tails) go to the file by byte offset through the `LogStore` port.

Caps: `output.maxLogBytes` stops writing to the log (a marker line is appended) and the ring keeps updating; the task is not killed. Claude Code kills at 5 GB; killing is destructive and the user did not ask for it, while a runaway producer cannot fill the disk because writing stops. Reopen if a runaway still hurts (CPU or pipe backpressure). A log write failure (disk full, permissions) switches the task to ring-only, marks it `log_degraded`, and is surfaced in the next result.

Retention: logs of finished tasks outlive the session (users inspect them after quitting). `session_start` deletes session directories older than `output.logRetentionDays` and not owned by a live Pi process (an `owner.pid` file, pi-bg-bash's scheme). Only directories that contain an `owner.pid` holding a pid are candidates, so unrelated directories in a shared `output.logDir` are never deleted; a directory without that file is left alone. Memory per task is bounded by the ring; the number of tracked tasks is bounded by `maxRunningTasks` for running ones and by session length for finished (summaries only).

## 11. bg_timeout (R6)

On handoff-eligible foreground tasks, the timeout policy computes `deadline = start + bg_timeout` and the kill deadline `start + timeout`. At the first, the registry dispatches `HANDOFF(bg_timeout)`; the bash tool returns the handed-off result. The command is not touched. The replacing `bash` does not forward `timeout` to the native tool or to the runner. In the foreground, when it fires, the wrapped `exec` kills the process and throws the same `timeout:<seconds>` error the local operations throw, so the native tool's "Command timed out after N seconds" text and rendering apply unchanged. The hard `timeout` is enforced by pi-bg's own clock so the foreground and background phases share one clock; the alternative, passing it to the runner, would need a second timer for the background phase and two code paths for the same kill. When it fires the task enters `timed_out` and notification level `error` applies.

The effective `bg_timeout` precedence is in section 6. `0` means never hand off automatically. `bg_timeout` greater than or equal to `timeout` simply disables handoff for the call. A command is not exempt by name (Claude Code excludes commands starting with `sleep`); the prompt guidance and `bg_wait` cover that case, and pattern exemptions are brittle.

Scope: this is the closest requirement to richardgill (30 s, per-call, background-or-kill) and famulus (20 s); neither has a key, wait or notification to combine, which is why the combination is built here.

## 12. Lifecycle and cleanup

Start: the extension factory registers all five tools (a registration cannot be added conditionally later). `session_start` reseeds ids, runs log GC, checks bash ownership (below), installs the move-key listener and creates the UI. Per call: create task, start runner, wire timers and sinks.

Exit paths: `session_shutdown` fires for every reason (quit, reload, new, resume, fork); pi-bg kills all running tasks on all of them (locked decision; the cost is that `/reload` kills background work, noted in `/bg` help). The handler is idempotent, cancels timers, signals the process groups, waits up to 5 s (bounded) for exits, closes log files, unsubscribes the input listener and clears the status. A `process.on("exit")` backstop synchronously SIGKILLs any still-registered groups, for exit paths that skip the event.

Esc: aborting a turn while a task is foreground kills it (native semantics); once handed off, Esc never kills it (Claude Code same). 

Orphans (Claude Code #102511, #102009, #106483): with the Pi-ops adapter, Pi's tracked-pid cleanup on exit signals covers quit and SIGINT/SIGTERM; nothing covers SIGKILL or a crash of Pi, nor grandchildren outside the process group. With own-spawn the child leads its own process group, so the group-wide signal reaches grandchildren that stay in it. Residual risk (Pi killed by SIGKILL) is addressed by an optional reaper: a tiny detached POSIX shell watcher per task that polls `kill -0 <pi pid>` and, when Pi is gone and the group still has members, sends SIGKILL to the group (pi-bg-bash's design, up to 1 s lag). It needs the group id, so it exists only with the own-spawn adapter. It is executed: with a 0.2 s poll the group was gone 216 to 221 ms after a SIGKILL of Pi (eight runs), and the watcher exited by itself in every run (`test/adapters/reaper.test.ts`). Pid reuse is guarded by remembering groups already seen empty, never signalling them again.

Jobs left behind by a finished task (#18): a command such as `sleep 300 &` exits its shell, so the task is `exited` (unchanged), but the job stays in the task's process group. pi-bg does not kill it at task exit (users start servers that way on purpose); it is cleaned up when the session ends. Two pieces: (1) the reaper is not unwatched at task exit; its watcher exits by itself when the group is empty, so Pi crashing or being SIGKILLed still reaps the leftover job; (2) the shutdown hard kill, which also runs from the exit backstop, SIGKILLs the group of every task in the runtime table, not only running ones. The own-spawn handle stays responsible for the pgid guard: after the leader exits it polls the group every 0.5 s (unref'd) and marks it gone once empty, and a gone group is never signalled, so a recycled id is not hit at shutdown hours later. Alternatives rejected: killing leftovers at task exit (breaks the intended `&` use); a registry list of lingering pgids (new shared state, and the handle already owns the group's liveness). Leftover jobs get SIGKILL without a SIGTERM grace, and are not listed in `bg_status`; both are follow-ups.

A process group alone does not cover daemons that `setsid` away; documented as a known limit shared by all surveyed extensions. A job started with `&` stays in the group and is covered (above).

Resumed or reloaded sessions: ids in the transcript refer to dead tasks; `bg_status` on such an id answers with the cause and action (section 13). Persistence across resume is deferred (issue #2).

## 13. Failure messages

Every failure message names the cause and the action, reaches the model (tool error or result text) and the operator (`ctx.ui.notify` through `UiSink.notify` in TUI and RPC; in print and json modes `UiSink.notify` writes to stderr). Each class has a test.

| Class | Message (summary) |
|---|---|
| Unknown id | `No task bg9 in this session. Known: bg1, bg2. Use bg_status with no id to list.` |
| Id from an earlier run | `bg3 was started before this session was resumed or reloaded and was stopped when Pi exited. Start the command again.` |
| Kill on a finished task | Not an error: listed in `already_finished` with its final state. |
| Wait with nothing to wait on | `reason: no_tasks`; text says no background task is running. |
| Wait timed out | `reason: timeout`; lists states; says to call bg_wait again or bg_status. |
| Spawn failure (bad cwd, missing shell) | Error result: the system error, the cwd and shell used; action: fix cwd or command. |
| Task limit | `16 background tasks are running (limit maxRunningTasks). Kill one with bg_kill or wait for one to finish.` |
| Kill failed (EPERM, still alive after SIGKILL) | `failed: [{id, error}]`; text: process group could not be signalled; give pid for manual `kill`. |
| Log write failure | Result flagged `log_degraded`; text says output is available only from the in-memory tail (last N KiB); action: free disk space or set `output.logDir`. |
| Invalid grep | Error with the regex parse error; action: fix the pattern. |
| Invalid config | Warning once per key with the file and key; defaults used. |
| Unreadable config file or invalid JSON | Warning naming the file and the read or parse error; the whole file is ignored and the defaults are used; action: fix the file and reload. |
| Log cleanup failure | Warning naming the log directory and the operation; no logs are deleted this session; retried at the next session start. |
| Bash owned by another extension | Startup warning naming the owner: `bash is registered by <ext>, which took precedence; pi-bg cannot add run_in_background or ctrl+b. Remove the other bash override to use pi-bg.` Because the first registration wins silently, pi-bg's `bash` is then never called; the four `bg_*` tools stay registered and answer `pi-bg is inactive: bash is owned by <ext>; there are no background tasks.` |
| Unsupported platform | `pi-bg is inactive on Windows in v1; the built-in bash is unchanged.` |

## 14. UI

TUI mode only (guarded by `ctx.mode === "tui"` and `ctx.hasUI`; in RPC the status string is forwarded and nothing else is relied on):
- Footer status `k shells` while any background task runs.
- `/bg` with subcommands: no argument lists tasks; `/bg kill <id|all>`; `/bg tail <id>`; `/bg timeout <s>` and `/bg notify <level>` (session overrides); `/bg move` (hand off all movable tasks). Completions come from the registry.
- A message renderer for `pi-bg:task` notifications.

Design choices here follow pringled and pi-bg-bash (footer count); they are routine and kept minimal.

## 15. Claude Code comparison and failure-mode guards

| Aspect | Claude Code | pi-bg |
|---|---|---|
| Move running command | Ctrl+B (tmux: twice) | Same key, rebindable, captured only while a movable tool runs |
| Start in background | `run_in_background` on Bash | Same on `bash` |
| Auto-background | foreground timeout 120 s, fixed by env, not killed | `bg_timeout`, default 30 s, per call and per session |
| Hard limit | none interactive; 30 min unattended | `timeout`, none by default |
| Read output | file path, read with Read tool; TaskOutput removed in 2.1.277 | `bg_output` (tail, cursor, grep) and the same log path readable with `read` |
| Wait | none; guidance is end the turn and be notified | `bg_wait`, interruptible by user messages; ending the turn still works |
| Notification | XML reminder, wakes idle session | custom message, wakes idle session, once-only with loss recovery |
| Stop | TaskStop | `bg_kill`, `/bg kill` |
| Task view | `/tasks` | `/bg`, footer |
| Size cap | kills above 5 GB | stops logging at the cap, keeps task |
| Lifetime | killed at exit; detached children killed on Linux/macOS | killed at every session shutdown; group kill; optional reaper |
| Monitor (stream lines to model) | `Monitor` tool | not in v1 (deferred) |

Failure modes of Claude Code and the guard (evidence: the issue numbers in the research notes; not independently re-verified):

| Failure | Guard |
|---|---|
| Stale reminders re-firing, loops (#7479, #11716, #12302, #14968) | one-way notification status, no periodic reminders, single redelivery on proven loss (section 9) |
| Output dir ignores TMPDIR, hardcoded `/tmp/claude` (#15700) | `os.tmpdir()`, config override, unit test with `TMPDIR` set |
| Orphaned processes: survive SIGTERM or host crash (#102511, #102009, #106483) | process-group signalling, kill at every shutdown path (including jobs left by finished tasks), exit backstop, optional reaper |
| A self-backgrounding command reported complete instantly (#93126) | exit is that of the process we spawned and its group leader; documented limit for double-forking daemons |
| Uninterruptible blocking wait (#83817) | `bg_wait` returns on user message and Esc, never deaf (section 8) |
| Raw output dumped into context (#76335) | bounded, normalized tails; `max_bytes`; cursors |
| Notification says done while a sub-task still runs (#92952) | notification only on the task's own terminal state; no nested tasks in v1 |
| ctrl+b clashing with tmux or readline (#5376 and others) | key rebindable; tmux double-press documented |

## 16. Testing strategy

Principle: policy lives in pure modules, tested with a fake clock and fake ports whose results are scripted and whose calls are observable; Pi glue is tested against a recorder fake of the extension API; a small number of gated tests use real processes and a real Pi.

- Unit (vitest, as most surveyed clones): `task` reducer including property tests (terminal states absorb, handoff on a terminal task is a no-op, ordering of exit versus handoff gives one consistent outcome); `tail` (split across chunk boundaries, CR progress, ANSI, ring eviction, grep with context); `timeout-policy` (precedence, 0, `bg_timeout >= timeout`); `notify-policy` (levels versus outcomes, batching window, suppression by agent knowledge, loss and single redelivery, once-only under repeated terminal events); `wait` (each of the five release reasons, race of simultaneous finish and user message, abort, `all` versus `any`); `config` (every key valid and invalid, precedence); `format` (golden strings per failure class; a negative control that a wrong state yields no message).
- Adapter tests with real processes in a per-test `mkdtemp` under `os.tmpdir()`: group kill reaches a grandchild, SIGTERM then SIGKILL timing, large output, CR progress, `TMPDIR` honored, spawn errors (bad cwd), log write failure by an unwritable directory. Parity test between the two runner adapters on a shared conformance list (S3).
- Glue tests against `FakePi` (records registered tools, handlers and shortcuts; scripts `input`, `session_*` events and terminal keys; captures `sendMessage` calls and UI calls): handoff via the sentinel path, ctrl+b consumed only while movable and passed through otherwise, `input` ends a wait with the race-free confirmation scripted both ways, notification options per mode, shutdown kills all.
- Contract-drift tests: each tool result type is checked with `satisfies` against its schema's static type; a round trip from producer (`format`/glue) through the schema validator; exhaustiveness over the task state and notification status unions; a composition-root parity test (owned by W8) that the registered tool names equal the keys of the schema table and of the result-mapper table; a negative control with a stub that returns a wrong shape and must fail the parity test.
- Live (gated by env var, run one at a time): the S1 to S6 spikes became regression tests where feasible (scripted tmux pty for ctrl+b; SDK session for wait and notification), owned by workstream W10 (former planning notes, git history). Timer-dependent tests use the fake clock, so repeating a flaky test 20 times is a check, not a hope.
- Environment limits are findings: a missing tmux or Pi SDK skips the gated test with the reason; it is never faked.

## 17. Decision log with reopen triggers

| Decision | Reopen when |
|---|---|
| bash-only v1 | a second process-less tool needs backgrounding, or Pi exposes tool detach |
| Wrap exec with sentinel (fallback: resolve exec with exit 0) | S2 shows native tool rewrites or swallows the error |
| Own-spawn runner default | S3 shows shell setup cannot be reproduced; or a Pi API exposes pid and signals |
| `onTerminalInput`, not `registerShortcut` | Pi adds pass-through shortcuts |
| Capture key from task start | complaints of lost cursor-left, or an editor-text accessor exists |
| Wait ends on any user message | users report spurious early returns, or Pi exposes the queue kind |
| Notification `steer` + wake, default `done` | users prefer less interruption; Q3 outcome |
| Once-only status and one redelivery | S5 shows a cheaper reliable ack |
| No log kill at cap | a runaway producer harms the host |
| Hard `timeout` on pi-bg's clock | Pi exposes a per-call timer API, or the double clock causes a divergence bug |
| Kill on every session shutdown | persistence work is tracked in issue #2 |
| Reaper only with own-spawn | Pi exposes pid or process-group control |
| POSIX only | a Windows user base appears |

Deferred (tracked in [GitHub issues](https://github.com/jszaday/pi-bg/issues)): persistence across resume and reload (#2); generic tool backgrounding (#5); stdin writes to a task (#6); a Monitor-style line-streaming tool (#7); Windows (#8); a standalone `bg_start` fallback (#9); signal choice on `bg_kill` (#10); richer task panel (#15).
