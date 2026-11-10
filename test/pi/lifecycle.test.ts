import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskId } from "../../src/contract.js";
import { installLifecycle, killAll, shutdownBoundMs, type LifecycleDeps } from "../../src/pi/lifecycle.js";
import { FakePi } from "../fakes/index.js";
import { w8Ctx, w8Services, w8Task } from "./w8-helpers.js";

const killTasksMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/pi/kill.js", () => ({ killTasks: killTasksMock }));

function setup(over: Partial<LifecycleDeps> = {}, owner?: string) {
  const h = w8Services();
  const pi = new FakePi();
  const api = pi.asExtensionAPI();
  (api as unknown as { getAllTools: () => unknown[] }).getAllTools = () => (owner ? [{ name: "bash", sourceInfo: { path: owner } }] : []);
  const calls = { reseed: [] as number[], config: 0, keyInstalls: 0, keyUnsub: 0, uiStart: 0, uiDispose: 0, move: [] as unknown[] };
  const proc = { listeners: new Set<() => void>(), on(_e: "exit", fn: () => void) { this.listeners.add(fn); }, off(_e: "exit", fn: () => void) { this.listeners.delete(fn); } };
  const groups: number[] = [];
  const handoff = vi.fn((): TaskId[] => ["bg1"]);
  const deps: LifecycleDeps = {
    reseed: (n) => calls.reseed.push(n),
    setConfig: () => { calls.config++; },
    bash: () => ({ handoffAllMovable: handoff }),
    installKey: (_ctx, k) => { calls.keyInstalls++; calls.move.push(k.move); return () => { calls.keyUnsub++; }; },
    ui: { onSessionStart: () => { calls.uiStart++; }, dispose: () => { calls.uiDispose++; } },
    ownPath: "/opt/pi-bg/src/index.ts",
    platform: "linux",
    proc,
    killGroup: (g) => groups.push(g),
    ...over,
  };
  const lc = installLifecycle(api, h.s, deps);
  return { h, pi, calls, proc, groups, handoff, lc };
}

const start = (x: ReturnType<typeof setup>, ctx: Record<string, unknown> = {}) =>
  x.pi.emit("session_start", { type: "session_start", reason: "startup" }, w8Ctx(x.pi, { isProjectTrusted: () => false, ...ctx }));

beforeEach(() => {
  killTasksMock.mockReset();
  killTasksMock.mockResolvedValue({ killed: [], alreadyFinished: [], failed: [] });
});

