import { describe, expect, it } from "vitest";
import type { TaskSpec } from "../../src/contract.js";
import { MAX_FINISHED_RUNTIME } from "../../src/pi/runtime.js";
import { startTask } from "../../src/pi/start-task.js";
import { w6bEnv, w6bFlush } from "./w6b-helpers.js";

const spec = (over: Partial<TaskSpec> = {}): TaskSpec => ({
  command: "make",
  cwd: "/tmp",
  hardTimeoutMs: null,
  bgTimeoutMs: null,
  notify: "done",
  startInBackground: false,
  ...over,
});

describe("startTask", () => {
  it("creates the task, refreshes the UI, wires pid, log path and output counts", async () => {
    const e = w6bEnv();
    e.runner.script([{ at: 0, chunk: "hello\n" }, { at: 10, exit: { code: 0, signal: null } }]);
    const r = startTask(e.s, spec());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(e.refreshes.n).toBeGreaterThanOrEqual(1);
    expect(r.task.id).toBe("bg1");
    const t = e.s.registry.get("bg1")!;
    expect(t.pid).toBe(10_000);
    expect(t.logPath).toBe("mem://bg1");
    expect(t.totalBytes).toBe(6);
    expect(e.s.runtime.get("bg1")!.tail.lines(5)).toEqual(["hello"]);
    expect(e.logs.contents("bg1")).toBe("hello\n");
    expect(e.reaper.watched).toEqual([[10_000, 10_000]]);
  });

  it("feeds output chunks to the monitors, and a monitor ends with the task", async () => {
    const e = w6bEnv();
    e.runner.script([{ at: 10, chunk: "before\n" }, { at: 20, chunk: "ready\npart" }, { at: 30, exit: { code: 0, signal: null } }]);
    const r = startTask(e.s, spec({ startInBackground: true }));
    expect(r.ok).toBe(true);
    e.s.monitors.start("bg1", { maxNotifications: 10 });
    e.s.registry.subscribe((t, ev, applied) => e.s.monitors.onTaskEvent(t, ev, applied));
    e.clock.advance(10);
    e.clock.advance(10);
    await w6bFlush();
    e.clock.advance(10);
    await w6bFlush();
    expect(e.monitorSink.sent.map((m) => [m.batch.lines, m.batch.stopped])).toEqual([[["before", "ready", "part"], "task_ended"]]);
  });

  it("on exit dispatches exit, clears timers, keeps the reaper watching (#18) and calls onExit", async () => {
    const e = w6bEnv();
    e.runner.script([{ at: 10, exit: { code: 3, signal: null } }]);
    let exited: unknown;
    startTask(e.s, spec({ bgTimeoutMs: 5_000, hardTimeoutMs: 60_000 }), { hooks: { onExit: (i) => (exited = i) } });
    expect(e.clock.pending()).toBeGreaterThanOrEqual(2);
    e.clock.advance(10);
    await w6bFlush();
    const t = e.s.registry.get("bg1")!;
    expect(t.state).toBe("exited");
    expect(t.exitCode).toBe(3);
    expect(exited).toEqual({ code: 3, signal: null });
    expect(e.clock.pending()).toBe(0);
    expect(e.reaper.unwatched).toEqual([]); // the group may still hold a job started with `&`
  });

  it("refuses at maxRunningTasks with the task_limit text and creates no task", () => {
    const e = w6bEnv({ config: { maxRunningTasks: 1 } });
    expect(startTask(e.s, spec()).ok).toBe(true);
    const r = startTask(e.s, spec());
    expect(r).toMatchObject({ ok: false, kind: "task_limit" });
    expect(!r.ok && r.message).toMatch(/1 background tasks are running/);
    expect(e.s.registry.list()).toHaveLength(1);
    expect(e.runner.started).toHaveLength(1);
    expect(e.notices.at(-1)?.level).toBe("error");
  });

  it("records spawn_failed for a startError and reports cause and action", () => {
    const e = w6bEnv({ runner: { capabilities: { pid: false, splitStreams: false, gracefulTerm: false }, start: () => ({ startError: "no such dir" }) } });
    const r = startTask(e.s, spec());
    expect(r).toMatchObject({ ok: false, kind: "spawn_failed" });
    expect(!r.ok && r.message).toMatch(/no such dir.*Action/s);
    const t = e.s.registry.get("bg1")!;
    expect(t.state).toBe("spawn_failed");
    expect(t.error).toBe("no such dir");
    expect(e.s.runtime.has("bg1")).toBe(false);
  });

  it("names the shell the runner exposes in the spawn failure, else the generic text", () => {
    const caps = { pid: false, splitStreams: false, gracefulTerm: false };
    const named = w6bEnv({ runner: { capabilities: caps, shell: "/bin/zsh", start: () => ({ startError: "x" }) } as never });
    const r1 = startTask(named.s, spec());
    expect(!r1.ok && r1.message).toContain("using /bin/zsh:");
    const plain = w6bEnv({ runner: { capabilities: caps, start: () => ({ startError: "x" }) } });
    const r2 = startTask(plain.s, spec());
    expect(!r2.ok && r2.message).toContain("using the configured shell:");
  });

  it("treats a throwing runner as spawn failure", () => {
    const e = w6bEnv({ runner: { capabilities: { pid: false, splitStreams: false, gracefulTerm: false }, start: () => { throw new Error("boom"); } } });
    expect(startTask(e.s, spec())).toMatchObject({ ok: false, kind: "spawn_failed" });
    expect(e.s.registry.get("bg1")!.error).toBe("boom");
  });

  it("continues ring-only when the log cannot be opened and flags log_degraded", () => {
    const e = w6bEnv();
    e.logs.failNextOpen("disk full");
    e.runner.script([{ at: 0, chunk: "x\n" }]);
    startTask(e.s, spec());
    const t = e.s.registry.get("bg1")!;
    expect(t.logDegraded).toBe(true);
    expect(t.logPath).toBeUndefined();
    expect(e.s.runtime.get("bg1")!.tail.lines(5)).toEqual(["x"]);
    expect(e.notices.filter((n) => /disk full/.test(n.msg))).toHaveLength(1);
  });

  it("flags a write failure once and keeps the tail", () => {
    const e = w6bEnv();
    e.logs.failWrites("ENOSPC");
    e.runner.script([{ at: 0, chunk: "a\n" }, { at: 1, chunk: "b\n" }]);
    startTask(e.s, spec());
    e.clock.advance(1);
    expect(e.s.registry.get("bg1")!.logDegraded).toBe(true);
    expect(e.notices.filter((n) => /ENOSPC/.test(n.msg))).toHaveLength(1);
    expect(e.s.runtime.get("bg1")!.tail.lines(5)).toEqual(["a", "b"]);
  });

  it("hard timeout: dispatches hard_timeout, stops the process, calls the hook; exit makes timed_out", async () => {
    const e = w6bEnv();
    let fired = 0;
    startTask(e.s, spec({ hardTimeoutMs: 1000 }), { hooks: { onHardTimeout: () => fired++ } });
    e.clock.advance(1000);
    await w6bFlush();
    expect(fired).toBe(1);
    expect(e.runner.kills).toEqual(["term"]);
    expect(e.s.registry.get("bg1")!.state).toBe("timed_out");
  });

  it("negative: a task that exits first never fires its hard-timeout hook", async () => {
    const e = w6bEnv();
    e.runner.script([{ at: 5, exit: { code: 0, signal: null } }]);
    let fired = 0;
    startTask(e.s, spec({ hardTimeoutMs: 1000 }), { hooks: { onHardTimeout: () => fired++ } });
    e.clock.advance(5);
    await w6bFlush();
    e.clock.advance(995);
    await w6bFlush();
    expect(fired).toBe(0);
    expect(e.runner.kills).toEqual([]);
  });

  it("arms the handoff timer only for foreground tasks with a bg timeout below the hard timeout", () => {
    const e = w6bEnv();
    let n = 0;
    const h = { onHandoffTimer: () => n++ };
    startTask(e.s, spec({ bgTimeoutMs: 500 }), { hooks: h });
    startTask(e.s, spec({ bgTimeoutMs: 500, startInBackground: true }), { hooks: h });
    startTask(e.s, spec({ bgTimeoutMs: 500, hardTimeoutMs: 500 }), { hooks: h });
    e.clock.advance(500);
    expect(n).toBe(1);
  });

  it("passes runCommand and env to the runner, keeping spec.command for display", () => {
    const e = w6bEnv();
    startTask(e.s, spec({ command: "ls" }), { runCommand: "pre\nls", env: { A: "1" } });
    expect(e.runner.started[0]).toMatchObject({ command: "pre\nls", env: { A: "1" }, cwd: "/tmp" });
    expect(e.s.registry.get("bg1")!.spec.command).toBe("ls");
  });
});

