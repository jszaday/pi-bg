import { describe, expect, it } from "vitest";
import type { Task, TaskEvent, TaskId } from "../../src/contract.js";
import { createIdAllocator } from "../../src/core/ids.js";
import { TaskRegistry } from "../../src/core/registry.js";
import { FakeClock } from "../fakes/index.js";
import { WaitCoordinator } from "../../src/core/wait.js";

// Real W1 registry, wrapped to create tasks with expected sequential ids and end them by state.
class Reg extends TaskRegistry {
  constructor(clock: FakeClock) { super({ clock, ids: createIdAllocator() }); }
  add(id: string, state: Task["state"] = "background"): Task {
    const t = this.create({ command: "x", cwd: "/", hardTimeoutMs: null, bgTimeoutMs: null, notify: "done", startInBackground: state !== "foreground" });
    if (t.id !== id) throw new Error(`test expected ${id}, registry allocated ${t.id}`);
    return state === "background" || state === "foreground" ? t : this.end(id, state);
  }
  end(id: TaskId, state: Task["state"] = "exited"): Task {
    if (state === "killed") this.dispatch(id, { type: "kill_requested", cause: "bg_kill", at: 0 });
    if (state === "timed_out") this.dispatch(id, { type: "hard_timeout", at: 0 });
    if (state === "spawn_failed") return this.dispatch(id, { type: "spawn_failed", error: "e", at: 0 });
    return this.dispatch(id, exitEv);
  }
}
const exitEv: TaskEvent = { type: "exit", code: 0, signal: null, at: 0 };

// wire=false: the registry changes state but the coordinator never sees the event
// (used to prove the release-time re-check).
function setup(confirm: () => boolean | undefined = () => undefined, opts: { maxWaitMs?: number; wire?: boolean } = {}) {
  const clock = new FakeClock();
  const reg = new Reg(clock);
  const w = new WaitCoordinator({ clock, registry: reg, maxWaitMs: opts.maxWaitMs ?? 3_600_000, confirmQueued: () => confirm() });
  if (opts.wire !== false) reg.subscribe((t, ev, applied) => w.onTaskEvent(t, ev, applied));
  const finishTask = (id: string, state: Task["state"] = "exited") => { reg.end(id, state); };
  return { clock, reg, w, finishTask };
}
const settled = <T,>(p: Promise<T>) => { let r: { v: T } | undefined; void p.then((v) => { r = { v }; }); return () => r?.v; };
const flush = () => Promise.resolve().then(() => undefined).then(() => undefined);

describe("WaitCoordinator release reasons", () => {
  it("no_tasks: nothing running, or only unknown ids", async () => {
    const { w } = setup();
    expect((await w.wait({ mode: "any", timeoutMs: 1000 }, undefined)).reason).toBe("no_tasks");
    expect((await w.wait({ ids: ["bg9"], mode: "any", timeoutMs: 1000 }, undefined)).reason).toBe("no_tasks");
  });
  it("default ids are the running background tasks only (not foreground, not finished)", async () => {
    const { w, reg, finishTask, clock } = setup();
    reg.add("bg1"); reg.add("bg2", "foreground"); reg.add("bg3", "exited");
    const res = settled(w.wait({ mode: "any", timeoutMs: 5000 }, undefined));
    expect(w.activeWaitIds()).toEqual(["bg1"]);
    finishTask("bg1");
    await flush();
    expect(res()!.reason).toBe("finished");
    expect(clock.pending()).toBe(0);
  });
  it("finished: a listed task ends; tasks are returned with their final state", async () => {
    const { w, reg, finishTask } = setup();
    reg.add("bg1");
    const res = settled(w.wait({ ids: ["bg1"], mode: "any", timeoutMs: 5000 }, undefined));
    finishTask("bg1", "killed");
    await flush();
    expect(res()).toMatchObject({ reason: "finished", tasks: [{ id: "bg1", state: "killed" }] });
  });
  it("finished immediately when a listed task is already terminal", async () => {
    const { w, reg } = setup();
    reg.add("bg1", "exited");
    expect(await w.wait({ ids: ["bg1"], mode: "any", timeoutMs: 5000 }, undefined)).toMatchObject({ reason: "finished", waitedMs: 0 });
  });
  it("timeout: fires at timeoutMs with waitedMs, tasks still running", async () => {
    const { w, reg, clock } = setup();
    reg.add("bg1");
    const res = settled(w.wait({ ids: ["bg1"], mode: "any", timeoutMs: 1000 }, undefined));
    clock.advance(999); await flush();
    expect(res()).toBeUndefined();
    clock.advance(1); await flush();
    expect(res()).toMatchObject({ reason: "timeout", waitedMs: 1000 });
    expect(res()!.tasks[0].state).toBe("background");
  });
  it("timeout is clamped to maxWaitMs; Infinity clamps, zero/negative/NaN time out at once", async () => {
    const { w, reg, clock } = setup(undefined, { maxWaitMs: 2000 });
    reg.add("bg1");
    const res = settled(w.wait({ ids: ["bg1"], mode: "any", timeoutMs: 999_999 }, undefined));
    clock.advance(1999); await flush();
    expect(res()).toBeUndefined();
    clock.advance(1); await flush();
    expect(res()).toMatchObject({ reason: "timeout", waitedMs: 2000 });
    const inf = settled(w.wait({ ids: ["bg1"], mode: "any", timeoutMs: Infinity }, undefined));
    clock.advance(2000); await flush();
    expect(inf()!.reason).toBe("timeout");
    for (const ms of [0, -5, Number.NaN]) {
      expect(await w.wait({ ids: ["bg1"], mode: "any", timeoutMs: ms }, undefined)).toMatchObject({ reason: "timeout", waitedMs: 0 });
    }
  });
  it("aborted: signal releases the wait and leaves tasks running; listener and timers are cleaned", async () => {
    const { w, reg, clock } = setup();
    reg.add("bg1");
    const ac = new AbortController();
    const res = settled(w.wait({ ids: ["bg1"], mode: "any", timeoutMs: 5000 }, ac.signal));
    clock.advance(10);
    ac.abort(); await flush();
    expect(res()).toMatchObject({ reason: "aborted", waitedMs: 10 });
    expect(reg.get("bg1")!.state).toBe("background");
    expect(clock.pending()).toBe(0);
    expect(w.activeWaitIds()).toEqual([]);
  });
  it("aborted: an already-aborted signal returns at once", async () => {
    const { w, reg } = setup();
    reg.add("bg1");
    const ac = new AbortController(); ac.abort();
    expect((await w.wait({ ids: ["bg1"], mode: "any", timeoutMs: 5000 }, ac.signal)).reason).toBe("aborted");
  });
});

