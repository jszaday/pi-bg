// bg_status, bg_output, bg_wait, bg_kill (DESIGN sections 5.2 to 5.5, 8, 13).
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KillSignal, StreamName, Task, TaskId, TaskSummary } from "../contract.js";
import { failure } from "../core/format.js";
import { grepLines, normalizeForDisplay } from "../core/tail.js";
import { isTerminal } from "../core/task.js";
import { SCHEMAS, type BgKillArgs, type BgMonitorArgs, type BgOutputArgs, type BgStatusArgs, type BgWaitArgs, type BgWriteArgs } from "../tools/schemas.js";
import { killTasks } from "./kill.js";
import { toKillResult, toMonitorResult, toOutputResult, toStatusResult, toWaitResult, toWriteResult } from "./results.js";
import type { Services, TaskRuntime } from "./runtime.js";

const DEFAULT_STATUS_TAIL = 10;
const DEFAULT_STATUS_LIMIT = 10;
const DEFAULT_OUTPUT_TAIL = 50;
const WAIT_TAIL = 10;
const GREP_WINDOW_BYTES = 8 * 1024 * 1024;
const MIN_TAIL_WINDOW_BYTES = 64 * 1024;
const NL = 0x0a;
const DEFAULT_MAX_NOTIFICATIONS = 10;
/** Most bytes one bg_write call may send; keeps a single call from flooding a pipe the program may not be reading. Mirrored in the data description in tools/schemas.ts. */
export const MAX_WRITE_BYTES = 64 * 1024;

type Result = ReturnType<typeof toStatusResult>;

/** Failure path: the text reaches the operator (UiSink) and the model (thrown tool error). */
function fail(s: Services, text: string): never {
  s.ui.notify(text, "warning");
  throw new Error(text);
}

function guard(s: Services, ctx: ExtensionContext): void {
  s.ctx.current = ctx;
  const reason = s.inactiveReason?.();
  if (reason) fail(s, reason);
  if (!s.config().enabled) {
    fail(s, failure("disabled", {}));
  }
}

function lookup(s: Services, id: TaskId): Task {
  const t = s.registry.get(id);
  if (t) return t;
  const known = s.registry.list().map((x) => x.id).join(", ") || "none";
  return fail(s, failure(s.registry.isStale(id) ? "stale_id" : "unknown_id", { id, known }));
}

function sawTerminal(s: Services, tasks: Task[]): void {
  for (const t of tasks) if (isTerminal(t)) s.notify.markAgentSaw(t.id);
}

const decoder = new TextDecoder();

/** The task's runtime while its output ring is still held; undefined once evicted (the log answers then). */
function liveRuntime(s: Services, id: TaskId): TaskRuntime | undefined {
  const rt = s.runtime.get(id);
  return rt?.evicted ? undefined : rt;
}

/** Last `n` lines of a task: the in-memory ring while the task has live runtime, else the log; [] when neither has data. */
async function tailOf(s: Services, t: Task, n: number): Promise<string[]> {
  if (n <= 0) return [];
  const rt = liveRuntime(s, t.id);
  if (rt) {
    const lines = rt.tail.lines(n);
    const partial = isTerminal(t) ? rt.tail.partial() : "";
    return (partial ? [...lines, partial] : lines).slice(-n);
  }
  if (t.logPath === undefined || t.logDegraded) return [];
  const r = await s.logs.read(t.id, "combined", 0, 0);
  if ("error" in r) return [];
  const start = Math.max(0, r.totalBytes - MIN_TAIL_WINDOW_BYTES);
  const b = await s.logs.read(t.id, "combined", start, MIN_TAIL_WINDOW_BYTES);
  if ("error" in b) return [];
  let lines = normalizeForDisplay(decoder.decode(b.bytes)).split("\n");
  if (start > 0) lines = lines.slice(1);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n);
}

/** Tail lines for `/bg tail`: as `tailOf`, but an evicted task whose log cannot be read gets a one-line explanation instead of silently no lines. */
export async function commandTail(s: Services, t: Task, n: number): Promise<string[]> {
  const lines = await tailOf(s, t, n);
  if (lines.length > 0 || !s.runtime.get(t.id)?.evicted) return lines;
  const probe = t.logPath === undefined || t.logDegraded ? { error: true } : await s.logs.read(t.id, "combined", 0, 0);
  return "error" in probe ? [`(output of ${t.id} was released from memory and its log file is missing or unreadable. Action: check output.logDir, or rerun the command.)`] : lines;
}

async function summarize(s: Services, t: Task, tailLines: number | undefined): Promise<TaskSummary> {
  return s.registry.summarize(t, tailLines && tailLines > 0 ? await tailOf(s, t, tailLines) : undefined);
}

