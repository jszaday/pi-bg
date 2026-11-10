import { describe, expect, it } from "vitest";
import type { Clock, Task, TaskEvent, TaskSpec } from "../../src/contract.js";
import { createIdAllocator } from "../../src/core/ids.js";
import { TaskRegistry } from "../../src/core/registry.js";

const spec = (over: Partial<TaskSpec> = {}): TaskSpec => ({
  command: "make",
  cwd: "/tmp",
  hardTimeoutMs: null,
  bgTimeoutMs: 30_000,
  notify: "done",
  startInBackground: false,
  ...over,
});

class TestClock implements Clock {
  t = 1_700_000_000_000;
  now() { return this.t; }
  setTimeout(): unknown { return 0; }
  clearTimeout(): void {}
}

function setup(seed = 0) {
  const clock = new TestClock();
  const ids = createIdAllocator(seed);
  return { clock, reg: new TaskRegistry({ clock, ids }) };
}

describe("TaskRegistry", () => {
  it("creates tasks with sequential ids at the clock time", () => {
    const { reg, clock } = setup();
    const a = reg.create(spec());
    clock.t += 5;
    const b = reg.create(spec({ startInBackground: true }));
    expect([a.id, b.id]).toEqual(["bg1", "bg2"]);
    expect(b).toMatchObject({ state: "background", startedAt: clock.t });
    expect(reg.get("bg1")).toBe(a);
    expect(reg.get("bg9")).toBeUndefined();
    expect(reg.list().map((t) => t.id)).toEqual(["bg1", "bg2"]);
  });

  it("a foreground task being killed is not movable", () => {
    const { reg, clock } = setup();
    const a = reg.create(spec());
    reg.dispatch(a.id, { type: "kill_requested", cause: "turn_abort", at: clock.now() });
    expect(reg.movable()).toEqual([]);
  });

  it("running and movable reflect state", () => {
    const { reg } = setup();
    const a = reg.create(spec());
    const b = reg.create(spec({ startInBackground: true }));
    const c = reg.create(spec());
    reg.dispatch(c.id, { type: "exit", code: 0, signal: null, at: 1 });
    expect(reg.running().map((t) => t.id)).toEqual([a.id, b.id]);
    expect(reg.movable().map((t) => t.id)).toEqual([a.id]);
    reg.dispatch(a.id, { type: "handoff", reason: "user", at: 2 });
    expect(reg.movable()).toEqual([]);
  });

  it("dispatch returns the updated task and stores it", () => {
    const { reg } = setup();
    const a = reg.create(spec());
    const r = reg.dispatch(a.id, { type: "output", bytes: 4, at: 1 });
    expect(r.totalBytes).toBe(4);
    expect(reg.get(a.id)).toBe(r);
  });

  it("dispatch of an ignored event returns the task unchanged", () => {
    const { reg } = setup();
    const a = reg.create(spec());
    const done = reg.dispatch(a.id, { type: "exit", code: 0, signal: null, at: 1 });
    expect(reg.dispatch(a.id, { type: "handoff", reason: "user", at: 2 })).toBe(done);
  });

  it("dispatch to an unknown id throws with cause and action", () => {
    const { reg } = setup();
    expect(() => reg.dispatch("bg5", { type: "pid", pid: 1 })).toThrow(/no task bg5.*create\(\)/s);
  });

  it("subscribers see applied and ignored events with the flag", () => {
    const { reg } = setup();
    const seen: [string, string, boolean][] = [];
    reg.subscribe((t, ev, applied) => seen.push([t.state, ev.type, applied]));
    const a = reg.create(spec());
    reg.dispatch(a.id, { type: "exit", code: 0, signal: null, at: 1 });
    reg.dispatch(a.id, { type: "handoff", reason: "user", at: 2 });
    expect(seen).toEqual([
      ["exited", "exit", true],
      ["exited", "handoff", false],
    ]);
  });

  it("unsubscribe stops delivery", () => {
    const { reg } = setup();
    let n = 0;
    const off = reg.subscribe(() => n++);
    const a = reg.create(spec());
    reg.dispatch(a.id, { type: "pid", pid: 1 });
    off();
    reg.dispatch(a.id, { type: "pid", pid: 2 });
    expect(n).toBe(1);
  });

  it("an event dispatched from a subscriber is applied at once but delivered in order to every subscriber", () => {
    const { reg } = setup();
    const a = reg.create(spec());
    const log1: string[] = [];
    const log2: string[] = [];
    reg.subscribe((t, ev) => {
      log1.push(ev.type);
      if (ev.type === "exit") {
        const re = reg.dispatch(t.id, { type: "notify_status", status: "pending" });
        expect(re.notifyStatus).toBe("pending"); // applied immediately
      }
    });
    reg.subscribe((_t, ev) => log2.push(ev.type));
    reg.dispatch(a.id, { type: "exit", code: 0, signal: null, at: 1 });
    expect(log1).toEqual(["exit", "notify_status"]);
    expect(log2).toEqual(["exit", "notify_status"]);
  });

  it("a throwing subscriber does not starve the others; the error surfaces after delivery", () => {
    const { reg } = setup();
    const a = reg.create(spec());
    const seen: TaskEvent["type"][] = [];
    reg.subscribe(() => { throw new Error("bad listener"); });
    reg.subscribe((_t, ev) => seen.push(ev.type));
    expect(() => reg.dispatch(a.id, { type: "pid", pid: 1 })).toThrow("bad listener");
    expect(seen).toEqual(["pid"]);
    expect(reg.get(a.id)?.pid).toBe(1);
    // the registry is still usable afterwards
    expect(() => reg.dispatch(a.id, { type: "pid", pid: 2 })).toThrow("bad listener");
    expect(seen).toEqual(["pid", "pid"]);
  });

  describe("isStale", () => {
    it("distinguishes an earlier run's id from an unknown one", () => {
      const { reg } = setup(5);
      const a = reg.create(spec()); // bg6
      expect(a.id).toBe("bg6");
      expect(reg.isStale("bg3")).toBe(true);
      expect(reg.isStale("bg5")).toBe(true);
      expect(reg.isStale("bg6")).toBe(false); // in the registry
      expect(reg.isStale("bg9")).toBe(false); // never issued: unknown
      expect(reg.isStale("nope")).toBe(false);
    });
    it("is false without a seed", () => {
      const reg = new TaskRegistry({ clock: new TestClock(), ids: { next: () => "bg1" } });
      expect(reg.isStale("bg1")).toBe(false);
    });
  });

  describe("summarize", () => {
    it("maps a finished task", () => {
      const { reg, clock } = setup();
      const a = reg.create(spec({ label: "build", notify: "error" }));
      reg.dispatch(a.id, { type: "pid", pid: 77 });
      reg.dispatch(a.id, { type: "output", bytes: 12, at: 1 });
      clock.t += 4_400;
      const done = reg.dispatch(a.id, { type: "exit", code: 2, signal: null, at: clock.t });
      clock.t += 60_000; // runtime of a finished task does not keep growing
      const s = reg.summarize(done, ["x", "y"]);
      expect(s).toEqual({
        id: "bg1", label: "build", command: "make", state: "exited",
        startedAt: new Date(1_700_000_000_000).toISOString(), runtimeS: 4,
        exitCode: 2, signal: null, pid: 77, totalBytes: 12, notify: "error",
        notified: false, logDegraded: false, lastLines: ["x", "y"],
      });
    });
    it("running tasks use the clock; optional fields are absent, not undefined", () => {
      const { reg, clock } = setup();
      const a = reg.create(spec());
      clock.t += 10_000;
      const s = reg.summarize(a);
      expect(s.runtimeS).toBe(10);
      for (const k of ["label", "exitCode", "signal", "pid", "logPath", "lastLines"]) expect(k in s).toBe(false);
    });
    it("cuts the command at 200 characters", () => {
      const { reg } = setup();
      const s = reg.summarize(reg.create(spec({ command: "x".repeat(500) })));
      expect(s.command).toHaveLength(200);
      expect(s.command.endsWith("…")).toBe(true);
      expect(reg.summarize(reg.create(spec({ command: "y".repeat(200) }))).command).toHaveLength(200);
    });
    it("notified is true only for sent and acked", () => {
      const { reg } = setup();
      const a = reg.create(spec());
      const flags: boolean[] = [];
      for (const status of ["pending", "sent", "acked"] as const) {
        flags.push(reg.summarize(reg.dispatch(a.id, { type: "notify_status", status })).notified);
      }
      expect(flags).toEqual([false, true, true]);
      const b = reg.create(spec());
      expect(reg.summarize(reg.dispatch(b.id, { type: "notify_status", status: "suppressed" })).notified).toBe(false);
    });
    it("carries logPath when set on the task", () => {
      const { reg } = setup();
      const t: Task = { ...reg.create(spec()), logPath: "/tmp/x.log" };
      expect(reg.summarize(t).logPath).toBe("/tmp/x.log");
    });
  });
});
