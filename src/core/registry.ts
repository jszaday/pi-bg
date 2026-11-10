// Task registry (DESIGN section 3): the collection of tasks, id allocation, queries and
// subscriptions. Holds data only; live handles belong to the glue.
import type { Clock, Task, TaskEvent, TaskId, TaskSpec, TaskSummary } from "../contract.js";
import { idNumber } from "./ids.js";
import { isTerminal, newTask, reduce } from "./task.js";

type Listener = (t: Task, ev: TaskEvent, applied: boolean) => void;

const COMMAND_CUT = 200;
const NOTIFIED = new Set(["sent", "acked"]);

export class TaskRegistry {
  private readonly clock: Clock;
  private readonly ids: { next(): TaskId; readonly seed?: number };
  private readonly tasks = new Map<TaskId, Task>();
  private readonly listeners = new Set<Listener>();
  private readonly queue: { t: Task; ev: TaskEvent; applied: boolean }[] = [];
  private draining = false;

  // `ids.seed` is optional so a bare `{ next }` works; without it isStale is always false.
  constructor(deps: { clock: Clock; ids: { next(): TaskId; readonly seed?: number } }) {
    this.clock = deps.clock;
    this.ids = deps.ids;
  }

  create(spec: TaskSpec): Task {
    const t = newTask(this.ids.next(), spec, this.clock.now());
    this.tasks.set(t.id, t);
    return t;
  }

  get(id: TaskId): Task | undefined {
    return this.tasks.get(id);
  }

  /**
   * Applies the event and returns the updated task. Subscribers run after the state is
   * updated, in dispatch order: an event dispatched from inside a subscriber is applied at
   * once but delivered after the current delivery finishes, so every subscriber sees events
   * in the order they were applied.
   */
  dispatch(id: TaskId, ev: TaskEvent): Task {
    const cur = this.tasks.get(id);
    if (!cur) {
      throw new Error(`dispatch(${ev.type}): no task ${id} in the registry. Create it with create() first; this is a pi-bg bug if the id came from a tool call.`);
    }
    const { task, applied } = reduce(cur, ev);
    if (applied) this.tasks.set(id, task);
    this.queue.push({ t: task, ev, applied });
    this.drain();
    return task;
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    let firstError: unknown;
    let failed = false;
    try {
      for (let item = this.queue.shift(); item; item = this.queue.shift()) {
        for (const fn of [...this.listeners]) {
          try {
            fn(item.t, item.ev, item.applied);
          } catch (e) {
            // One bad subscriber must not starve the others; the first error is rethrown after delivery.
            if (!failed) {
              failed = true;
              firstError = e;
            }
          }
        }
      }
    } finally {
      this.draining = false;
    }
    if (failed) throw firstError;
  }

  list(): Task[] {
    return [...this.tasks.values()];
  }

  running(): Task[] {
    return this.list().filter((t) => !isTerminal(t));
  }

  /** Movable = state foreground and not already being stopped (a kill or hard timeout is in progress). */
  movable(): Task[] {
    return this.list().filter((t) => t.state === "foreground" && t.killCause === undefined && !t.hardTimeoutFired);
  }

  /** An id from an earlier run: numeric part at or below the allocator seed and not in this registry. */
  isStale(id: TaskId): boolean {
    if (this.tasks.has(id)) return false;
    const n = idNumber(id);
    const seed = this.ids.seed ?? 0;
    return n !== undefined && n <= seed;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  summarize(t: Task, tail?: string[]): TaskSummary {
    const end = t.endedAt ?? this.clock.now();
    const s: TaskSummary = {
      id: t.id,
      command: t.spec.command.length > COMMAND_CUT ? t.spec.command.slice(0, COMMAND_CUT - 1) + "…" : t.spec.command,
      state: t.state,
      startedAt: new Date(t.startedAt).toISOString(),
      runtimeS: Math.max(0, Math.round((end - t.startedAt) / 1000)),
      totalBytes: t.totalBytes,
      notify: t.spec.notify,
      notified: NOTIFIED.has(t.notifyStatus),
      logDegraded: t.logDegraded,
    };
    if (t.spec.label !== undefined) s.label = t.spec.label;
    if (t.exitCode !== undefined) s.exitCode = t.exitCode;
    if (t.signal !== undefined) s.signal = t.signal;
    if (t.pid !== undefined) s.pid = t.pid;
    if (t.logPath !== undefined) s.logPath = t.logPath;
    if (tail !== undefined) s.lastLines = tail;
    return s;
  }
}