describe("any versus all", () => {
  it("any releases on the first end; all waits for every listed task", async () => {
    const { w, reg, finishTask } = setup();
    reg.add("bg1"); reg.add("bg2");
    const any = settled(w.wait({ ids: ["bg1", "bg2"], mode: "any", timeoutMs: 5000 }, undefined));
    const all = settled(w.wait({ ids: ["bg1", "bg2"], mode: "all", timeoutMs: 5000 }, undefined));
    finishTask("bg1"); await flush();
    expect(any()!.reason).toBe("finished");
    expect(all()).toBeUndefined();
    finishTask("bg2"); await flush();
    expect(all()).toMatchObject({ reason: "finished" });
    expect(all()!.tasks.map((t) => t.id)).toEqual(["bg1", "bg2"]);
  });
  it("an unapplied event does not release a wait", async () => {
    const { w, reg, finishTask } = setup();
    const t = reg.add("bg1");
    const res = settled(w.wait({ ids: ["bg1"], mode: "any", timeoutMs: 5000 }, undefined));
    w.onTaskEvent(t, { type: "output", bytes: 1, at: 0 }, false); await flush();
    expect(res()).toBeUndefined();
    finishTask("bg1"); await flush();
    expect(res()!.reason).toBe("finished");
  });
});

describe("user message release (confirmQueued rule)", () => {
  it.each([[true], [undefined]])("releases at 50 ms, not earlier, when confirmQueued is %s", async (c) => {
    const { w, reg, clock } = setup(() => c as boolean | undefined);
    reg.add("bg1");
    const res = settled(w.wait({ ids: ["bg1"], mode: "any", timeoutMs: 5000 }, undefined));
    clock.advance(100);
    w.onUserMessage();
    clock.advance(49); await flush();
    expect(res()).toBeUndefined();
    clock.advance(1); await flush();
    expect(res()).toMatchObject({ reason: "user_message", waitedMs: 150 });
    expect(reg.get("bg1")!.state).toBe("background");
  });
  it("when confirmQueued keeps returning false, releases at 250 ms, polling every 25 ms", async () => {
    const calls: number[] = [];
    const ref: { clock?: FakeClock } = {};
    const { w, reg, clock } = setup(() => { calls.push(ref.clock!.now()); return false; });
    ref.clock = clock;
    reg.add("bg1");
    const res = settled(w.wait({ ids: ["bg1"], mode: "any", timeoutMs: 5000 }, undefined));
    w.onUserMessage();
    clock.advance(249); await flush();
    expect(res()).toBeUndefined();
    clock.advance(1); await flush();
    expect(res()).toMatchObject({ reason: "user_message", waitedMs: 250 });
    expect(calls).toEqual([50, 75, 100, 125, 150, 175, 200, 225, 250]);
    expect(clock.pending()).toBe(0);
  });
  it("releases as soon as confirmQueued turns true after the settle point", async () => {
    let ok = false;
    const { w, reg, clock } = setup(() => ok);
    reg.add("bg1");
    const res = settled(w.wait({ ids: ["bg1"], mode: "any", timeoutMs: 5000 }, undefined));
    w.onUserMessage();
    clock.advance(60); ok = true; await flush();
    expect(res()).toBeUndefined();
    clock.advance(15); await flush(); // check at 75
    expect(res()).toMatchObject({ reason: "user_message", waitedMs: 75 });
  });
  it("honors custom queueSettleMs and queueMaxMs", async () => {
    const clock = new FakeClock(); const reg = new Reg(clock); reg.add("bg1");
    const w = new WaitCoordinator({ clock, registry: reg, maxWaitMs: 9999, queueSettleMs: 10, queueMaxMs: 40, confirmQueued: () => false });
    const res = settled(w.wait({ ids: ["bg1"], mode: "any", timeoutMs: 5000 }, undefined));
    w.onUserMessage();
    clock.advance(39); await flush();
    expect(res()).toBeUndefined();
    clock.advance(1); await flush();
    expect(res()).toMatchObject({ reason: "user_message", waitedMs: 40 });
  });
  it("a second message does not restart the timeline; a message with no active wait is ignored", async () => {
    const { w, reg, clock } = setup(() => true);
    w.onUserMessage(); // nothing active: no effect, no timers
    expect(clock.pending()).toBe(0);
    reg.add("bg1");
    const res = settled(w.wait({ ids: ["bg1"], mode: "any", timeoutMs: 5000 }, undefined));
    w.onUserMessage();
    clock.advance(30);
    w.onUserMessage();
    clock.advance(20); await flush();
    expect(res()).toMatchObject({ reason: "user_message", waitedMs: 50 });
    // a message that came before a later wait does not release it
    const later = settled(w.wait({ ids: ["bg1"], mode: "any", timeoutMs: 5000 }, undefined));
    clock.advance(1000); await flush();
    expect(later()).toBeUndefined();
  });
  it("applies to every active wait", async () => {
    const { w, reg, clock } = setup(() => true);
    reg.add("bg1"); reg.add("bg2");
    const a = settled(w.wait({ ids: ["bg1"], mode: "any", timeoutMs: 5000 }, undefined));
    const b = settled(w.wait({ ids: ["bg2"], mode: "all", timeoutMs: 5000 }, undefined));
    w.onUserMessage(); clock.advance(50); await flush();
    expect(a()!.reason).toBe("user_message");
    expect(b()!.reason).toBe("user_message");
  });
});

