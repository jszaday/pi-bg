export type TaskId = string; // "bg<N>", N monotonic per session
export type TaskState = "foreground" | "background" | "exited" | "killed" | "timed_out" | "spawn_failed";
export type TerminalState = Exclude<TaskState, "foreground" | "background">;
export type HandoffReason = "requested" | "bg_timeout" | "user";
export type KillCause = "bg_kill" | "command" | "shutdown" | "turn_abort"; // bg_kill = the bg_kill tool, command = /bg kill, shutdown = session end, turn_abort = Esc while foreground
export type NotifyLevel = "off" | "error" | "done";
export type NotifyStatus = "none" | "pending" | "sent" | "acked" | "suppressed";
export type StreamName = "combined" | "stdout" | "stderr";

export interface TaskSpec {
  command: string;
  cwd: string;
  label?: string;
  hardTimeoutMs: number | null;   // bash `timeout`, ms from start, null = none
  bgTimeoutMs: number | null;     // effective bg_timeout, ms; null or 0 = never auto-handoff
  notify: NotifyLevel;
  startInBackground: boolean;     // newTask() then yields state "background", handoffReason "requested"
  stdin?: boolean;                // true: the program gets a writable stdin (bg_write); absent or false: stdin is closed (reads see EOF)
  toolCallId?: string;
}

export interface Task {
  id: TaskId;
  spec: TaskSpec;
  state: TaskState;
  startedAt: number;              // clock ms
  handoffAt?: number;
  handoffReason?: HandoffReason;
  endedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  killCause?: KillCause;          // set by kill_requested; the following exit makes state "killed"
  hardTimeoutFired?: boolean;     // set by hard_timeout; the following exit makes state "timed_out"
  pid?: number;
  logPath?: string;
  logDegraded: boolean;
  totalBytes: number;
  notifyStatus: NotifyStatus;
  notifyRedelivered: boolean;
  error?: string;                 // spawn_failed cause
}

export type TaskEvent =
  | { type: "handoff"; reason: HandoffReason; at: number }
  | { type: "output"; bytes: number; at: number }
  | { type: "pid"; pid: number }
  | { type: "log_path"; path: string }
  | { type: "kill_requested"; cause: KillCause; at: number }
  | { type: "hard_timeout"; at: number }
  | { type: "exit"; code: number | null; signal: string | null; at: number }
  | { type: "spawn_failed"; error: string; at: number }
  | { type: "log_degraded"; error: string }
  | { type: "notify_status"; status: NotifyStatus };

export interface TaskSummary {
  id: TaskId; label?: string; command: string /* cut at 200 chars */; state: TaskState;
  startedAt: string /* ISO */; runtimeS: number; exitCode?: number | null; signal?: string | null;
  pid?: number; totalBytes: number; notify: NotifyLevel; notified: boolean; logPath?: string;
  logDegraded: boolean; lastLines?: string[];
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(h: TimerHandle): void;
}
export type TimerHandle = unknown;

// ---- process port ----
export interface RunSpec { command: string; cwd: string; env?: Record<string, string>; stdin?: boolean; }
export interface ExitInfo { code: number | null; signal: string | null; }
export type OutputSink = (chunk: Uint8Array, stream: "stdout" | "stderr" | "combined") => void;
export interface RunnerCapabilities { pid: boolean; splitStreams: boolean; gracefulTerm: boolean; }
/** Signals a handle can send, lowercase; the bg_kill wire values are the uppercase forms. */
export type KillSignal = "int" | "hup" | "term" | "quit" | "usr1" | "usr2" | "kill";
export interface ProcessHandle {
  pid?: number;
  exited: Promise<ExitInfo>;            // never rejects; spawn failure resolves via startError
  /** Present only when the process was started with `RunSpec.stdin`. Writes `data`; `eof` then closes stdin. Returns `{ error }` (the cause) when stdin cannot take the write: already closed, or the program closed it. */
  writeStdin?(data: Uint8Array, eof: boolean): { error: string } | undefined;
  kill(signal: KillSignal): void;       // idempotent; sends the signal to the group and the RUNNER escalates to "kill" after its termGraceMs (except for "kill" itself); every signal acts as "kill" if !gracefulTerm
}
export interface ProcessRunner {
  readonly capabilities: RunnerCapabilities;
  start(spec: RunSpec, sink: OutputSink): ProcessHandle | { startError: string };
}

