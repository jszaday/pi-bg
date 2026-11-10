// Task state machine (DESIGN section 3): a pure reducer from (task, event) to task.
// Terminal states absorb: no event changes their state. Two kinds of metadata still
// apply after the end, because they happen after it by design: notify_status and
// log_degraded.
import type { Task, TaskEvent, TaskId, TaskSpec, NotifyStatus } from "../contract.js";

const TERMINAL: ReadonlySet<Task["state"]> = new Set(["exited", "killed", "timed_out", "spawn_failed"]);

export function isTerminal(t: Task): boolean {
  return TERMINAL.has(t.state);
}

/** Display order shared by `bg_status` and the shells panel: running tasks first, then finished ones; newest first within each group. */
export function compareForDisplay(a: Task, b: Task): number {
  return (
    Number(isTerminal(a)) - Number(isTerminal(b)) ||
    b.startedAt - a.startedAt ||
    b.id.localeCompare(a.id, undefined, { numeric: true })
  );
}

export function newTask(id: TaskId, spec: TaskSpec, now: number): Task {
  const base: Task = {
    id,
    spec,
    state: "foreground",
    startedAt: now,
    logDegraded: false,
    totalBytes: 0,
    notifyStatus: "none",
    notifyRedelivered: false,
  };
  if (spec.startInBackground) {
    return { ...base, state: "background", handoffAt: now, handoffReason: "requested" };
  }
  return base;
}

const NO_CHANGE = (task: Task) => ({ task, applied: false });

// notify status only moves forward, with one exception: sent -> pending is the single
// redelivery after a loss (DESIGN section 9.2), and marks notifyRedelivered.
// acked and suppressed are final.
function reduceNotify(task: Task, status: NotifyStatus): { task: Task; applied: boolean } {
  const from = task.notifyStatus;
  if (from === status || from === "acked" || from === "suppressed") return NO_CHANGE(task);
  if (status === "pending" && from === "sent") {
    if (task.notifyRedelivered) return NO_CHANGE(task); // a second loss is not retried
    return { task: { ...task, notifyStatus: "pending", notifyRedelivered: true }, applied: true };
  }
  if (status === "none") return NO_CHANGE(task); // never moves back
  return { task: { ...task, notifyStatus: status }, applied: true };
}

export function reduce(task: Task, ev: TaskEvent): { task: Task; applied: boolean } {
  // Metadata that applies in any state.
  if (ev.type === "notify_status") return reduceNotify(task, ev.status);
  if (ev.type === "log_degraded") {
    return task.logDegraded ? NO_CHANGE(task) : { task: { ...task, logDegraded: true }, applied: true };
  }
  if (isTerminal(task)) return NO_CHANGE(task);

  switch (ev.type) {
    case "handoff":
      if (task.state !== "foreground") return NO_CHANGE(task);
      return {
        task: { ...task, state: "background", handoffAt: ev.at, handoffReason: ev.reason },
        applied: true,
      };
    case "output":
      return { task: { ...task, totalBytes: task.totalBytes + Math.max(0, ev.bytes) }, applied: true };
    case "pid":
      return task.pid === ev.pid ? NO_CHANGE(task) : { task: { ...task, pid: ev.pid }, applied: true };
    case "log_path":
      return task.logPath === ev.path ? NO_CHANGE(task) : { task: { ...task, logPath: ev.path }, applied: true };
    case "kill_requested":
      // First cause wins: a stop already in progress (kill or hard timeout) is not re-attributed.
      if (task.killCause !== undefined || task.hardTimeoutFired) return NO_CHANGE(task);
      return { task: { ...task, killCause: ev.cause }, applied: true };
    case "hard_timeout":
      if (task.hardTimeoutFired || task.killCause !== undefined) return NO_CHANGE(task);
      return { task: { ...task, hardTimeoutFired: true }, applied: true };
    case "exit": {
      const state = task.killCause !== undefined ? "killed" : task.hardTimeoutFired ? "timed_out" : "exited";
      return {
        task: { ...task, state, endedAt: ev.at, exitCode: ev.code, signal: ev.signal },
        applied: true,
      };
    }
    case "spawn_failed":
      return {
        task: { ...task, state: "spawn_failed", endedAt: ev.at, error: ev.error },
        applied: true,
      };
  }
}
