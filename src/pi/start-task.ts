// Task starter shared by the foreground exec and run_in_background (DESIGN sections 3, 4, 10, 11, 12):
// creates the task, starts the runner, wires output (ring tail, log, byte counts), timers and exit handling.
// Pi-free: only the Services ports are used, so it is testable with the fakes.

import type { ExitInfo, ProcessHandle, Task, TaskId, TaskSpec } from "../contract.js";
import { failure } from "../core/format.js";
import { createTailBuffer } from "../core/tail.js";
import { isTerminal } from "../core/task.js";
import { planTimers } from "../core/timeout-policy.js";
import { evictFinished, type Services, type TaskRuntime } from "./runtime.js";

/** Callbacks of the caller that holds the task (the foreground exec). All optional. */
export interface StartHooks {
  /** Every output chunk, after tail and log. */
  onData?(chunk: Uint8Array): void;
  /** After the exit event was dispatched and timers were cleared. */
  onExit?(info: ExitInfo): void;
  /** The bg_timeout timer fired: the hook decides and performs the handoff. */
  onHandoffTimer?(): void;
  /** The hard timeout fired: `hard_timeout` is dispatched and the process is being stopped. */
  onHardTimeout?(): void;
}

export interface StartOptions {
  /** What the runner executes when it differs from `spec.command` (the native tool delivers "prefix\ncommand"). */
  runCommand?: string;
  env?: Record<string, string>;
  hooks?: StartHooks;
}

export type StartResult =
  | { ok: true; task: Task; runtime: TaskRuntime; handle: ProcessHandle }
  | { ok: false; kind: "task_limit" | "spawn_failed"; message: string; task?: Task };

const logDegradedText = (s: Services, id: TaskId, error: string): string =>
  failure("log_degraded", { id, error, kib: Math.round(s.config().output.ringBytes / 1024) });

export function startTask(s: Services, spec: TaskSpec, opts: StartOptions = {}): StartResult {
  const cfg = s.config();
  const limit = cfg.maxRunningTasks;
  if (s.registry.running().length >= limit) {
    const message = failure("task_limit", { limit });
    s.ui.notify(message, "error");
    return { ok: false, kind: "task_limit", message };
  }

  const hooks = opts.hooks ?? {};
  const task = s.registry.create(spec);
  const id = task.id;
  s.ui.refresh(); // create() notifies no subscriber; the footer status starts from here
  const rt: TaskRuntime = { tail: createTailBuffer(cfg.output.ringBytes), timers: [] };
  rt.onOutput = (chunk) => s.monitors.onOutput(id, chunk);
  s.runtime.set(id, rt);

  const degrade = (error: string): void => {
    if (s.registry.get(id)?.logDegraded) return;
    s.registry.dispatch(id, { type: "log_degraded", error });
    s.ui.notify(logDegradedText(s, id, error), "warning");
  };

  const opened = s.logs.open(id);
  if ("error" in opened) {
    degrade(opened.error); // ring-only from here on
  } else {
    rt.log = opened;
    s.registry.dispatch(id, { type: "log_path", path: opened.path });
  }

  const sink = (chunk: Uint8Array, stream: "stdout" | "stderr" | "combined"): void => {
    rt.tail.push(chunk);
    rt.onOutput?.(chunk);
    if (rt.log) {
      rt.log.write(chunk, stream);
      if (rt.log.degraded !== null) degrade(rt.log.degraded);
    }
    s.registry.dispatch(id, { type: "output", bytes: chunk.byteLength, at: s.clock.now() });
    hooks.onData?.(chunk);
  };

  let started: ProcessHandle | { startError: string };
  let shell = "the configured shell"; // the own-spawn runner exposes the real one
  try {
    const runner = s.runner();
    shell = (runner as { shell?: string }).shell ?? shell;
    started = runner.start({ command: opts.runCommand ?? spec.command, cwd: spec.cwd, env: opts.env, ...(spec.stdin && { stdin: true }) }, sink);
  } catch (e) {
    started = { startError: e instanceof Error ? e.message : String(e) };
  }

  if ("startError" in started) {
    const message = failure("spawn_failed", { cwd: spec.cwd, shell, error: started.startError });
    const failed = s.registry.dispatch(id, { type: "spawn_failed", error: started.startError, at: s.clock.now() });
    void rt.log?.close().catch(() => undefined);
    s.runtime.delete(id);
    s.ui.notify(message, "error");
    return { ok: false, kind: "spawn_failed", message, task: failed };
  }

  const handle = started;
  rt.handle = handle;
  if (handle.pid !== undefined) {
    s.registry.dispatch(id, { type: "pid", pid: handle.pid });
    s.reaper?.watch(handle.pid, handle.pid); // own-spawn child leads its process group
  }

  const clearTimers = (): void => {
    for (const t of rt.timers) s.clock.clearTimeout(t);
    rt.timers = [];
  };

  const { handoffInMs, killInMs } = planTimers(spec);
  if (handoffInMs !== null) {
    rt.timers.push(s.clock.setTimeout(() => hooks.onHandoffTimer?.(), handoffInMs));
  }
  if (killInMs !== null) {
    rt.timers.push(
      s.clock.setTimeout(() => {
        const cur = s.registry.get(id);
        if (!cur || isTerminal(cur)) return;
        s.registry.dispatch(id, { type: "hard_timeout", at: s.clock.now() });
        handle.kill("term");
        hooks.onHardTimeout?.();
      }, killInMs),
    );
  }

  void handle.exited.then(async (info) => {
    clearTimers();
    // The reaper keeps watching: a job started with `&` can outlive the task in its group (#18), and the watcher exits by itself once the group is empty.
    try {
      s.registry.dispatch(id, { type: "exit", code: info.code, signal: info.signal, at: s.clock.now() });
    } catch (e) {
      s.ui.notify(failure("listener_failed", { id, error: e instanceof Error ? e.message : String(e) }), "error");
    }
    try {
      await rt.log?.close();
    } catch {
      /* a failed close leaves the log as written; nothing to do */
    }
    evictFinished(s);
    hooks.onExit?.(info);
  });

  return { ok: true, task: s.registry.get(id) ?? task, runtime: rt, handle };
}