describe("session_start", () => {
  it("sets ctx, reseeds ids from tool results and custom messages, runs GC, installs key and UI", async () => {
    const x = setup();
    const gc = vi.spyOn(x.h.logs, "gc");
    const branch = [
      { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "Moved to background as bg3" }] } },
      { type: "message", message: { role: "toolResult", content: [], details: { id: "bg7" } } },
      { type: "message", message: { role: "user", content: "bg99 is in a user message" } },
      { type: "custom_message", customType: "pi-bg:task", content: "bg5 done", display: true },
    ];
    await start(x, { sessionManager: { getBranch: () => branch } });
    expect(x.h.s.ctx.current).toBeDefined();
    expect(x.calls.reseed).toEqual([7]); // user message ignored
    expect(gc).toHaveBeenCalledWith(7 * 86_400_000);
    expect(x.calls.keyInstalls).toBe(1);
    expect(x.calls.uiStart).toBe(1);
    expect(x.calls.config).toBe(1);
    expect(x.proc.listeners.size).toBe(1);
    expect(x.lc.inactiveReason()).toBeUndefined();
  });

  it("the key's move callback hands off all movable tasks as reason user", async () => {
    const x = setup();
    await start(x);
    expect(x.calls.move.length).toBe(1);
    expect((x.calls.move[0] as () => TaskId[])()).toEqual(["bg1"]);
    expect(x.handoff).toHaveBeenCalledWith("user");
  });

  it("surfaces config warnings and survives a throwing GC", async () => {
    const x = setup();
    vi.spyOn(x.h.logs, "gc").mockRejectedValue(new Error("disk"));
    await start(x);
    expect(x.h.uiCalls.some((c) => c.msg.includes("log cleanup failed") && c.level === "warning")).toBe(true);
    expect(x.calls.keyInstalls).toBe(1);
  });

  it("warns and goes inactive when another extension owns bash; the answer names the owner", async () => {
    const x = setup({}, "/other/ext/index.ts");
    await start(x);
    expect(x.h.uiCalls.some((c) => c.msg.includes("/other/ext/index.ts") && c.msg.includes("Action:"))).toBe(true);
    expect(x.lc.inactiveReason()).toContain("pi-bg is inactive");
    expect(x.lc.inactiveReason()).toContain("/other/ext/index.ts");
  });

  it("stays active when bash is owned by pi-bg itself, or the owner is unknown (negative controls)", async () => {
    const own = setup({}, "/opt/pi-bg/src/index.ts");
    await start(own);
    expect(own.lc.inactiveReason()).toBeUndefined();
    expect(own.h.uiCalls.filter((c) => c.msg.includes("bash is registered"))).toHaveLength(0);
    const none = setup({ ownPath: undefined }, "/other/x.ts");
    await start(none);
    expect(none.lc.inactiveReason()).toBeUndefined();
  });

  it("treats an inline-factory owner path (`<inline:N>`) as ours, but not a real path", async () => {
    const inline = setup({}, "<inline:1>");
    await start(inline);
    expect(inline.lc.inactiveReason()).toBeUndefined();
    expect(inline.h.uiCalls.filter((c) => c.msg.includes("bash is registered"))).toHaveLength(0);
    const other = setup({}, "/other/ext/index.ts");
    await start(other);
    expect(other.lc.inactiveReason()).toContain("pi-bg is inactive");
  });

  it("is inactive on Windows with the unsupported-platform message and installs no key, GC or backstop", async () => {
    const x = setup({ platform: "win32" });
    const gc = vi.spyOn(x.h.logs, "gc");
    await start(x);
    expect(x.lc.inactiveReason()).toContain("Windows");
    expect(x.h.uiCalls[0].msg).toContain("Windows");
    expect(x.calls.keyInstalls).toBe(0);
    expect(gc).not.toHaveBeenCalled();
    expect(x.proc.listeners.size).toBe(0);
  });
});