describe("tie-breaks and races (finished wins)", () => {
  it("a task ending during the settle window yields finished, not user_message", async () => {
    const { w, reg, clock, finishTask } = setup(() => true);
    reg.add("bg1");
    const res = settled(w.wait({ ids: ["bg1"], mode: "any", timeoutMs: 5000 }, undefined));
    w.onUserMessage();
    clock.advance(20); finishTask("bg1"); await flush();
    expect(res()!.reason).toBe("finished");
    clock.advance(100); await flush(); // stale settle timer must not fire anything
    expect(clock.pending()).toBe(0);
  });
  it("simultaneous finish and user message at the release instant: finished wins even if the event was missed", async () => {
    const { w, reg, clock } = setup(() => true, { wire: false });
    reg.add("bg1");
    const res = settled(w.wait({ ids: ["bg1"], mode: "any", timeoutMs: 5000 }, undefined));
    w.onUserMessage();
    reg.end("bg1"); // state changed, but the event has not reached the coordinator yet
    clock.advance(50); await flush();
    expect(res()).toMatchObject({ reason: "finished", tasks: [{ state: "exited" }] });
  });
  it("finish at the same instant as the timeout or an abort also wins", async () => {
    const { w, reg, clock } = setup(undefined, { wire: false });
    reg.add("bg1"); reg.add("bg2");
    const t = settled(w.wait({ ids: ["bg1"], mode: "any", timeoutMs: 100 }, undefined));
    const ac = new AbortController();
    const a = settled(w.wait({ ids: ["bg2"], mode: "any", timeoutMs: 5000 }, ac.signal));
    reg.end("bg1"); reg.end("bg2");
    clock.advance(100); ac.abort(); await flush();
    expect(t()!.reason).toBe("finished");
    expect(a()!.reason).toBe("finished");
  });
  it("negative control: the same race with the task still running yields user_message", async () => {
    const { w, reg, clock } = setup(() => true);
    reg.add("bg1");
    const res = settled(w.wait({ ids: ["bg1"], mode: "any", timeoutMs: 5000 }, undefined));
    w.onUserMessage(); clock.advance(50); await flush();
    expect(res()!.reason).toBe("user_message");
  });
});

describe("activeWaitIds", () => {
  it("lists distinct ids of active waits and empties on release", async () => {
    const { w, reg, finishTask } = setup();
    reg.add("bg1"); reg.add("bg2");
    expect(w.activeWaitIds()).toEqual([]);
    void w.wait({ ids: ["bg1", "bg2"], mode: "all", timeoutMs: 5000 }, undefined);
    void w.wait({ ids: ["bg2"], mode: "any", timeoutMs: 5000 }, undefined);
    expect(w.activeWaitIds().sort()).toEqual(["bg1", "bg2"]);
    finishTask("bg2"); await flush(); // the `any` wait on bg2 is released; the `all` wait stays
    expect(w.activeWaitIds().sort()).toEqual(["bg1", "bg2"]);
    finishTask("bg1"); await flush();
    expect(w.activeWaitIds()).toEqual([]);
  });
});