async function status(s: Services, p: BgStatusArgs, ctx: ExtensionContext): Promise<Result> {
  guard(s, ctx);
  if (p.id !== undefined) {
    const t = lookup(s, p.id);
    sawTerminal(s, [t]);
    const n = p.tail_lines ?? DEFAULT_STATUS_TAIL;
    const tail = await tailOf(s, t, n);
    return toStatusResult([s.registry.summarize(t, tail)], tail);
  }
  const all = s.registry.list();
  const listed = all.filter((t) => p.include_finished === true || !isTerminal(t));
  // Running tasks first, then finished ones; most recently started first within each group.
  listed.sort((a, b) => Number(isTerminal(a)) - Number(isTerminal(b)) || b.startedAt - a.startedAt || b.id.localeCompare(a.id, undefined, { numeric: true }));
  const offset = p.offset ?? 0;
  const tasks = listed.slice(offset, offset + (p.limit ?? DEFAULT_STATUS_LIMIT));
  sawTerminal(s, tasks);
  const summaries = await Promise.all(tasks.map((t) => summarize(s, t, p.tail_lines)));
  return toStatusResult(summaries, undefined, {
    total: listed.length,
    offset,
    hiddenFinished: all.length - listed.length,
  });
}

interface Read {
  lines: string[];
  nextCursor: number;
  totalBytes: number;
  truncated: boolean;
  fromLog: boolean;
}

function cutToLastNewline(bytes: Uint8Array): Uint8Array {
  const i = bytes.lastIndexOf(NL);
  return i < 0 ? bytes.subarray(0, 0) : bytes.subarray(0, i + 1);
}