describe("session_shutdown", () => {
  for (const reason of ["quit", "reload", "new", "resume", "fork"]) {
    it(`kills all tasks, tears down and removes the exit backstop on ${reason}`, async () => {
      const x = setup();
      await start(x);
      const t = w8Task(x.h);
      const timer = x.h.clock.setTimeout(() => {}, 1000);
      x.h.s.runtime.get(t.id)!.timers.push(timer);
      const closed = vi.fn(async () => {});
      x.h.s.runtime.get(t.id)!.log = { close: closed, write() {}, path: "p", degraded: null };
      await x.pi.emit("session_shutdown", { type: "session_shutdown", reason });
      expect(killTasksMock).toHaveBeenCalledWith(x.h.s, "all", "shutdown");
      expect(closed).toHaveBeenCalledTimes(1);
      expect(x.h.clock.pending()).toBe(0);
      expect(x.calls.uiDispose).toBe(1);
      expect(x.calls.keyUnsub).toBe(1);
      expect(x.proc.listeners.size).toBe(0);
      expect(x.h.s.ctx.current).toBeUndefined();
    });
  }

  it("discards a pending notification instead of sending it, and cancels the batching timer", async () => {
    const x = setup();
    await start(x);
    const t = w8Task(x.h);
    x.h.registry.dispatch(t.id, { type: "exit", code: 0, signal: null, at: 0 });
    expect(x.h.registry.get(t.id)!.notifyStatus).toBe("pending");
    await x.pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    x.h.clock.advance(10_000);
    expect(x.h.sink.sent).toHaveLength(0);
    expect(x.h.registry.get(t.id)!.notifyStatus).toBe("suppressed");
  });

  it("is idempotent: a second shutdown does not kill again", async () => {
    const x = setup();
    await start(x);
    await x.pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    await x.pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    expect(killTasksMock).toHaveBeenCalledTimes(1);
  });

  it("is bounded at 5 s when killTasks never resolves, then SIGKILLs the stragglers and warns", async () => {
    killTasksMock.mockReturnValue(new Promise(() => {}));
    const x = setup();
    await start(x);
    const t = w8Task(x.h);
    x.h.registry.dispatch(t.id, { type: "pid", pid: 4242 });
    const kill = vi.fn();
    x.h.s.runtime.get(t.id)!.handle = { exited: new Promise(() => {}), kill };
    let done = false;
    const bound = shutdownBoundMs(x.h.s);
    expect(bound).toBe(6000); // derived from kill.termGraceMs (3000)
    const p = x.pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }).then(() => { done = true; });
    await Promise.resolve();
    x.h.clock.advance(bound - 1);
    await Promise.resolve();
    expect(done).toBe(false);
    x.h.clock.advance(1);
    await p;
    expect(done).toBe(true);
    expect(kill).toHaveBeenCalledWith("kill");
    expect(x.groups).toEqual([4242]);
    expect(x.h.uiCalls.some((c) => c.msg.includes("6 s of shutdown") && c.msg.includes("pid 4242") && c.msg.includes("Action:") && c.level === "warning")).toBe(true);
    expect(x.h.uiCalls.some((c) => c.msg.includes("see bg_status"))).toBe(false);
  });

  it("the bound scales with kill.termGraceMs", () => {
    const h = w8Services({ config: { kill: { termGraceMs: 9000 } } });
    expect(shutdownBoundMs(h.s)).toBe(16_000);
  });

  it("surfaces killTasks' failed entries via ui.notify", async () => {
    killTasksMock.mockResolvedValue({ killed: [], alreadyFinished: [], failed: [{ id: "bg1", error: "Could not stop bg1: x. Action: y." }] });
    const x = setup();
    await start(x);
    await x.pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    expect(x.h.uiCalls).toContainEqual({ msg: "Could not stop bg1: x. Action: y.", level: "warning" });
  });

  it("a failing killTasks is reported with cause and action, and shutdown still completes", async () => {
    killTasksMock.mockRejectedValue(new Error("boom"));
    const x = setup();
    await start(x);
    await x.pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    expect(x.h.uiCalls.some((c) => c.msg.includes("boom") && c.msg.includes("Action:"))).toBe(true);
    expect(x.calls.uiDispose).toBe(1);
  });

  it("killAll alone is idempotent per Services", async () => {
    const h = w8Services();
    await killAll(h.s, () => {});
    await killAll(h.s, () => {});
    expect(killTasksMock).toHaveBeenCalledTimes(1);
  });

  it("a new session_start re-arms shutdown", async () => {
    const x = setup();
    await start(x);
    await x.pi.emit("session_shutdown", { type: "session_shutdown", reason: "new" });
    await start(x);
    await x.pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    expect(killTasksMock).toHaveBeenCalledTimes(2);
  });
});

describe("process exit backstop", () => {
  it("synchronously SIGKILLs groups of running tasks only", async () => {
    const x = setup();
    await start(x);
    const running = w8Task(x.h);
    x.h.registry.dispatch(running.id, { type: "pid", pid: 111 });
    const done = w8Task(x.h);
    x.h.registry.dispatch(done.id, { type: "pid", pid: 222 });
    x.h.registry.dispatch(done.id, { type: "exit", code: 0, signal: null, at: 0 });
    for (const fn of [...x.proc.listeners]) fn();
    expect(x.groups).toEqual([111]);
  });
});