describe("startTask: eviction of finished runtime entries (#12)", () => {
  /** Starts `n` tasks one after another, each printing a line and exiting. */
  async function runFinished(e: ReturnType<typeof w6bEnv>, n: number): Promise<void> {
    for (let i = 1; i <= n; i++) {
      e.runner.script([{ at: 0, chunk: `out${i}\n`, exit: { code: 0, signal: null } }]);
      expect(startTask(e.s, spec()).ok).toBe(true);
      await w6bFlush();
    }
  }

  it("keeps exactly the newest 50 finished entries with their ring: nothing is evicted at 50", async () => {
    const e = w6bEnv();
    await runFinished(e, MAX_FINISHED_RUNTIME);
    expect([...e.s.runtime.values()].filter((rt) => rt.evicted)).toHaveLength(0);
    expect(e.s.runtime.get("bg1")!.tail.lines(5)).toEqual(["out1"]);
  });

  it("evicts the oldest at 51, releasing its ring but keeping its handle and registry entry", async () => {
    const e = w6bEnv();
    await runFinished(e, MAX_FINISHED_RUNTIME + 1);
    const evicted = [...e.s.runtime].filter(([, rt]) => rt.evicted).map(([id]) => id);
    expect(evicted).toEqual(["bg1"]);
    expect(e.s.runtime.get("bg1")!.tail.lines(5)).toEqual([]);
    expect(e.s.runtime.get("bg1")!.handle).toBeDefined(); // shutdown still signals a job left in the group (#18)
    expect(e.s.runtime.get("bg1")!.log).toBeUndefined();
    expect(e.s.runtime.get("bg2")!.tail.lines(5)).toEqual(["out2"]);
    expect(e.s.registry.get("bg1")!.state).toBe("exited");
    expect(e.logs.contents("bg1")).toBe("out1\n"); // the log is untouched
  });

  it("never evicts a running task, however many tasks have finished", async () => {
    const e = w6bEnv();
    e.runner.script([{ at: 0, chunk: "live\n" }]);
    startTask(e.s, spec());
    await runFinished(e, MAX_FINISHED_RUNTIME + 5);
    expect(e.s.runtime.get("bg1")!.evicted).toBeUndefined();
    expect(e.s.runtime.get("bg1")!.tail.lines(5)).toEqual(["live"]);
    expect([...e.s.runtime.values()].filter((rt) => rt.evicted)).toHaveLength(5);
  });

  it("keeps the ring of a finished task whose log is unavailable (it is the only copy)", async () => {
    const e = w6bEnv();
    e.logs.open = () => ({ error: "ENOSPC" });
    await runFinished(e, MAX_FINISHED_RUNTIME + 2);
    expect([...e.s.runtime.values()].filter((rt) => rt.evicted)).toHaveLength(0);
    expect(e.s.runtime.get("bg1")!.tail.lines(5)).toEqual(["out1"]);
  });
});
