import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { HandoffReason, NotifyLevel, StreamName, Task, TaskState, TaskSummary, WaitReason, WaitResult } from "../contract.js";
import { type KillResult, type StatusPage, type OutputResult, handoffText, killText, monitorStartText, monitorStopText, outputText, summaryText, waitText, writeText } from "../core/format.js";
import type { ToolName } from "../tools/schemas.js";

// camelCase internal -> snake_case wire (DESIGN section 5); text comes from src/core/format.ts only.

/** Wire shapes (DESIGN section 5). Optional fields are omitted, never undefined. */
export interface WireTaskSummary {
  id: string;
  label?: string;
  command: string;
  state: TaskState;
  started_at: string;
  runtime_s: number;
  exit_code?: number | null;
  signal?: string | null;
  pid?: number;
  total_bytes: number;
  notify: NotifyLevel;
  notified: boolean;
  log_path?: string;
  log_degraded: boolean;
  last_lines?: string[];
}
export interface WireStatus {
  tasks: WireTaskSummary[];
  /** Tasks matching the filter across all pages; present on list calls only. */
  total?: number;
  /** Offset for the next page; absent on the last page. */
  next_offset?: number;
  /** Finished tasks left out because include_finished was not true. */
  hidden_finished?: number;
}
export interface WireOutput {
  id: string;
  state: TaskState;
  exit_code?: number | null;
  output: string;
  returned_bytes: number;
  total_bytes: number;
  next_cursor: number;
  truncated: boolean;
  stream: StreamName;
  log_path?: string;
  log_degraded: boolean;
}
export interface WireWait {
  reason: WaitReason;
  waited_s: number;
  tasks: WireTaskSummary[];
}
export interface WireKill {
  killed: string[];
  already_finished: string[];
  failed: { id: string; error: string }[];
}
export interface WireWrite {
  id: string;
  written_bytes: number;
  eof: boolean;
}
export interface WireMonitor {
  id: string;
  monitoring: boolean;
  grep?: string;
  /** Present when a monitor was started. */
  max_notifications?: number;
  /** Present (true) when the call replaced an active monitor. */
  replaced?: boolean;
}
export interface WireHandoff {
  task_id: string;
  state: "background";
  reason: HandoffReason;
  runtime_s: number;
  output_tail: string[];
  log_path?: string;
  log_degraded: boolean;
}

type Result = AgentToolResult<Record<string, unknown>>;

function text(t: string): { type: "text"; text: string }[] {
  return [{ type: "text", text: t }];
}

// The wire value doubles as `details` and `structuredContent`.
function make(t: string, wire: object): Result {
  const json = JSON.parse(JSON.stringify(wire)) as Record<string, never>;
  return { content: text(t), details: json, structuredContent: json };
}

export function wireSummary(t: TaskSummary): WireTaskSummary {
  const w: WireTaskSummary = {
    id: t.id,
    command: t.command,
    state: t.state,
    started_at: t.startedAt,
    runtime_s: t.runtimeS,
    total_bytes: t.totalBytes,
    notify: t.notify,
    notified: t.notified,
    log_degraded: t.logDegraded,
  };
  if (t.label !== undefined) w.label = t.label;
  if (t.exitCode !== undefined) w.exit_code = t.exitCode;
  if (t.signal !== undefined) w.signal = t.signal;
  if (t.pid !== undefined) w.pid = t.pid;
  if (t.logPath !== undefined) w.log_path = t.logPath;
  if (t.lastLines !== undefined) w.last_lines = t.lastLines;
  return w;
}

/** Handed-off bash result: text from `handoffText`, `details` = `{...nativeDetails, pi_bg: {task_id, reason, log_path, pid?}}`, structuredContent per DESIGN 5.1. */
export function toBashHandoffResult(
  task: Task,
  tail: string[],
  reason: HandoffReason,
  nativeDetails?: Record<string, unknown>,
): AgentToolResult<Record<string, unknown>> {
  const piBg: Record<string, unknown> = { task_id: task.id, reason };
  if (task.logPath !== undefined) piBg.log_path = task.logPath;
  if (task.pid !== undefined) piBg.pid = task.pid;
  const wire: WireHandoff = {
    task_id: task.id,
    state: "background",
    reason,
    runtime_s: Math.round(((task.handoffAt ?? task.startedAt) - task.startedAt) / 1000),
    output_tail: tail,
    log_degraded: task.logDegraded,
  };
  if (task.logPath !== undefined) wire.log_path = task.logPath;
  const r = make(handoffText(task, tail, reason), wire);
  return { ...r, details: { ...nativeDetails, pi_bg: piBg } };
}

