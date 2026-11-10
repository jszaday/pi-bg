import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  BgConfig,
  Clock,
  LogStore,
  LogWriter,
  ProcessHandle,
  ProcessRunner,
  SessionOverrides,
  MonitorBatch,
  NotificationBatch,
  TailBuffer,
  TaskId,
  TimerHandle,
  UiSink,
} from "../contract.js";
import { createTailBuffer } from "../core/tail.js";
import { isTerminal } from "../core/task.js";
import type { MonitorPolicy } from "../core/monitor-policy.js";
import type { NotificationPolicy } from "../core/notify-policy.js";
import type { TaskRegistry } from "../core/registry.js";
import type { WaitCoordinator } from "../core/wait.js";

/** Live handles of one task; the registry holds data only (DESIGN section 3). */
export interface TaskRuntime {
  handle?: ProcessHandle;
  log?: LogWriter;
  tail: TailBuffer;
  timers: TimerHandle[];
  /** Set by evictFinished: the output ring was released; readers answer from the log instead. The handle stays (shutdown still signals a job left in the group). */
  evicted?: true;
}

/** How many finished tasks keep their output ring in memory; older ones are evicted and read from the log (DESIGN section 12). */
export const MAX_FINISHED_RUNTIME = 50;

/**
 * Releases the output ring of the oldest finished tasks beyond `keep` (by end time). Only tasks whose log is complete and readable
 * are evicted: with no log or a degraded one the ring is the only copy of the output. The registry entry and the handle are kept.
 */
export function evictFinished(s: Services, keep = MAX_FINISHED_RUNTIME): void {
  const held: { rt: TaskRuntime; endedAt: number }[] = [];
  for (const [id, rt] of s.runtime) {
    const t = s.registry.get(id);
    if (!t || rt.evicted || !isTerminal(t) || t.logPath === undefined || t.logDegraded) continue;
    held.push({ rt, endedAt: t.endedAt ?? 0 });
  }
  held.sort((a, b) => a.endedAt - b.endedAt); // stable: ties keep start order
  for (const { rt } of held.slice(0, Math.max(0, held.length - keep))) {
    rt.tail = createTailBuffer(1);
    rt.log = undefined;
    rt.evicted = true;
  }
}

/** Everything the Pi glue shares. Built once by the composition root (W8); tools receive it by closure. */
export interface Services extends ServicesExtras {
  clock: Clock;
  config: () => BgConfig;
  registry: TaskRegistry;
  runtime: Map<TaskId, TaskRuntime>;
  runner: () => ProcessRunner;
  logs: LogStore;
  overrides: SessionOverrides;
  /** W8 sets `current` at session_start; W6 refreshes it at each tool execute. confirmQueued reads `current?.hasPendingMessages?.()`. */
  ctx: { current?: ExtensionContext };
  waits: WaitCoordinator;
  notify: NotificationPolicy;
  monitors: MonitorPolicy;
  ui: UiSink;
  sessionId: () => string;
}

/** Reaper handle as returned by adapters `createReaper()`; null when unsupported. W8 sets it, the task starter calls watch(pid, pgid) and unwatch(pgid). */
export type Reaper = { watch(pid: number, pgid: number): void; unwatch(pgid: number): void };

/** Optional additions to Services (kept optional so test doubles stay small). */
export interface ServicesExtras {
  reaper?: Reaper | null;
  /** When set and returning a string, pi-bg is inactive (Windows, bash owned by another extension): bg_* tools answer with that text (built by W8 from format `failure(...)`). `config().enabled === false` is handled by the tools themselves via failure("inactive"). */
  inactiveReason?: () => string | undefined;
}

/** How long a kill waits for the exit: the runner's term -> kill escalation (`kill.termGraceMs`) plus slack of two thirds of it (2 s at the 3 s default), scaling with it. Shared by killTasks and the shutdown bound. */
export function killBoundMs(termGraceMs: number): number {
  return termGraceMs + Math.ceil((termGraceMs * 2) / 3);
}

/** Custom message type of notifications (S5) and the shape of its `details`, shared by the sink (W8) and the renderer (W7). */
export const NOTIFICATION_TYPE = "pi-bg:task";
export interface NotificationDetails {
  taskIds: TaskId[];
  batch: NotificationBatch;
}

/** Custom message type of bg_monitor messages and the shape of its `details`, shared by the sink and the renderer. Informational: no ack, no redelivery. */
export const MONITOR_TYPE = "pi-bg:monitor";
export interface MonitorDetails {
  batch: MonitorBatch;
}
