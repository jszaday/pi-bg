import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { ExitInfo, ProcessHandle } from "../../src/contract.js";
import { FakeClock, FakeNotificationSink, FakePi, FakeRunner, MemLogStore } from "./index.js";

// Asserts that a process ended with the expected exit code. Used by the runner
// self-tests and by the negative control below.
async function expectExitCode(handle: ProcessHandle, expected: number): Promise<void> {
  const info: ExitInfo = await handle.exited;
  if (info.code !== expected) {
    throw new Error(`expected exit code ${expected}, got ${info.code} (signal ${info.signal})`);
  }
}

describe("FakeClock", () => {
  it("fires timers in due order and ties in arm order", () => {
    const clock = new FakeClock();
    const order: string[] = [];
    clock.setTimeout(() => order.push("c@30"), 30);
    clock.setTimeout(() => order.push("a@10"), 10);
    clock.setTimeout(() => order.push("b@10"), 10);
    clock.advance(30);
    expect(order).toEqual(["a@10", "b@10", "c@30"]);
    expect(clock.now()).toBe(30);
    expect(clock.pending()).toBe(0);
  });

  it("leaves timers beyond the window armed", () => {
    const clock = new FakeClock();
    let fired = false;
    clock.setTimeout(() => (fired = true), 100);
    clock.advance(99);
    expect(fired).toBe(false);
    expect(clock.pending()).toBe(1);
    clock.advance(1);
    expect(fired).toBe(true);
  });

  it("fires a timer armed inside a callback when it falls inside the window", () => {
    const clock = new FakeClock();
    const seen: number[] = [];
    clock.setTimeout(() => {
      seen.push(clock.now());
      clock.setTimeout(() => seen.push(clock.now()), 5);
    }, 10);
    clock.advance(20);
    expect(seen).toEqual([10, 15]);
  });

  it("does not fire cleared timers", () => {
    const clock = new FakeClock();
    let fired = false;
    const h = clock.setTimeout(() => (fired = true), 5);
    clock.clearTimeout(h);
    clock.advance(10);
    expect(fired).toBe(false);
    expect(clock.pending()).toBe(0);
  });

  it("rejects a negative advance with the cause and the fix", () => {
    expect(() => new FakeClock().advance(-1)).toThrow(/non-negative.*delta/);
  });
});

describe("FakeRunner", () => {
  it("delivers scripted chunks with their stream and the exit code", async () => {
    const runner = new FakeRunner();
    const got: { text: string; stream: string }[] = [];
    runner.script([
      { at: 0, chunk: "hello", stream: "stdout" },
      { at: 0, chunk: "oops", stream: "stderr" },
      { at: 0, exit: { code: 0, signal: null } },
    ]);
    const h = runner.start({ command: "echo hi", cwd: "/tmp" }, (c, s) =>
      got.push({ text: new TextDecoder().decode(c), stream: s }),
    );
    expect(got).toEqual([
      { text: "hello", stream: "stdout" },
      { text: "oops", stream: "stderr" },
    ]);
    await expectExitCode(h, 0);
    expect(runner.started).toEqual([{ command: "echo hi", cwd: "/tmp" }]);
  });

  it("fires delayed steps on the clock and ignores output after exit", async () => {
    const clock = new FakeClock();
    const runner = new FakeRunner({}, clock);
    const chunks: string[] = [];
    runner.script([
      { at: 10, chunk: "a" },
      { at: 20, exit: { code: 3, signal: null } },
      { at: 30, chunk: "late" },
    ]);
    const h = runner.start({ command: "x", cwd: "/" }, (c) => chunks.push(new TextDecoder().decode(c)));
    clock.advance(20);
    expect(chunks).toEqual(["a"]);
    await expectExitCode(h, 3);
    clock.advance(10);
    expect(chunks).toEqual(["a"]);
  });

  it("refuses a delayed step without a clock, with the fix", () => {
    expect(() => new FakeRunner().script([{ at: 5, chunk: "x" }])).toThrow(/needs a clock/);
  });

  it("records kills; term ends with SIGTERM when graceful, SIGKILL when not", async () => {
    const graceful = new FakeRunner();
    graceful.script([]);
    const g = graceful.start({ command: "sleep", cwd: "/" }, () => {});
    g.kill("term");
    expect(await g.exited).toEqual({ code: null, signal: "SIGTERM" });
    expect(graceful.kills).toEqual(["term"]);

    const hard = new FakeRunner({ gracefulTerm: false });
    const h = hard.start({ command: "sleep", cwd: "/" }, () => {});
    h.kill("term");
    expect(await h.exited).toEqual({ code: null, signal: "SIGKILL" });
  });

  it("any signal ends with its own SIG name when graceful, SIGKILL when not", async () => {
    const graceful = new FakeRunner();
    graceful.script([]);
    const g = graceful.start({ command: "sleep", cwd: "/" }, () => {});
    g.kill("usr1");
    expect(await g.exited).toEqual({ code: null, signal: "SIGUSR1" });
    expect(graceful.kills).toEqual(["usr1"]);
    const hard = new FakeRunner({ gracefulTerm: false });
    const h = hard.start({ command: "sleep", cwd: "/" }, () => {});
    h.kill("int");
    expect(await h.exited).toEqual({ code: null, signal: "SIGKILL" });
  });

  it("consumes one script per start and reports pid when the capability is on", () => {
    const runner = new FakeRunner();
    runner.script([{ at: 0, chunk: "first", exit: { code: 0, signal: null } }]);
    runner.script([{ at: 0, chunk: "second", exit: { code: 0, signal: null } }]);
    const seen: string[] = [];
    const a = runner.start({ command: "a", cwd: "/" }, (c) => seen.push(new TextDecoder().decode(c)));
    const b = runner.start({ command: "b", cwd: "/" }, (c) => seen.push(new TextDecoder().decode(c)));
    expect(seen).toEqual(["first", "second"]);
    expect(typeof a.pid).toBe("number");
    expect(a.pid).not.toBe(b.pid);
  });

  // Negative control: a runner scripted with exit code 1 must make the check for code 0 fail.
  // If this test passes while the check would have passed, the check itself is broken.
  it("negative control: a wrongly scripted runner fails the exit check", async () => {
    const runner = new FakeRunner();
    runner.script([{ at: 0, exit: { code: 1, signal: null } }]);
    const h = runner.start({ command: "false", cwd: "/" }, () => {});
    await expect(expectExitCode(h, 0)).rejects.toThrow(/expected exit code 0, got 1/);
  });
});