// ---- log port ----
export interface LogReadResult { bytes: Uint8Array; nextOffset: number; totalBytes: number; }
export interface LogWriter { write(chunk: Uint8Array, stream: StreamName): void; close(): Promise<void>; readonly path: string; readonly degraded: string | null; }
export interface LogStore {
  open(id: TaskId): LogWriter | { error: string };
  read(id: TaskId, stream: StreamName, offset: number, maxBytes: number): Promise<LogReadResult | { error: string }>;
  gc(olderThanMs: number): Promise<{ removed: string[] }>;
}

// ---- tail (src/core/tail.ts) ----
export interface TailBuffer {
  push(chunk: Uint8Array): void;
  lines(n: number): string[];           // last n complete lines, display-normalized
  partial(): string;                    // current unterminated line
  lastLine(): string | undefined;
  totalBytes(): number;
  totalLines(): number;                 // complete lines ever pushed (monotonic, counts evicted lines)
}

// ---- notification ----
export interface NotificationItem { task: TaskSummary; tail: string[]; }
export interface NotificationBatch { items: NotificationItem[]; redelivery: boolean; }
export interface NotificationSink {
  send(batch: NotificationBatch, opts: { deliverAs: "steer" | "followUp" | "nextTurn"; triggerTurn: boolean }): void;
}

// ---- wait ----
export type WaitReason = "finished" | "timeout" | "user_message" | "aborted" | "no_tasks";
export interface WaitRequest { ids?: TaskId[]; mode: "any" | "all"; timeoutMs: number; }
export interface WaitResult { reason: WaitReason; waitedMs: number; tasks: Task[]; }  // glue maps tasks to TaskSummary for the wire

// ---- ui port ----
export interface SessionOverrides { bgTimeoutSeconds?: number; notifyLevel?: NotifyLevel; }   // in memory, set by /bg timeout|notify
export interface UiSink {
  refresh(): void;
  notify(msg: string, level: "info" | "warning" | "error"): void;
  /** Highlights (or not) the footer "N shells" item while the shells panel focus is on it. */
  setFooterFocus(focused: boolean): void;
}

// ---- config ----
export interface BgConfig {
  enabled: boolean;               // false (--no-bg): bash passes through, bg_* tools answer inactive
  bgTimeoutSeconds: number;       // merged value of the config layers; per-call and session overrides are applied on top
  notify: { default: NotifyLevel; delivery: "steer" | "followUp" | "nextTurn"; wake: boolean; batchMs: number };
  key: string; hintAfterMs: number;
  wait: { defaultTimeoutSeconds: number; maxTimeoutSeconds: number };
  output: { tailLines: number; maxBytes: number; ringBytes: number; maxLogBytes: number; logRetentionDays: number; logDir: string | null };
  maxRunningTasks: number;
  kill: { termGraceMs: number };
  lifecycle: { keepOnReload: boolean };
}

// ---- monitor (src/core/monitor-policy.ts) ----
/** One monitor message: new output lines of a task. `stopped` names why the monitor ended with this message; absent while it keeps watching. */
export interface MonitorBatch {
  id: TaskId;
  lines: string[];
  /** Lines of this window that were not included (over the per-message line limit). */
  omitted: number;
  stopped?: "max_notifications" | "task_ended";
  maxNotifications: number;
}
export interface MonitorSink {
  send(batch: MonitorBatch, opts: { deliverAs: "steer" | "followUp" | "nextTurn"; triggerTurn: boolean }): void;
}