function splitLines(raw: Uint8Array): string[] {
  const lines = normalizeForDisplay(decoder.decode(raw)).split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// Reads from the log by byte offset. A half-written final line is withheld until it completes or the task ends.
async function readLog(s: Services, t: Task, stream: StreamName, since: number | undefined, maxBytes: number, window: number): Promise<Read | undefined> {
  const probe = await s.logs.read(t.id, stream, 0, 0);
  if ("error" in probe) return undefined;
  const total = probe.totalBytes;
  const start = since !== undefined ? Math.min(since, total) : Math.max(0, total - window);
  const want = since !== undefined ? maxBytes : total - start;
  const r = await s.logs.read(t.id, stream, start, want);
  if ("error" in r) return undefined;
  let bytes = r.bytes;
  const more = r.nextOffset < total;
  const truncated = more;
  let skip = 0;
  if (since === undefined && start > 0) {
    const nl = bytes.indexOf(NL); // the window starts mid-line
    skip = nl < 0 ? bytes.length : nl + 1;
  }
  if (more || !isTerminal(t)) {
    const cut = cutToLastNewline(bytes);
    if (cut.length > 0 || !more) bytes = cut;
  }
  const consumed = bytes.length;
  const lines = splitLines(bytes.subarray(skip));
  return { lines, nextCursor: start + consumed, totalBytes: total, truncated, fromLog: true };
}

// Fallback for a degraded or unreadable log: only the in-memory ring (best effort; `since` is not honoured).
function readRing(s: Services, t: Task, since: number | undefined): Read {
  const rt = liveRuntime(s, t.id);
  const total = rt?.tail.totalBytes() ?? t.totalBytes;
  if (!rt || (since !== undefined && since >= total)) return { lines: [], nextCursor: total, totalBytes: total, truncated: false, fromLog: false };
  const lines = rt.tail.lines(Number.MAX_SAFE_INTEGER);
  const partial = isTerminal(t) ? rt.tail.partial() : "";
  return { lines: partial ? [...lines, partial] : lines, nextCursor: total, totalBytes: total, truncated: false, fromLog: false };
}

function capBytes(lines: string[], maxBytes: number, keep: "end" | "start"): { out: string; cut: boolean } {
  const enc = new TextEncoder();
  const picked: string[] = [];
  let used = 0;
  const order = keep === "end" ? [...lines].reverse() : lines;
  for (const line of order) {
    const size = enc.encode(line).length + 1;
    if (used + size > maxBytes) return { out: (keep === "end" ? picked.reverse() : picked).join("\n"), cut: true };
    used += size;
    picked.push(line);
  }
  return { out: (keep === "end" ? picked.reverse() : picked).join("\n"), cut: false };
}

async function output(s: Services, p: BgOutputArgs, ctx: ExtensionContext): Promise<Result> {
  guard(s, ctx);
  const t = lookup(s, p.id);
  let re: RegExp | undefined;
  if (p.grep !== undefined) {
    try {
      re = new RegExp(p.grep);
    } catch (e) {
      fail(s, failure("bad_grep", { pattern: p.grep, error: (e as Error).message }));
    }
  }
  const stream: StreamName = p.stream !== undefined && s.runner().capabilities.splitStreams ? p.stream : "combined";
  const maxBytes = p.max_bytes ?? s.config().output.maxBytes;
  const useLog = t.logPath !== undefined && !t.logDegraded;
  const window = re ? GREP_WINDOW_BYTES : Math.max(maxBytes * 4, MIN_TAIL_WINDOW_BYTES);
  const read = (useLog ? await readLog(s, t, stream, p.since, maxBytes, window) : undefined) ?? readRing(s, t, p.since);

  let lines = read.lines;
  if (re) lines = grepLines(lines, re, p.context ?? 0);
  if (p.since === undefined) {
    const n = p.tail_lines ?? DEFAULT_OUTPUT_TAIL;
    lines = n > 0 ? lines.slice(-n) : [];
  }
  const capped = capBytes(lines, maxBytes, p.since === undefined ? "end" : "start");
  const degraded = t.logDegraded || !read.fromLog;
  sawTerminal(s, [t]);
  const rt = liveRuntime(s, t.id);
  const notes: string[] = [];
  if (degraded) notes.push(failure("log_degraded", { id: t.id, error: "the log could not be written or read", kib: Math.round(s.config().output.ringBytes / 1024) }));
  if (p.stream !== undefined && p.stream !== stream) notes.push(failure("stream_unsupported", { stream: p.stream }));
  const note = notes.length > 0 ? notes.join("\n") : undefined;
  const r = {
    id: t.id,
    state: t.state,
    ...(t.exitCode !== undefined ? { exitCode: t.exitCode } : {}),
    output: capped.out,
    returnedBytes: new TextEncoder().encode(capped.out).length,
    totalBytes: read.fromLog ? read.totalBytes : (rt?.tail.totalBytes() ?? t.totalBytes),
    nextCursor: read.nextCursor,
    truncated: read.truncated || capped.cut,
    stream,
    ...(t.logPath !== undefined ? { logPath: t.logPath } : {}),
    logDegraded: degraded,
  };
  return toOutputResult(r, note);
}

async function wait(s: Services, p: BgWaitArgs, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<Result> {
  guard(s, ctx);
  for (const id of p.ids ?? []) lookup(s, id);
  const cfg = s.config().wait;
  const seconds = Math.min(p.timeout_s ?? cfg.defaultTimeoutSeconds, cfg.maxTimeoutSeconds);
  const r = await s.waits.wait({ ids: p.ids, mode: p.mode ?? "any", timeoutMs: seconds * 1000 }, signal);
  sawTerminal(s, r.tasks);
  const summaries = await Promise.all(
    r.tasks.map((t) => summarize(s, s.registry.get(t.id) ?? t, isTerminal(t) ? WAIT_TAIL : undefined)),
  );
  return toWaitResult(r, summaries);
}

async function kill(s: Services, p: BgKillArgs, ctx: ExtensionContext): Promise<Result> {
  guard(s, ctx);
  const hasId = p.id !== undefined;
  const hasAll = p.all === true;
  if (hasId === hasAll) {
    fail(s, failure("kill_args", { both: hasId ? 1 : 0 }));
  }
  if (p.signal !== undefined && p.signal !== "KILL" && !s.runner().capabilities.gracefulTerm) {
    fail(s, failure("kill_signal_unsupported", { signal: p.signal }));
  }
  if (p.id !== undefined) lookup(s, p.id);
  const r = await killTasks(s, p.id !== undefined ? [p.id] : "all", "bg_kill", p.signal === undefined ? undefined : (p.signal.toLowerCase() as KillSignal));
  sawTerminal(s, [...r.killed, ...r.alreadyFinished].map((id) => s.registry.get(id)).filter((t): t is Task => t !== undefined));
  return toKillResult(r);
}

async function write(s: Services, p: BgWriteArgs, ctx: ExtensionContext): Promise<Result> {
  guard(s, ctx);
  const t = lookup(s, p.id);
  if (isTerminal(t)) fail(s, failure("write_finished", { id: t.id, state: t.state }));
  const handle = s.runtime.get(t.id)?.handle;
  if (!handle?.writeStdin) fail(s, failure("write_no_stdin", { id: t.id }));
  const bytes = new TextEncoder().encode(p.data);
  if (bytes.byteLength > MAX_WRITE_BYTES) fail(s, failure("write_too_large", { bytes: bytes.byteLength, limit: MAX_WRITE_BYTES }));
  const eof = p.eof === true;
  const r = handle.writeStdin(bytes, eof);
  if (r) fail(s, failure("write_failed", { id: t.id, error: r.error }));
  return toWriteResult({ id: t.id, bytes: bytes.byteLength, eof });
}

async function monitor(s: Services, p: BgMonitorArgs, ctx: ExtensionContext): Promise<Result> {
  guard(s, ctx);
  const t = lookup(s, p.id);
  if (p.stop === true) return toMonitorResult({ id: t.id, monitoring: false, wasActive: s.monitors.stop(t.id) });
  if (isTerminal(t)) fail(s, failure("monitor_ended", { id: t.id, state: t.state }));
  let grep: RegExp | undefined;
  if (p.grep !== undefined) {
    try {
      grep = new RegExp(p.grep);
    } catch (e) {
      fail(s, failure("bad_grep", { pattern: p.grep, error: (e as Error).message, tool: "bg_monitor" }));
    }
  }
  const maxNotifications = p.max_notifications ?? DEFAULT_MAX_NOTIFICATIONS;
  // A line the task had begun before this call is not "new": the policy skips the rest of it.
  const midLine = (liveRuntime(s, t.id)?.tail.partial() ?? "") !== "";
  const { replaced } = s.monitors.start(t.id, { grep, maxNotifications, midLine });
  return toMonitorResult({ id: t.id, monitoring: true, ...(p.grep !== undefined ? { grep: p.grep } : {}), maxNotifications, replaced });
}

export function registerBgTools(pi: ExtensionAPI, s: Services): void {
  pi.registerTool({
    name: "bg_status",
    label: "bg_status",
    description: "List background tasks, or show one task with its last output lines. Lists running tasks first, then (with include_finished) finished ones, most recent first, 10 per page (limit, offset). Finished tasks stay available by id for the whole session.",
    promptSnippet: "bg_status: list background tasks or show one (state, runtime, exit code, last lines)",
    parameters: SCHEMAS.bg_status,
    execute: (_id, params, _signal, _onUpdate, ctx) => status(s, params, ctx),
  });
  pi.registerTool({
    name: "bg_output",
    label: "bg_output",
    description:
      "Read the output of a background task: the last tail_lines lines, or only new output since a byte cursor (since). Optional grep (JavaScript regex) with context lines; output is capped by max_bytes.",
    promptSnippet: "bg_output: read a background task's output (tail, since cursor, grep)",
    parameters: SCHEMAS.bg_output,
    execute: (_id, params, _signal, _onUpdate, ctx) => output(s, params, ctx),
  });
  pi.registerTool({
    name: "bg_wait",
    label: "bg_wait",
    description:
      "Wait until background tasks end (mode any or all), the timeout passes, or the user sends a message. Background tasks keep running when the wait ends early. Prefer ending your turn: you are notified when a task ends.",
    promptSnippet: "bg_wait: wait for background tasks to finish (returns early on a user message)",
    parameters: SCHEMAS.bg_wait,
    execute: (_id, params, signal, _onUpdate, ctx) => wait(s, params, signal, ctx),
  });
  pi.registerTool({
    name: "bg_kill",
    label: "bg_kill",
    description: "Stop a background task by id, or every running one with all true (give exactly one). Sends SIGTERM (or the signal you choose), then SIGKILL after a grace period.",
    promptSnippet: "bg_kill: stop one background task (id) or all of them (all)",
    parameters: SCHEMAS.bg_kill,
    execute: (_id, params, _signal, _onUpdate, ctx) => kill(s, params, ctx),
  });
  pi.registerTool({
    name: "bg_write",
    label: "bg_write",
    description: "Write text to the stdin of a running background task that was started with bash stdin true (for prompts and interactive programs). eof true closes stdin after the write. At most 65536 bytes per call. Tasks started without stdin cannot take input.",
    promptSnippet: "bg_write: send input to a background task started with stdin true",
    parameters: SCHEMAS.bg_write,
    execute: (_id, params, _signal, _onUpdate, ctx) => write(s, params, ctx),
  });
  pi.registerTool({
    name: "bg_monitor",
    label: "bg_monitor",
    description: "Turn new output lines of a running background task into notifications, so you can wait for specific output instead of polling bg_output. Optional grep (JavaScript regex) keeps only matching lines; lines are batched per second (at most 20 per message), and the monitor stops after max_notifications messages (default 10, maximum 100) or when the task ends. Lines printed before the call are not included. A new call on the same task replaces its monitor; stop true ends it. Monitor messages do not end bg_wait.",
    promptSnippet: "bg_monitor: be notified of new output lines of a running task (optionally matching a grep)",
    parameters: SCHEMAS.bg_monitor,
    execute: (_id, params, _signal, _onUpdate, ctx) => monitor(s, params, ctx),
  });
}