describe("MemLogStore", () => {
  it("keeps writes per task in order and reads them back by offset", async () => {
    const store = new MemLogStore();
    const w = store.open("bg1") as Exclude<ReturnType<MemLogStore["open"]>, { error: string }>;
    w.write(new TextEncoder().encode("abc"), "stdout");
    w.write(new TextEncoder().encode("def"), "stderr");
    expect(store.contents("bg1")).toBe("abcdef");
    expect(store.contents("bg2")).toBe("");
    const r = await store.read("bg1", "combined", 2, 2);
    expect(r).toMatchObject({ nextOffset: 4, totalBytes: 6 });
  });

  it("fails the next open once, then recovers", () => {
    const store = new MemLogStore();
    store.failNextOpen("EACCES: permission denied");
    expect(store.open("bg1")).toEqual({ error: "EACCES: permission denied" });
    expect(store.open("bg1")).toHaveProperty("path");
  });

  it("degrades writers and drops later chunks after failWrites", () => {
    const store = new MemLogStore();
    const w = store.open("bg1") as Exclude<ReturnType<MemLogStore["open"]>, { error: string }>;
    store.failWrites("ENOSPC: no space left");
    w.write(new TextEncoder().encode("lost"), "combined");
    expect(w.degraded).toBe("ENOSPC: no space left");
    expect(store.contents("bg1")).toBe("");
  });
});

describe("FakeNotificationSink", () => {
  it("records each batch with its delivery options", () => {
    const sink = new FakeNotificationSink();
    const batch = { items: [], redelivery: false };
    sink.send(batch, { deliverAs: "steer", triggerTurn: true });
    expect(sink.sent).toEqual([{ batch, opts: { deliverAs: "steer", triggerTurn: true } }]);
  });
});

describe("FakePi", () => {
  const echo = {
    name: "echo",
    parameters: Type.Object({ n: Type.Number() }),
    execute: async (_id: string, params: { n: number }) => ({
      content: [{ type: "text" as const, text: String(params.n) }],
      details: { doubled: params.n * 2 },
    }),
  };

  it("registers tools and runs them through callTool", async () => {
    const pi = new FakePi();
    pi.asExtensionAPI().registerTool(echo as never);
    const r = await pi.callTool("echo", { n: 2 });
    expect(r.details).toEqual({ doubled: 4 });
    expect(r.content[0]).toEqual({ type: "text", text: "2" });
  });

  it("rejects an unknown tool and lists the registered ones", async () => {
    const pi = new FakePi();
    pi.registerTool(echo as never);
    await expect(pi.callTool("nope", {})).rejects.toThrow(/no tool "nope"; registered tools: echo/);
  });

  it("rejects params that fail the tool schema", async () => {
    const pi = new FakePi();
    pi.registerTool(echo as never);
    await expect(pi.callTool("echo", { n: "two" })).rejects.toThrow(/params for tool "echo" fail its schema/);
  });

  it("rejects a duplicate tool registration", () => {
    const pi = new FakePi();
    pi.registerTool(echo as never);
    expect(() => pi.registerTool(echo as never)).toThrow(/registered twice/);
  });

  it("emit runs handlers in order and returns their results; unsubscribe removes one", async () => {
    const pi = new FakePi();
    const api = pi.asExtensionAPI();
    api.on("input" as never, (() => "first") as never);
    const off = api.on("input" as never, (() => "second") as never);
    expect(await pi.emit("input", {})).toEqual(["first", "second"]);
    off();
    expect(await pi.emit("input", {})).toEqual(["first"]);
  });

  it("typeKey reports whether a listener consumed the key", () => {
    const pi = new FakePi();
    const seen: string[] = [];
    const off = pi.ui.onTerminalInput((d) => {
      seen.push(d);
      return d === "\x02" ? { consume: true } : undefined;
    });
    expect(pi.ui.typeKey("\x02")).toBe(true);
    expect(pi.ui.typeKey("x")).toBe(false);
    expect(seen).toEqual(["\x02", "x"]);
    off();
    expect(pi.ui.typeKey("\x02")).toBe(false);
  });

  it("ctx.hasPendingMessages follows pendingMessages", async () => {
    const pi = new FakePi();
    const flags: boolean[] = [];
    pi.asExtensionAPI().on("input" as never, ((_p: unknown, ctx: { hasPendingMessages(): boolean }) => {
      flags.push(ctx.hasPendingMessages());
    }) as never);
    await pi.emit("input", {});
    pi.pendingMessages = 2;
    await pi.emit("input", {});
    expect(flags).toEqual([false, true]);
  });
});
