import { createIdAllocator } from "../../src/core/ids.js";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import { MonitorPolicy } from "../../src/core/monitor-policy.js";
import { TaskRegistry } from "../../src/core/registry.js";
import type { BgConfig, ProcessRunner } from "../../src/contract.js";
import type { Reaper, Services } from "../../src/pi/runtime.js";
import { FakeClock, FakeMonitorSink, FakeRunner, MemLogStore } from "../fakes/index.js";

export interface W6bEnv {
  s: Services;
  clock: FakeClock;
  runner: FakeRunner;
  logs: MemLogStore;
  notices: { msg: string; level: string }[];
  refreshes: { n: number };
  reaper: { watched: [number, number][]; unwatched: number[] } & Reaper;
  config: BgConfig;
  monitorSink: FakeMonitorSink;
}

export function w6bEnv(over: { config?: Partial<BgConfig>; runner?: ProcessRunner } = {}): W6bEnv {
  const clock = new FakeClock();
  const runner = new FakeRunner({}, clock);
  const logs = new MemLogStore();
  const config: BgConfig = { ...DEFAULT_CONFIG, ...over.config };
  const notices: { msg: string; level: string }[] = [];
  const refreshes = { n: 0 };
  const reaper = {
    watched: [] as [number, number][],
    unwatched: [] as number[],
    watch(pid: number, pgid: number) {
      this.watched.push([pid, pgid]);
    },
    unwatch(pgid: number) {
      this.unwatched.push(pgid);
    },
  };
  const monitorSink = new FakeMonitorSink();
  const s = {
    clock,
    config: () => config,
    registry: new TaskRegistry({ clock, ids: createIdAllocator(0) }),
    runtime: new Map(),
    runner: () => over.runner ?? runner,
    logs,
    monitors: new MonitorPolicy({ clock, config: config.notify, sink: monitorSink }),
    overrides: {},
    ctx: {},
    ui: { refresh: () => void refreshes.n++, notify: (msg: string, level: string) => notices.push({ msg, level }) },
    sessionId: () => "sess",
    reaper,
  } as unknown as Services;
  return { s, clock, runner, logs, notices, refreshes, reaper, config, monitorSink };
}

/** Lets pending promise continuations run (no timers involved). */
export const w6bFlush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};

/** Full-enough tool context for the native bash tool (it reads ctx.sessionManager). */
export const w6bCtx = {
  sessionManager: { getSessionId: () => "sess", getSessionFile: () => undefined },
  cwd: process.cwd(),
} as never;
