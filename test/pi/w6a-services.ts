// Test harness for the W6a tool glue: real core classes (registry, notification policy, wait coordinator) over the W5 fakes.
import { vi, type MockInstance } from "vitest";
import type { BgConfig, NotifyLevel, ProcessHandle, RunnerCapabilities, Task, TaskId } from "../../src/contract.js";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import { createIdAllocator } from "../../src/core/ids.js";
import { NotificationPolicy } from "../../src/core/notify-policy.js";
import { TaskRegistry } from "../../src/core/registry.js";
import { createTailBuffer } from "../../src/core/tail.js";
import { WaitCoordinator } from "../../src/core/wait.js";
import type { Services } from "../../src/pi/runtime.js";
import { FakeClock, FakeNotificationSink, FakePi, FakeRunner, MemLogStore, type Step } from "../fakes/index.js";

export interface Harness {
  s: Services;
  clock: FakeClock;
  runner: FakeRunner;
  logs: MemLogStore;
  sink: FakeNotificationSink;
  pi: FakePi;
  config: BgConfig;
  ui: { msgs: string[] };
  markSaw: MockInstance<(id: TaskId) => void>;
  /** Starts a background task on the fake runner with the scripted steps; output goes to ring and log, exit to the registry. */
  start(command: string, steps?: Step[], over?: { notify?: NotifyLevel; log?: boolean; stdin?: boolean }): Task;
  /** Lets promise continuations (exit handlers, tool results) run. */
  flush(): Promise<void>;
}

export function makeHarness(o: { caps?: Partial<RunnerCapabilities>; seed?: number } = {}): Harness {
  const clock = new FakeClock();
  const runner = new FakeRunner(o.caps, clock);
  const logs = new MemLogStore();
  const sink = new FakeNotificationSink();
  const pi = new FakePi();
  const config: BgConfig = structuredClone(DEFAULT_CONFIG);
  const registry = new TaskRegistry({ clock, ids: createIdAllocator(o.seed ?? 0) });
  const notify = new NotificationPolicy({
    clock,
    config: config.notify,
    registry,
    sink,
    summarize: (t) => ({ task: registry.summarize(t), tail: [] }),
  });
  const ctx: Services["ctx"] = {};
  const waits = new WaitCoordinator({
    clock,
    registry,
    maxWaitMs: config.wait.maxTimeoutSeconds * 1000,
    confirmQueued: () => ctx.current?.hasPendingMessages?.(),
  });
  registry.subscribe((t, ev, applied) => notify.onTaskEvent(t, ev, applied));
  registry.subscribe((t, ev, applied) => waits.onTaskEvent(t, ev, applied));
  const ui = { msgs: [] as string[] };
  const s: Services = {
    clock,
    config: () => config,
    registry,
    runtime: new Map(),
    runner: () => runner,
    logs,
    overrides: {},
    ctx,
    waits,
    notify,
    ui: { refresh() {}, setFooterFocus() {}, notify: (m) => void ui.msgs.push(m) },
    sessionId: () => "sess",
  };
  const markSaw = vi.spyOn(notify, "markAgentSaw");

  const start: Harness["start"] = (command, steps = [], over = {}) => {
    const task = registry.create({
      command,
      cwd: "/",
      hardTimeoutMs: null,
      bgTimeoutMs: null,
      notify: over.notify ?? "done",
      startInBackground: true,
      ...(over.stdin && { stdin: true }),
    });
    const tail = createTailBuffer(config.output.ringBytes);
    const rt: Services["runtime"] extends Map<string, infer R> ? R : never = { tail, timers: [] };
    s.runtime.set(task.id, rt);
    const writer = over.log === false ? undefined : logs.open(task.id);
    if (writer && !("error" in writer)) {
      rt.log = writer;
      registry.dispatch(task.id, { type: "log_path", path: writer.path });
    }
    runner.script(steps);
    const handle = runner.start({ command, cwd: "/", ...(over.stdin && { stdin: true }) }, (chunk, stream) => {
      tail.push(chunk);
      if (rt.log) rt.log.write(chunk, stream);
      registry.dispatch(task.id, { type: "output", bytes: chunk.length, at: clock.now() });
    }) as ProcessHandle;
    rt.handle = handle;
    registry.dispatch(task.id, { type: "pid", pid: handle.pid ?? 0 });
    void handle.exited.then((e) => registry.dispatch(task.id, { type: "exit", code: e.code, signal: e.signal, at: clock.now() }));
    return registry.get(task.id) as Task;
  };

  const flush = () => new Promise<void>((r) => setImmediate(r));
  return { s, clock, runner, logs, sink, pi, config, ui, markSaw, start, flush };
}

export function ids(list: { id: TaskId }[]): TaskId[] {
  return list.map((t) => t.id);
}
