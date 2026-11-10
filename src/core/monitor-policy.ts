// Monitor policy (DESIGN section 5.8): turns new output lines of a running task into batched messages,
// like `tail -f -n0 | grep`. Pure: time from the injected clock, delivery through the MonitorSink port.
// State is per task and lives only in memory; messages are informational and never redelivered.

import type { BgConfig, Clock, MonitorSink, Task, TaskEvent, TaskId, TimerHandle } from "../contract.js";
import { normalizeForDisplay } from "./tail.js";

/** Lines collected for this long, from the first pending line, go out as one message. */
export const MONITOR_BATCH_MS = 1000;
/** Most lines in one message; the rest of the window is counted, not listed. */
export const MONITOR_MAX_LINES = 20;
/** A longer line is cut to this many characters (the last three are "..."). */
export const MONITOR_LINE_MAX_CHARS = 500;
/** An unterminated line is held up to this many characters; the rest of it is dropped until the next newline. */
const PARTIAL_MAX_CHARS = 64 * 1024;

const TERMINAL = new Set(["exited", "killed", "timed_out", "spawn_failed"]);

export interface MonitorOptions {
  /** Only lines matching this are reported; absent reports every line. */
  grep?: RegExp;
  maxNotifications: number;
  /** True when the task had already printed part of a line: that line began before the monitor, so it is skipped. */
  midLine?: boolean;
}

interface Monitor {
  grep?: RegExp;
  maxNotifications: number;
  sent: number;
  decoder: TextDecoder;
  partial: string;
  skipNext: boolean; // the line being completed began before the monitor started
  pending: string[];
  omitted: number;
  timer?: TimerHandle;
}

export class MonitorPolicy {
  private readonly monitors = new Map<TaskId, Monitor>();

  constructor(
    private readonly deps: { clock: Clock; config: BgConfig["notify"]; sink: MonitorSink },
  ) {}

  active(id: TaskId): boolean {
    return this.monitors.has(id);
  }

  /** Starts watching `id`, replacing an active monitor (its pending lines are dropped). Returns whether one was replaced. */
  start(id: TaskId, opts: MonitorOptions): { replaced: boolean } {
    const replaced = this.drop(id);
    this.monitors.set(id, {
      grep: opts.grep ? new RegExp(opts.grep.source, opts.grep.flags.replace(/[gy]/g, "")) : undefined, // no lastIndex state
      maxNotifications: opts.maxNotifications,
      sent: 0,
      decoder: new TextDecoder("utf-8"),
      partial: "",
      skipNext: opts.midLine === true,
      pending: [],
      omitted: 0,
    });
    return { replaced };
  }

  /** Stops watching `id` without sending anything. Returns whether a monitor was active. */
  stop(id: TaskId): boolean {
    return this.drop(id);
  }

  /** Feeds an output chunk of `id`; ignored when the task is not monitored. */
  onOutput(id: TaskId, chunk: Uint8Array): void {
    const m = this.monitors.get(id);
    if (!m) return;
    const parts = (m.partial + m.decoder.decode(chunk, { stream: true })).split("\n");
    const rest = parts.pop() ?? "";
    for (const raw of parts) this.accept(m, raw);
    m.partial = rest.length > PARTIAL_MAX_CHARS ? rest.slice(0, PARTIAL_MAX_CHARS) : rest;
    if (this.monitors.get(id) === m && m.pending.length > 0 && m.timer === undefined) {
      m.timer = this.deps.clock.setTimeout(() => this.flush(id, undefined), MONITOR_BATCH_MS);
    }
  }

  /** On the task's end: sends what is pending (and the unterminated last line) at once, then stops. Sends nothing when nothing is pending. */
  onTaskEvent(t: Task, ev: TaskEvent, applied: boolean): void {
    if (ev.type === "notify_status" || !applied || !TERMINAL.has(t.state)) return;
    const m = this.monitors.get(t.id);
    if (!m) return;
    const rest = m.partial + m.decoder.decode();
    m.partial = "";
    if (rest !== "") this.accept(m, rest);
    this.flush(t.id, "task_ended");
  }

  /** Session shutdown: cancels every timer and drops pending lines without sending (a message now would wake a dying session). */
  disposeAll(): void {
    for (const id of [...this.monitors.keys()]) this.drop(id);
  }

  private accept(m: Monitor, raw: string): void {
    if (m.skipNext) {
      m.skipNext = false;
      return;
    }
    const line = normalizeForDisplay(raw);
    if (m.grep && !m.grep.test(line)) return;
    if (m.pending.length >= MONITOR_MAX_LINES) {
      m.omitted++;
      return;
    }
    m.pending.push(line.length > MONITOR_LINE_MAX_CHARS ? line.slice(0, MONITOR_LINE_MAX_CHARS - 3) + "..." : line);
  }

  // Sends the window now. `ended` is set when the task ended; the monitor also stops at its notification cap.
  private flush(id: TaskId, ended: "task_ended" | undefined): void {
    const m = this.monitors.get(id);
    if (!m) return;
    if (m.timer !== undefined) this.deps.clock.clearTimeout(m.timer);
    m.timer = undefined;
    const lines = m.pending;
    const omitted = m.omitted;
    m.pending = [];
    m.omitted = 0;
    if (lines.length === 0) {
      if (ended) this.monitors.delete(id);
      return;
    }
    m.sent++;
    const stopped = ended ?? (m.sent >= m.maxNotifications ? "max_notifications" : undefined);
    if (stopped) this.monitors.delete(id);
    this.deps.sink.send(
      { id, lines, omitted, ...(stopped ? { stopped } : {}), maxNotifications: m.maxNotifications },
      { deliverAs: this.deps.config.delivery, triggerTurn: this.deps.config.wake },
    );
  }

  private drop(id: TaskId): boolean {
    const m = this.monitors.get(id);
    if (!m) return false;
    if (m.timer !== undefined) this.deps.clock.clearTimeout(m.timer);
    this.monitors.delete(id);
    return true;
  }
}