export function toStatusResult(tasks: TaskSummary[], detailTail?: string[], page?: StatusPage): AgentToolResult<Record<string, unknown>> {
  const wire: WireStatus = { tasks: tasks.map(wireSummary) };
  if (page) {
    wire.total = page.total;
    if (page.offset + tasks.length < page.total) wire.next_offset = page.offset + tasks.length;
    if (page.hiddenFinished > 0) wire.hidden_finished = page.hiddenFinished;
  }
  return make(summaryText(tasks, detailTail, page), wire);
}

/** `degradedNote`: optional extra text (format `failure("log_degraded")`) appended when the log is degraded. */
export function toOutputResult(
  r: OutputResult & { logDegraded: boolean },
  degradedNote?: string,
): AgentToolResult<Record<string, unknown>> {
  const wire: WireOutput = {
    id: r.id,
    state: r.state,
    output: r.output,
    returned_bytes: r.returnedBytes,
    total_bytes: r.totalBytes,
    next_cursor: r.nextCursor,
    truncated: r.truncated,
    stream: r.stream,
    log_degraded: r.logDegraded,
  };
  if (r.exitCode !== undefined) wire.exit_code = r.exitCode;
  if (r.logPath !== undefined) wire.log_path = r.logPath;
  const body = outputText(r);
  return make(degradedNote ? `${body}\n${degradedNote}` : body, wire);
}

export function toWaitResult(r: WaitResult, summaries: TaskSummary[]): AgentToolResult<Record<string, unknown>> {
  const waitedS = Math.round(r.waitedMs / 1000);
  const wire: WireWait = { reason: r.reason, waited_s: waitedS, tasks: summaries.map(wireSummary) };
  return make(waitText({ reason: r.reason, waitedS, tasks: summaries }), wire);
}

export function toKillResult(r: KillResult): AgentToolResult<Record<string, unknown>> {
  const wire: WireKill = {
    killed: r.killed,
    already_finished: r.alreadyFinished,
    failed: r.failed.map((f) => ({ id: f.id, error: f.error })),
  };
  return make(killText(r), wire);
}

export function toWriteResult(r: { id: string; bytes: number; eof: boolean }): AgentToolResult<Record<string, unknown>> {
  const wire: WireWrite = { id: r.id, written_bytes: r.bytes, eof: r.eof };
  return make(writeText(r), wire);
}

/** Started monitor (`monitoring` true) or a stop; `wasActive` says whether the stop found a monitor. */
export function toMonitorResult(r: { id: string; monitoring: true; grep?: string; maxNotifications: number; replaced: boolean } | { id: string; monitoring: false; wasActive: boolean }): AgentToolResult<Record<string, unknown>> {
  if (!r.monitoring) return make(monitorStopText({ id: r.id, wasActive: r.wasActive }), { id: r.id, monitoring: false } satisfies WireMonitor);
  const wire: WireMonitor = { id: r.id, monitoring: true, max_notifications: r.maxNotifications };
  if (r.grep !== undefined) wire.grep = r.grep;
  if (r.replaced) wire.replaced = true;
  return make(monitorStartText(r), wire);
}

/** One entry per tool name; the W8 parity test compares its keys with SCHEMAS and the registered tools. */
export const RESULT_MAPPERS: Record<ToolName, (...a: never[]) => unknown> = {
  bash: toBashHandoffResult,
  bg_status: toStatusResult,
  bg_output: toOutputResult,
  bg_wait: toWaitResult,
  bg_kill: toKillResult,
  bg_write: toWriteResult,
  bg_monitor: toMonitorResult,
};
