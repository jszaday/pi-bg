// Wait coordinator (DESIGN section 8). Pure: time comes from the injected clock,
// events (task changes, user message, abort) are delivered by the glue.
// Tie-break: `finished` beats every other reason, including a user message that
// arrives at the same instant; it is re-checked at the moment of release.

import type { Clock, Task, TaskEvent, TaskId, TimerHandle, WaitReason, WaitRequest, WaitResult } from "../contract.js";
import type { TaskRegistry } from "./registry.js";

const TERMINAL = new Set(["exited", "killed", "timed_out", "spawn_failed"]);
const POLL_MS = 25;

interface ActiveWait {
  ids: TaskId[];
  mode: "any" | "all";
  startedAt: number;
  timer?: TimerHandle;
  settleTimer?: TimerHandle;
  userMessageAt?: number;
  finish(reason: WaitReason): void;
  check(): boolean; // finish condition met right now
}

export class WaitCoordinator {
  private readonly active = new Set<ActiveWait>();
  private readonly queueSettleMs: number;
  private readonly queueMaxMs: number;
  private userMessageQueued = false;

  constructor(
    private readonly deps: {
      clock: Clock;
      registry: TaskRegistry;
      maxWaitMs: number;
      queueSettleMs?: number;
      queueMaxMs?: number;
      confirmQueued: () => boolean | undefined;
    },
  ) {
    this.queueSettleMs = deps.queueSettleMs ?? 50;
    this.queueMaxMs = deps.queueMaxMs ?? 250;
  }

  wait(req: WaitRequest, signal: AbortSignal | undefined): Promise<WaitResult> {
    const { clock, registry } = this.deps;
    const ids = this.resolveIds(req);
    const startedAt = clock.now();
    const snapshot = (): Task[] => ids.map((id) => registry.get(id)).filter((t): t is Task => t !== undefined);
    const done = (reason: WaitReason): WaitResult => ({ reason, waitedMs: clock.now() - startedAt, tasks: snapshot() });

    if (ids.length === 0) return Promise.resolve(done("no_tasks"));

    const isDone = (): boolean => {
      const terminal = snapshot().map((t) => TERMINAL.has(t.state));
      return req.mode === "all" ? terminal.every(Boolean) : terminal.some(Boolean);
    };
    if (isDone()) return Promise.resolve(done("finished"));
    if (signal?.aborted) return Promise.resolve(done("aborted"));
    if (this.userMessageQueued) return Promise.resolve(done("user_message")); // queued before this wait began

    const timeoutMs = this.clampTimeout(req.timeoutMs);
    if (timeoutMs <= 0) return Promise.resolve(done("timeout"));

    return new Promise<WaitResult>((resolve) => {
      const w: ActiveWait = {
        ids,
        mode: req.mode,
        startedAt,
        check: isDone,
        finish: (reason) => {
          if (!this.active.has(w)) return;
          this.active.delete(w);
          if (w.timer !== undefined) clock.clearTimeout(w.timer);
          if (w.settleTimer !== undefined) clock.clearTimeout(w.settleTimer);
          signal?.removeEventListener("abort", onAbort);
          resolve(done(isDone() ? "finished" : reason));
        },
      };
      const onAbort = () => w.finish("aborted");
      signal?.addEventListener("abort", onAbort, { once: true });
      w.timer = clock.setTimeout(() => w.finish("timeout"), timeoutMs);
      this.active.add(w);
    });
  }

  onTaskEvent(t: Task, _ev: TaskEvent, applied: boolean): void {
    if (!applied) return;
    for (const w of [...this.active]) {
      if (w.ids.includes(t.id) && w.check()) w.finish("finished");
    }
  }

  // A user message (steer or follow-up) was queued. Each active wait is released
  // after queueSettleMs once confirmQueued() is not false, or at queueMaxMs.
  onUserMessage(): void {
    const { clock } = this.deps;
    const at = clock.now();
    for (const w of this.active) {
      if (w.userMessageAt !== undefined) continue; // already releasing; keep the earliest signal
      w.userMessageAt = at;
      const step = (delay: number): void => {
        w.settleTimer = clock.setTimeout(() => {
          if (!this.active.has(w)) return;
          const elapsed = clock.now() - at;
          if (this.deps.confirmQueued() !== false || elapsed >= this.queueMaxMs) {
            w.finish("user_message");
          } else {
            step(Math.min(POLL_MS, this.queueMaxMs - elapsed));
          }
        }, delay);
      };
      step(Math.min(this.queueSettleMs, this.queueMaxMs));
    }
  }

  // A user message was queued while no wait was active. Waits that start before the next turn begins end at once, because
  // Pi delivers the message only after the current tool batch. Cleared by clearQueuedUserMessage at turn_start.
  rememberUserMessage(): void {
    this.userMessageQueued = true;
  }

  clearQueuedUserMessage(): void {
    this.userMessageQueued = false;
  }

  // Session shutdown: resolve every active wait as `aborted` and clear its timers, so none outlives the session.
  dispose(): void {
    for (const w of [...this.active]) w.finish("aborted");
  }

  activeWaitIds(): TaskId[] {
    const out = new Set<TaskId>();
    for (const w of this.active) for (const id of w.ids) out.add(id);
    return [...out];
  }

  // Explicit ids that are unknown are dropped; none left means nothing to wait on.
  private resolveIds(req: WaitRequest): TaskId[] {
    const { registry } = this.deps;
    if (req.ids === undefined) return registry.running().filter((t) => t.state === "background").map((t) => t.id);
    return [...new Set(req.ids)].filter((id) => registry.get(id) !== undefined);
  }

  // NaN, negative and zero give an immediate `timeout`; anything above the cap is cut to it.
  private clampTimeout(ms: number): number {
    if (Number.isNaN(ms) || ms <= 0) return 0;
    return Math.min(ms, this.deps.maxWaitMs);
  }
}
