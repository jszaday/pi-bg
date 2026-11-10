import { describe, expect, it, vi } from "vitest";
import type { ProcessHandle } from "../../src/contract.js";
import { killTasks } from "../../src/pi/kill.js";
import { makeHarness } from "./w6a-services.js";

describe("killTasks", () => {
  it("sends one term, records the cause and reports killed", async () => {
    const h = makeHarness();
    const t = h.start("sleep 100");
    const r = await killTasks(h.s, [t.id], "bg_kill");
    expect(h.runner.kills).toEqual(["term"]);
    expect(r).toEqual({ killed: ["bg1"], alreadyFinished: [], failed: [] });
    await h.flush();
    expect(h.s.registry.get(t.id)).toMatchObject({ state: "killed", killCause: "bg_kill" });
    expect(h.s.runtime.has(t.id)).toBe(true); // cleanup belongs to the exit handler of W6b
  });
  it("cancels the task's runtime timers", async () => {
    const h = makeHarness();
    const t = h.start("sleep 100");
    const timer = h.clock.setTimeout(() => {}, 5000);
    h.s.runtime.get(t.id)!.timers.push(timer);
    await killTasks(h.s, "all", "command");
    expect(h.clock.pending()).toBe(0);
  });
  it("kills all running tasks and lists finished ones as already finished", async () => {
    const h = makeHarness();
    h.start("a", [{ at: 0, exit: { code: 0, signal: null } }]);
    h.start("b");
    h.start("c");
    await h.flush();
    const r = await killTasks(h.s, ["bg1", "bg2", "bg3"], "bg_kill");
    expect(r.alreadyFinished).toEqual(["bg1"]);
    expect(r.killed.sort()).toEqual(["bg2", "bg3"]);
    expect(h.runner.kills).toEqual(["term", "term"]);
    expect((await killTasks(h.s, "all", "bg_kill")).killed).toEqual([]);
  });
  it("reports unknown and stale ids as failed with cause and action", async () => {
    const h = makeHarness({ seed: 3 });
    const r = await killTasks(h.s, ["bg99", "bg2", "nope"], "bg_kill");
    expect(r.failed.map((f) => f.id)).toEqual(["bg99", "bg2", "nope"]);
    expect(r.failed[1].error).toContain("started before this session was resumed");
    expect(r.failed[0].error).toContain("No task bg99");
    expect(r.failed[0].error).toContain("Action");
  });
  it("is bounded: fails with pid and action when the process never exits, using the clock", async () => {
    const h = makeHarness();
    const t = h.s.registry.create({ command: "x", cwd: "/", hardTimeoutMs: null, bgTimeoutMs: null, notify: "done", startInBackground: true });
    const kill = vi.fn();
    const handle: ProcessHandle = { pid: 4242, exited: new Promise(() => {}), kill };
    h.s.runtime.set(t.id, { handle, tail: { push() {}, lines: () => [], partial: () => "", lastLine: () => undefined, totalBytes: () => 0 }, timers: [] });
    let done = false;
    const p = killTasks(h.s, [t.id], "shutdown").then((r) => ((done = true), r));
    await h.flush();
    expect(done).toBe(false);
    h.clock.advance(h.config.kill.termGraceMs + 1999);
    await h.flush();
    expect(done).toBe(false);
    h.clock.advance(1);
    const r = await p;
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith("term");
    expect(r.killed).toEqual([]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].error).toContain("4242");
    expect(r.failed[0].error).toContain("Action");
    expect(h.clock.pending()).toBe(0);
  });
  it("fails a running task that has no process handle", async () => {
    const h = makeHarness();
    const t = h.s.registry.create({ command: "x", cwd: "/", hardTimeoutMs: null, bgTimeoutMs: null, notify: "done", startInBackground: true });
    const r = await killTasks(h.s, [t.id], "bg_kill");
    expect(r.failed[0].error).toContain("no live process handle");
    expect(r.failed[0].error).not.toContain("unknown"); // no pid: the clause is omitted, not a placeholder
    expect(r.failed[0].error).toContain("Action: check whether it is still running");
    expect(h.s.registry.get(t.id)?.killCause).toBeUndefined();
  });
});
