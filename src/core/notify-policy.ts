// Notification policy (DESIGN section 9). Pure: time from the injected clock,
// delivery through the NotificationSink port, status kept on the task record via
// the registry (notify_status events). Status only moves forward
// (none -> pending -> sent -> acked, or none/pending -> suppressed) except the one
// redelivery that returns a lost `sent` task to `pending`.

import type {
  BgConfig, Clock, KillCause, NotificationItem, NotificationSink, Task, TaskEvent, TaskId, TimerHandle,
} from "../contract.js";
import type { TaskRegistry } from "./registry.js";

const TERMINAL = new Set(["exited", "killed", "timed_out", "spawn_failed"]);
// Kills the agent or user caused; they already know the outcome.
const QUIET_KILLS: ReadonlySet<KillCause> = new Set<KillCause>(["bg_kill", "command", "shutdown", "turn_abort"]);

/** True when the outcome counts as an error: not a clean exit, a non-zero code or a signal. Shared by the "error" level and the renderer colour. */
export function isErrorOutcome(t: Pick<Task, "state" | "exitCode" | "signal">): boolean {
  return t.state !== "exited" || (t.exitCode ?? 0) !== 0 || (t.signal ?? null) !== null;
}

export class NotificationPolicy {
  private queue: TaskId[] = [];
  private timer: TimerHandle | undefined;
  private readonly handled = new Set<TaskId>(); // once-only latch for terminal transitions
  private readonly redelivered = new Set<TaskId>(); // at most one redelivery per task

  constructor(
    private readonly deps: {
      clock: Clock;
      config: BgConfig["notify"];
      registry: TaskRegistry;
      sink: NotificationSink;
      summarize: (t: Task) => NotificationItem;
    },
  ) {}

  onTaskEvent(t: Task, ev: TaskEvent, applied: boolean): void {
    if (ev.type === "notify_status" || !applied) return;
    if (!TERMINAL.has(t.state)) return;
    // A task that ended while still foreground returned its result through the open
    // tool call; nothing to notify and nothing to latch.
    if (t.handoffReason === undefined) return;
    if (this.handled.has(t.id) || t.notifyStatus !== "none") return;
    this.handled.add(t.id);

    if (!this.isDue(t)) {
      this.deps.registry.dispatch(t.id, { type: "notify_status", status: "suppressed" });
      return;
    }
    this.deps.registry.dispatch(t.id, { type: "notify_status", status: "pending" });
    this.queue.push(t.id);
    if (this.deps.config.batchMs <= 0) {
      this.flush();
    } else if (this.timer === undefined) {
      this.timer = this.deps.clock.setTimeout(() => this.flush(), this.deps.config.batchMs);
    }
  }

  // A tool result already told the agent about this terminal task.
  markAgentSaw(id: TaskId): void {
    const t = this.deps.registry.get(id);
    if (!t || !TERMINAL.has(t.state)) return;
    if (t.notifyStatus === "none" || t.notifyStatus === "pending") {
      this.handled.add(id);
      this.queue = this.queue.filter((q) => q !== id);
      if (this.queue.length === 0) this.clearTimer();
      this.deps.registry.dispatch(id, { type: "notify_status", status: "suppressed" });
    } else if (t.notifyStatus === "sent") {
      this.deps.registry.dispatch(id, { type: "notify_status", status: "acked" });
    }
  }

  markAcked(ids: TaskId[]): void {
    for (const id of ids) {
      if (this.deps.registry.get(id)?.notifyStatus === "sent") {
        this.deps.registry.dispatch(id, { type: "notify_status", status: "acked" });
      }
    }
  }

  // After an aborted run, messages sent but never acked are probably lost (Esc clears
  // the queues). Redeliver each such task once, as nextTurn, without waking.
  onAgentSettled(aborted: boolean): void {
    if (!aborted) return;
    const lost = this.deps.registry.list().filter(
      (t) => t.notifyStatus === "sent" && !t.notifyRedelivered && !this.redelivered.has(t.id),
    );
    if (lost.length === 0) return;
    for (const t of lost) {
      this.redelivered.add(t.id);
      this.deps.registry.dispatch(t.id, { type: "notify_status", status: "pending" });
    }
    // Mark sent before sending: an ack (message_end) may arrive synchronously inside sink.send.
    const items = lost.map((t) => this.deps.summarize(this.deps.registry.get(t.id) ?? t));
    for (const t of lost) this.deps.registry.dispatch(t.id, { type: "notify_status", status: "sent" });
    this.deps.sink.send({ items, redelivery: true }, { deliverAs: "nextTurn", triggerTurn: false });
  }

  // Ends the batching window now: one message for everything pending.
  flush(): void {
    this.clearTimer();
    const tasks = this.queue
      .map((id) => this.deps.registry.get(id))
      .filter((t): t is Task => t !== undefined && t.notifyStatus === "pending");
    this.queue = [];
    if (tasks.length === 0) return;
    // Mark sent before sending: an ack (message_end) may arrive synchronously inside sink.send.
    const items = tasks.map((t) => this.deps.summarize(t));
    for (const t of tasks) this.deps.registry.dispatch(t.id, { type: "notify_status", status: "sent" });
    this.deps.sink.send({ items, redelivery: false }, { deliverAs: this.deps.config.delivery, triggerTurn: this.deps.config.wake });
  }

  // Drops the pending batch without sending (teardown: a message now would wake a dying session).
  discard(): void {
    this.clearTimer();
    const ids = this.queue;
    this.queue = [];
    for (const id of ids) {
      if (this.deps.registry.get(id)?.notifyStatus === "pending") this.deps.registry.dispatch(id, { type: "notify_status", status: "suppressed" });
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.deps.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private isDue(t: Task): boolean {
    const level = t.spec.notify;
    if (level === "off") return false;
    if (t.state === "killed") return level === "done" && !(t.killCause !== undefined && QUIET_KILLS.has(t.killCause));
    if (level === "done") return true;
    // level "error": non-zero exit, death by signal, hard timeout, spawn failure
    return isErrorOutcome(t);
  }
}
