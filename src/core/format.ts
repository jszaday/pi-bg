// Text templates for every message pi-bg shows to the model or the user (DESIGN sections 5, 13, 14).
// Pure: strings in, strings out. Imports only ../contract (core import rule, TODO section 0).
// Failure texts always name the cause and the action.

import type {
  HandoffReason,
  NotificationBatch,
  NotifyLevel,
  StreamName,
  Task,
  TaskId,
  TaskState,
  TaskSummary,
  WaitReason,
} from "../contract.js";

export const BASH_GUIDELINES: string[] = [
  "Background anything that may run long or near its timeout (builds, tests, servers, installs) so it keeps running while you continue and its output stays in a log, not your context. Use run_in_background true, or bg_timeout below timeout to hand off automatically.",
  "You are notified when a task ends, so never sleep or poll. If you're only waiting on a task, end your turn (the notification wakes you) or call bg_wait.",
  "Check, read, stop and wait for tasks by id (e.g. bg3) with bg_status, bg_output, bg_kill and bg_wait.",
];

export interface OutputResult {
  id: TaskId;
  state: TaskState;
  exitCode?: number | null;
  output: string;
  returnedBytes: number;
  totalBytes: number;
  nextCursor: number;
  truncated: boolean;
  stream: StreamName;
  logPath?: string;
}

export interface KillResult {
  killed: TaskId[];
  alreadyFinished: TaskId[];
  failed: { id: TaskId; error: string }[];
}

export type FailureCode =
  | "unknown_id"
  | "stale_id"
  | "spawn_failed"
  | "task_limit"
  | "kill_failed"
  | "log_degraded"
  | "bad_grep"
  | "bad_override"
  | "bash_owned"
  | "inactive"
  | "unsupported_platform"
  | "wait_none"
  | "wait_timeout"
  | "kill_args"
  | "kill_signal_unsupported"
  | "write_no_stdin"
  | "write_finished"
  | "write_too_large"
  | "write_failed"
  | "stream_unsupported"
  | "notify_failed"
  | "listener_failed"
  | "handoff_missing"
  | "shutdown_timeout"
  | "disabled"
  | "bash_inactive"
  | "kill_no_handle"
  | "kill_not_exited"
  | "config_unreadable"
  | "config_bad_json"
  | "log_cleanup_failed";

/** Label shown above a redelivered notification in the collapsed renderer. */
export const REDELIVERY_LABEL = "(sent again)";

const MAX_HANDOFF_TAIL_LINES = 20;
const UNKNOWN = "unknown";

// Placeholder lookup. A missing value renders as "unknown" so a formatter never throws.
function v(ctx: Record<string, string | number>, key: string): string {
  const value = ctx[key];
  return value === undefined ? UNKNOWN : String(value);
}

function formatRuntime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 3) + "...";
}

function exitText(t: TaskSummary): string {
  if (t.state === "background" || t.state === "foreground") return "running";
  if (t.state === "spawn_failed") return "failed to start";
  if (t.state === "killed") return "killed";
  if (t.state === "timed_out") return "timed out (hard timeout)";
  if (t.exitCode !== undefined && t.exitCode !== null) return `exited with code ${t.exitCode}`;
  if (t.signal) return `exited on signal ${t.signal}`;
  return "exited";
}

function notifyText(level: NotifyLevel): string {
  return level;
}

