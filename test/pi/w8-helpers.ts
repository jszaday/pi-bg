
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import { createIdAllocator } from "../../src/core/ids.js";
import { NotificationPolicy } from "../../src/core/notify-policy.js";
import { TaskRegistry } from "../../src/core/registry.js";
import { createTailBuffer } from "../../src/core/tail.js";
import { WaitCoordinator } from "../../src/core/wait.js";
import type { BgConfig, NotificationSink, TaskSpec } from "../../src/contract.js";
import type { Services } from "../../src/pi/runtime.js";
import { FakeClock, FakeNotificationSink, FakeRunner, MemLogStore, type FakeCtx, type FakePi } from "../fakes/index.js";

export function w8Spec(over: Partial<TaskSpec> = {}): TaskSpec {
  return { command: "sleep 1", cwd: "/tmp", hardTimeoutMs: null, bgTimeoutMs: null, notify: "done", startInBackground: true, ...over };
}

export function w8Services(over: { config?: Partial<BgConfig>; sink?: NotificationSink } = {}) {
  const clock = new FakeClock();
  const config: BgConfig = { ...structuredClone(DEFAULT_CONFIG), ...over.config };
  const ids = createIdAllocator(0);
  const registry = new TaskRegistry({ clock, ids });
  const fakeSink = new FakeNotificationSink();
  const sink = over.sink ?? fakeSink;
  const notify = new NotificationPolicy({
    clock,
    config: config.notify,
    registry,
    sink,
    summarize: (t) => ({ task: registry.summarize(t), tail: [] }),
  });
  const waits = new WaitCoordinator({ clock, registry, maxWaitMs: 1000, confirmQueued: () => true });
  registry.subscribe((t, ev, applied) => {
    notify.onTaskEvent(t, ev, applied);
    waits.onTaskEvent(t, ev, applied);
  });
  const uiCalls: { msg: string; level: string }[] = [];
  const logs = new MemLogStore();
  const s: Services = {
    clock,
    config: () => config,
    registry,
    runtime: new Map(),
    runner: () => new FakeRunner(),
    logs,
    overrides: {},
    ctx: {},
    waits,
    notify,
    ui: { refresh() {}, setFooterFocus() {}, notify: (msg, level) => void uiCalls.push({ msg, level }) },
    sessionId: () => "sess",
  };
  return { s, clock, registry, sink: fakeSink, notify, waits, uiCalls, logs, config };
}

/** Adds the ctx members the glue reads beyond FakeCtx. */
export function w8Ctx(_pi: FakePi, extra: Record<string, unknown> = {}): Partial<FakeCtx> {
  return { sessionManager: { getBranch: () => [] }, ...extra } as unknown as Partial<FakeCtx>;
}

export function w8Task(h: ReturnType<typeof w8Services>, over: Partial<TaskSpec> = {}) {
  const t = h.registry.create(w8Spec(over));
  h.s.runtime.set(t.id, { tail: createTailBuffer(1024), timers: [] });
  h.registry.dispatch(t.id, { type: "handoff", reason: "requested", at: h.clock.now() });
  return t;
}