export function handoffText(t: Task, tail: string[], reason: HandoffReason): string {
  const seconds = Math.round(((t.handoffAt ?? t.startedAt) - t.startedAt) / 1000);
  const lead =
    reason === "bg_timeout"
      ? `Still running after ${seconds}s (bg_timeout), so it was moved to the background as ${t.id}.`
      : reason === "requested"
        ? `You asked for background execution, so ${t.id} is running in the background.`
        : `The user moved it to the background with ctrl+b, so ${t.id} is running in the background.`;
  const notice =
    t.spec.notify === "off"
      ? "Notifications are off for it; check with bg_status or bg_wait."
      : `You will be notified when it ends (notify=${notifyText(t.spec.notify)}).`;
  const shown = tail.slice(-MAX_HANDOFF_TAIL_LINES);
  const tailBlock = shown.length > 0 ? `Last ${shown.length} lines:\n${shown.join("\n")}` : "No output yet.";
  const log = t.logPath ? `Log: ${t.logPath}.` : "";
  return [
    `${lead} It was not killed. ${notice}`,
    tailBlock,
    log,
    `Use bg_wait, bg_output or bg_kill with id ${t.id}. Note: changes the command makes to its working directory do not carry over.`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Key label to show: under tmux or herdr the first ctrl+b is taken as the multiplexer prefix, so it is pressed twice. */
export function keyLabel(key: string, inMultiplexer: boolean): string {
  return inMultiplexer && key.toLowerCase() === "ctrl+b" ? "ctrl+b ctrl+b" : key;
}

/** Hint line for a movable foreground command; `countdownS` is the time left until the automatic handoff, when one is planned. */
export function moveHintText(key: string, countdownS?: number): string {
  const now = `${key} to background now`;
  return countdownS === undefined ? now : `moves to background in ${formatRuntime(Math.max(0, countdownS))} (${now})`;
}

/** True when tmux or herdr is the host terminal (their env markers are set). */
export function inMultiplexer(env: Record<string, string | undefined>): boolean {
  return Boolean(env.TMUX || env.HERDR_ENV);
}

export function footerText(running: number): string | undefined {
  return running > 0 ? `${running} ${running === 1 ? "shell" : "shells"}` : undefined;
}

export function bgCommandText(
  sub: "help" | "list" | "tail" | "kill" | "timeout" | "notify" | "move",
  ctx: Record<string, string | number>,
): string {
  switch (sub) {
    case "help":
      return [
        "/bg lists background tasks.",
        "/bg tail <id> shows the last lines of a task.",
        "/bg kill <id|all> stops a task or all running tasks.",
        "/bg timeout <seconds> sets the automatic handoff time for this session (not saved).",
        "/bg notify <off|error|done> sets the notification level for this session (not saved).",
        "/bg move moves the running foreground commands to the background.",
      ].join("\n");
    case "list": {
      const count = Number(ctx.count ?? 0);
      return count === 0
        ? "No background tasks in this session."
        : `${count} background task(s) in this session. Use /bg tail <id> for output, or bg_status for details.`;
    }
    case "tail":
      return `Showing the end of ${v(ctx, "id")}. Use bg_output with id ${v(ctx, "id")} to read more.`;
    case "kill": {
      const count = Number(ctx.count ?? 0);
      return count === 0
        ? "No running background task to kill. Use /bg to list tasks."
        : `Killed ${count} background task(s).`;
    }
    case "timeout": {
      const seconds = Number(ctx.seconds ?? 0);
      return seconds === 0
        ? "Automatic handoff is off for new commands in this session (not saved)."
        : `Commands now move to the background after ${seconds}s in this session (not saved).`;
    }
    case "notify":
      return `Notification level for new tasks is now ${v(ctx, "level")} in this session (not saved).`;
    case "move": {
      const count = Number(ctx.count ?? 0);
      return count === 0
        ? "No foreground command to move to the background."
        : `Moved ${count} command(s) to the background.`;
    }
  }
}

/** Paging facts of a bg_status list call: `total` tasks match the filter; `hiddenFinished` finished tasks were filtered out. */
export interface StatusPage {
  total: number;
  offset: number;
  hiddenFinished: number;
}

function pageNote(shown: number, page: StatusPage): string {
  const notes: string[] = [];
  if (page.total > 0 && (page.offset > 0 || shown < page.total)) {
    const end = page.offset + shown;
    notes.push(`Showing ${page.offset + 1}-${end} of ${page.total}.${end < page.total ? ` Use offset ${end} for the next page.` : ""}`);
  }
  if (page.hiddenFinished > 0) notes.push(`${page.hiddenFinished} finished task(s) hidden; pass include_finished true to list them.`);
  return notes.join(" ");
}

export function summaryText(list: TaskSummary[], detailTail?: string[], page?: StatusPage): string {
  if (list.length === 0) {
    const none = page && page.total > 0 ? `No tasks at offset ${page.offset}.` : page && page.hiddenFinished > 0 ? "No background task is running." : "No background tasks in this session. Start one with bash and run_in_background true.";
    const note = page ? pageNote(0, page) : "";
    return note ? `${none} ${note}` : none;
  }
  if (list.length === 1 && detailTail !== undefined) {
    const t = list[0];
    const head = [
      `${t.id}${t.label ? ` (${t.label})` : ""}: ${exitText(t)}, runtime ${formatRuntime(t.runtimeS)}, ${t.totalBytes} bytes.`,
      `Command: ${t.command}`,
      `Notification: ${t.notify}, ${t.notified ? "already reported" : "not yet reported"}.`,
    ];
    if (t.pid !== undefined) head.push(`pid ${t.pid}.`);
    if (t.logPath) head.push(`Log: ${t.logPath}.`);
    if (t.logDegraded) head.push("Log writing failed; the output below is the in-memory tail only.");
    const body = detailTail.length > 0 ? detailTail.join("\n") : "No output yet.";
    return `${head.join("\n")}\n${body}`;
  }
  const rows = [["id", "state", "runtime", "exit", "notify", "label or command"]];
  for (const t of list) {
    rows.push([
      t.id,
      t.state,
      formatRuntime(t.runtimeS),
      t.exitCode !== undefined && t.exitCode !== null ? String(t.exitCode) : t.signal ? t.signal : "-",
      t.notify,
      truncate(t.label ?? t.command, 60),
    ]);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const table = rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join("  ").trimEnd()).join("\n");
  const note = page ? pageNote(list.length, page) : "";
  return note ? `${table}\n${note}` : table;
}

export function outputText(r: OutputResult): string {
  const exit = r.exitCode !== undefined && r.exitCode !== null ? `, exit code ${r.exitCode}` : "";
  const head = `${r.id} ${r.state}${exit}. Stream ${r.stream}: returned ${r.returnedBytes} of ${r.totalBytes} bytes, next cursor ${r.nextCursor}.`;
  const body = r.output.length > 0 ? r.output : "(no output in this range)";
  const notes: string[] = [];
  if (r.truncated) notes.push(`Output was cut at max_bytes. Call bg_output with since ${r.nextCursor} for the rest.`);
  if (r.logPath) notes.push(`Log: ${r.logPath}.`);
  return [head, body, ...notes].join("\n");
}

const NO_TASKS_TEXT =
  "No background task is running, so there was nothing to wait for. Action: start a command with run_in_background, or use bg_status to see finished tasks.";
const TIMEOUT_TEXT = (s: number): string =>
  `The wait timed out after ${s}s with tasks still running. Action: call bg_wait again, or use bg_status to check progress.`;
const WAIT_TEXT: Record<Exclude<WaitReason, "finished" | "user_message">, (waitedS: number) => string> = {
  timeout: TIMEOUT_TEXT,
  aborted: (s) => `The wait was cancelled after ${s}s. Background tasks keep running.`,
  no_tasks: () => NO_TASKS_TEXT,
};

export function waitText(r: { reason: WaitReason; waitedS: number; tasks: TaskSummary[] }): string {
  let head: string;
  if (r.reason === "finished") {
    head = `The wait finished after ${r.waitedS}s: a task you were waiting for has ended.`;
  } else if (r.reason === "user_message") {
    head = `The wait ended after ${r.waitedS}s because the user sent a message. Read the user's message first; the tasks below are still listed.`;
  } else {
    head = WAIT_TEXT[r.reason](r.waitedS);
  }
  const lines = r.tasks.map((t) => {
    const tail = t.lastLines && t.lastLines.length > 0 ? "\n" + t.lastLines.map((l) => `    ${l}`).join("\n") : "";
    return `- ${t.id}${t.label ? ` (${t.label})` : ""}: ${exitText(t)}, runtime ${formatRuntime(t.runtimeS)}${tail}`;
  });
  return [head, ...lines].join("\n");
}

export function writeText(r: { id: TaskId; bytes: number; eof: boolean }): string {
  return `Wrote ${r.bytes} bytes to the stdin of ${r.id}.${r.eof ? " Closed stdin (end of input)." : ""}`;
}

export function killText(r: KillResult): string {
  const lines: string[] = [];
  if (r.killed.length > 0) lines.push(`Killed: ${r.killed.join(", ")}.`);
  if (r.alreadyFinished.length > 0) {
    lines.push(`Already finished, nothing to kill: ${r.alreadyFinished.join(", ")}.`);
  }
  for (const f of r.failed) {
    lines.push(
      `Could not stop ${f.id}: ${f.error}. The process group could not be signalled. Action: kill its pid manually, or check with bg_status whether it is still running.`,
    );
  }
  return lines.length > 0 ? lines.join("\n") : "No task was killed.";
}

function outcomeText(t: TaskSummary): string {
  if (t.state === "background" || t.state === "foreground") return "is still running";
  if (t.state === "killed") return "was killed";
  return exitText(t);
}

export function notificationText(b: NotificationBatch): string {
  const head = b.redelivery
    ? "Background task notification (sent again because the previous delivery was interrupted):"
    : "Background task notification:";
  const blocks = b.items.map((item) => {
    const t = item.task;
    const name = t.label ? `${t.id} (${t.label})` : t.id;
    const line = `${name} ${outcomeText(t)} after ${formatRuntime(t.runtimeS)}.`;
    const tail = item.tail.length > 0 ? item.tail.map((l) => `    ${l}`).join("\n") : "    (no output)";
    const log = t.logPath ? `Log: ${t.logPath}. ` : "";
    return `${line}\n${tail}\n${log}Use bg_output with id ${t.id} for more.`;
  });
  return [head, ...blocks].join("\n");
}

export function failure(code: FailureCode, ctx: Record<string, string | number>): string {
  switch (code) {
    case "unknown_id":
      return `No task ${v(ctx, "id")} in this session. Known: ${v(ctx, "known")}. Action: use bg_status with no id to list the tasks, then retry with a listed id.`;
    case "stale_id":
      return `${v(ctx, "id")} was started before this session was resumed or reloaded and was stopped when Pi exited. Action: start the command again.`;
    case "spawn_failed":
      return `Could not start the command in ${v(ctx, "cwd")} using ${v(ctx, "shell")}: ${v(ctx, "error")}. Action: check that the working directory exists and the shell is installed, then run the command again.`;
    case "task_limit":
      return `${v(ctx, "limit")} background tasks are running (limit maxRunningTasks). Action: kill one with bg_kill or wait for one to finish with bg_wait.`;
    case "kill_failed":
      // pid is omitted when unknown: "kill pid unknown" would be no action at all
      return `Could not stop ${v(ctx, "id")}: the process group could not be signalled (${v(ctx, "error")}). Action: ${ctx.pid === undefined ? "check whether it is still running with bg_status, then stop it manually" : `kill pid ${v(ctx, "pid")} manually, or check whether it is still running with bg_status`}.`;
    case "log_degraded":
      return `Writing the log for ${v(ctx, "id")} failed: ${v(ctx, "error")}. Only the in-memory tail (last ${v(ctx, "kib")} KiB) is complete. Action: free disk space, or set output.logDir in pi-bg.json, then start the command again.`;
    case "bad_grep":
      return `Invalid grep pattern ${v(ctx, "pattern")}: ${v(ctx, "error")}. Action: fix the regular expression (JavaScript syntax) and call bg_output again.`;
    case "bad_override": {
      const value = `'${v(ctx, "value")}'`;
      return v(ctx, "key") === "timeout"
        ? `${value} is not a valid timeout (a number of seconds, 0 disables). Action: run /bg timeout with a number of seconds, for example /bg timeout 30.`
        : `${value} is not a valid notify level (off, error, done). Action: run /bg notify with off, error, or done.`;
    }
    case "bash_owned":
      return `bash is registered by ${v(ctx, "owner")}, which took precedence; pi-bg cannot add run_in_background or ctrl+b. Action: remove the other bash override to use pi-bg.`;
    case "inactive":
      return `pi-bg is inactive: ${v(ctx, "reason")}. There are no background tasks. Action: ${v(ctx, "action")}.`;
    case "unsupported_platform":
      return `pi-bg is inactive on ${v(ctx, "platform")} in v1; the built-in bash is unchanged. Action: use Linux or macOS, or remove pi-bg from your Pi packages.`;
    case "wait_none":
      return NO_TASKS_TEXT;
    case "wait_timeout":
      return TIMEOUT_TEXT(Number(ctx.seconds ?? 0));
    case "kill_args":
      return Number(ctx.both) === 1
        ? "Give either id or all to bg_kill, not both. Action: call bg_kill with only id (one task) or only all true (every running task)."
        : "bg_kill needs exactly one of id or all. Action: call bg_kill with id set to a task id such as bg3, or with all true.";
    case "kill_signal_unsupported":
      return `bg_kill cannot send SIG${v(ctx, "signal")} because the fallback runner (Pi's native operations) can only abort a task with SIGKILL. Action: call bg_kill with signal KILL or without signal, or restore the own-spawn runner (a startup warning says why it is not in use).`;
    case "write_no_stdin":
      return `${v(ctx, "id")} was not started with stdin, so it cannot take input. Action: start the command again with bash stdin true, then write with bg_write.`;
    case "write_finished":
      return `${v(ctx, "id")} has already ended (${v(ctx, "state")}), so it cannot take input. Action: use bg_output to read what it printed, or start the command again.`;
    case "write_too_large":
      return `The write is ${v(ctx, "bytes")} bytes, over the ${v(ctx, "limit")}-byte limit for one bg_write call. Action: split the data into several bg_write calls.`;
    case "write_failed":
      return `Could not write to the stdin of ${v(ctx, "id")}: ${v(ctx, "error")}. Action: read the output with bg_output to see why, and start the command again with stdin true if it still needs input.`;
    case "stream_unsupported":
      return `Stream ${v(ctx, "stream")} was requested, but this runner only provides combined output, so combined output is returned. Action: omit stream or use combined.`;
    case "notify_failed":
      return `pi-bg could not deliver a notification (${v(ctx, "error")}). Action: use bg_status to see finished tasks, or reload Pi.`;
    case "listener_failed":
      return `A pi-bg task listener failed while ${v(ctx, "id")} was ending: ${v(ctx, "error")}. Action: report this as a pi-bg bug.`;
    case "handoff_missing":
      return `The handed-off task ${v(ctx, "id")} is missing from the registry. Action: report this as a pi-bg bug.`;
    case "shutdown_timeout":
      return `Some background tasks did not exit within ${v(ctx, "seconds")} s of shutdown and were sent SIGKILL${ctx.pid === undefined ? "" : ` (pid ${v(ctx, "pid")})`}. Action: check for leftover processes with ps, and kill them manually if they remain.`;
    case "disabled": {
      // `foreground` = 1 when the call is bash (which could also run without the pi-bg parameters).
      const extra = Number(ctx.foreground) === 1 ? ", or run the command without run_in_background, bg_timeout and notify" : "";
      return failure("inactive", {
        reason: "pi-bg is disabled (--no-bg flag or enabled=false in pi-bg.json)",
        action: `remove --no-bg or set enabled to true in pi-bg.json, then reload${extra}`,
      });
    }
    case "bash_inactive":
      return failure("inactive", { reason: `bash is owned by ${v(ctx, "owner")}`, action: "remove the other bash override, then reload Pi" });
    case "kill_no_handle":
      return failure("kill_failed", { ...ctx, error: "the task has no live process handle yet" });
    case "kill_not_exited":
      // graceful = 0: the runner sent SIGKILL at once (no SIGTERM stage), so naming SIGTERM would be wrong
      return failure("kill_failed", { ...ctx, error: `still running ${v(ctx, "seconds")}s after ${Number(ctx.graceful) === 0 || ctx.signal === "SIGKILL" ? "SIGKILL" : `${ctx.signal ?? "SIGTERM"} and the runner's SIGKILL escalation`}` });
    case "config_unreadable":
      return `Cannot read the ${v(ctx, "label")} config ${v(ctx, "file")}: ${v(ctx, "error")}. pi-bg ignores this file and uses the default settings. Action: fix the file's permissions or path, then reload Pi.`;
    case "config_bad_json":
      return `${v(ctx, "file")} is not valid JSON: ${v(ctx, "error")}. pi-bg ignores this file and uses the default settings. Action: fix the syntax error in ${v(ctx, "file")} (a JSON validator shows where), then reload Pi.`;
    case "log_cleanup_failed":
      return `Log cleanup failed: ${v(ctx, "error")}. Old logs are not deleted this session. Action: make the log directory readable and writable (output.logDir, or pi-bg-<uid> under the system temp directory); cleanup runs again at the next session start.`;
  }
}
