import { describe, expect, it, vi } from "vitest";
import { registerBashTool } from "../../src/pi/bash-tool.js";
import { FakePi } from "../fakes/index.js";
import { w6bCtx, w6bEnv, w6bFlush, type W6bEnv } from "./w6b-helpers.js";

// W6a owns the real result mapper; a stub keeps these tests independent of its body.
vi.mock("../../src/pi/results.js", () => ({
  toBashHandoffResult: (task: { id: string }, tail: string[], reason: string) => ({
    content: [{ type: "text", text: `handoff ${task.id} ${reason}` }],
    details: { pi_bg: { task_id: task.id, reason }, tail },
  }),
}));

const EXIT0 = { code: 0, signal: null };
const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("");

function setup(over: Parameters<typeof w6bEnv>[0] = {}) {
  const env = w6bEnv(over);
  const pi = new FakePi();
  const ctl = registerBashTool(pi.asExtensionAPI(), env.s);
  const call = (params: Record<string, unknown>, o: { signal?: AbortSignal; id?: string } = {}) =>
    pi.callTool("bash", params, { signal: o.signal, toolCallId: o.id ?? "c1", ctx: w6bCtx as never });
  return { env, pi, ctl, call };
}
const state = (e: W6bEnv, id = "bg1") => e.s.registry.get(id)!;

describe("bash tool: foreground", () => {
  it("registers bash with the pi-bg schema and guidelines", () => {
    const { pi } = setup();
    const tool = pi.tools.get("bash")!;
    expect(Object.keys((tool.parameters as { properties: object }).properties)).toEqual(
      expect.arrayContaining(["command", "timeout", "bg_timeout", "run_in_background", "notify", "description"]),
    );
    expect(tool.promptGuidelines?.some((g) => /run_in_background/.test(g))).toBe(true);
  });

  it("returns the native result unchanged on completion and records the task", async () => {
    const { env, call } = setup();
    env.runner.script([{ at: 0, chunk: "hi\n" }, { at: 10, exit: EXIT0 }]);
    const p = call({ command: "echo hi" });
    await w6bFlush();
    env.clock.advance(10);
    const r = await p;
    expect(text(r as never)).toBe("hi\n");
    expect((r.details as { pi_bg?: unknown } | undefined)?.pi_bg).toBeUndefined();
    await w6bFlush();
    expect(state(env).state).toBe("exited");
    expect(env.logs.contents("bg1")).toBe("hi\n");
    expect(env.s.ctx.current).toBeDefined();
  });

  it("gives the runner the command exactly as the native tool delivers it (one prefix at most) and the session env", async () => {
    const { env, call } = setup();
    env.runner.script([{ at: 0, exit: EXIT0 }]);
    await call({ command: "echo hi" });
    expect(env.runner.started[0].command).toBe("echo hi");
    expect(env.runner.started[0].env?.PI_SESSION_ID).toBe("sess");
    expect(state(env).spec.command).toBe("echo hi");
  });

  it("maps a non-zero exit to the native error", async () => {
    const { env, call } = setup();
    env.runner.script([{ at: 0, chunk: "bad\n", exit: { code: 2, signal: null } }]);
    const r = (await call({ command: "false" })) as { isError?: boolean };
    expect(r.isError).toBe(true);
    expect(text(r as never)).toMatch(/Command exited with code 2/);
  });
});

describe("bash tool: handoff", () => {
  it("hands off at bg_timeout, keeps the process running and records the late exit", async () => {
    const { env, call, ctl } = setup();
    env.runner.script([{ at: 0, chunk: "a\n" }, { at: 40_000, chunk: "late\n" }, { at: 45_000, exit: EXIT0 }]);
    const p = call({ command: "slow" });
    await w6bFlush();
    env.clock.advance(30_000);
    const r = await p;
    expect(text(r as never)).toBe("handoff bg1 bg_timeout");
    expect(state(env)).toMatchObject({ state: "background", handoffReason: "bg_timeout" });
    expect(env.runner.kills).toEqual([]);
    expect(ctl.handoff("bg1", "user")).toBe(false);
    env.clock.advance(15_000);
    await w6bFlush();
    expect(state(env).state).toBe("exited");
    expect(env.logs.contents("bg1")).toBe("a\nlate\n");
    expect(env.s.runtime.get("bg1")!.tail.lines(5)).toEqual(["a", "late"]);
  });

  it("per-call bg_timeout and session override take precedence over the config", async () => {
    const { env, call } = setup();
    env.s.overrides.bgTimeoutSeconds = 5;
    const p = call({ command: "x" });
    await w6bFlush();
    expect(state(env).spec.bgTimeoutMs).toBe(5000);
    env.clock.advance(5000);
    await p;
    const p2 = call({ command: "y", bg_timeout: 2 }, { id: "c2" });
    await w6bFlush();
    expect(state(env, "bg2").spec.bgTimeoutMs).toBe(2000);
    env.clock.advance(2000);
    await p2;
  });

  it("run_in_background returns at once with a requested handoff", async () => {
    const { env, call } = setup();
    env.runner.script([{ at: 0, chunk: "up\n" }]);
    const r = await call({ command: "server", run_in_background: true, notify: "off", description: "srv" });
    expect(text(r as never)).toBe("handoff bg1 requested");
    expect(state(env)).toMatchObject({ state: "background", handoffReason: "requested", spec: { notify: "off", label: "srv" } });
    expect(env.runner.started).toHaveLength(1);
  });

  it("handoffAllMovable moves two parallel foreground calls and ignores terminal tasks", async () => {
    const { env, call, ctl } = setup();
    env.runner.script([{ at: 5, exit: EXIT0 }]); // bg1 ends on its own
    const p1 = call({ command: "a" }, { id: "c1" });
    const p2 = call({ command: "b" }, { id: "c2" });
    const p3 = call({ command: "c" }, { id: "c3" });
    await w6bFlush();
    env.clock.advance(5);
    await w6bFlush();
    expect(text((await p1) as never)).toBe("(no output)");
    expect(ctl.handoffAllMovable("user")).toEqual(["bg2", "bg3"]);
    expect(text((await p2) as never)).toBe("handoff bg2 user");
    expect(text((await p3) as never)).toBe("handoff bg3 user");
    expect(ctl.handoffAllMovable("user")).toEqual([]);
    expect(ctl.handoff("bg1", "user")).toBe(false);
    expect(ctl.handoff("bg99", "user")).toBe(false);
    expect(env.runner.kills).toEqual([]);
  });

  it("handoff(id) returns true once and then false", async () => {
    const { env, call, ctl } = setup();
    const p = call({ command: "a" });
    await w6bFlush();
    expect(ctl.handoff("bg1", "user")).toBe(true);
    expect(ctl.handoff("bg1", "user")).toBe(false);
    expect(text((await p) as never)).toBe("handoff bg1 user");
    expect(state(env).handoffReason).toBe("user");
  });

  it("stops forwarding output to the native tool after the handoff", async () => {
    const { env, pi } = setup();
    env.runner.script([{ at: 0, chunk: "one\n" }, { at: 10_000, chunk: "two\n" }]);
    const updates: string[] = [];
    const exec = pi.tools.get("bash")!.execute as never as (...a: unknown[]) => Promise<never>;
    const p = exec("c9", { command: "x", bg_timeout: 5 }, undefined, (u: { content: { text?: string }[] }) => updates.push(u.content[0]?.text ?? ""), w6bCtx);
    await w6bFlush();
    env.clock.advance(5000);
    await p;
    const before = updates.length;
    expect(before).toBeGreaterThan(0);
    env.clock.advance(5000);
    await w6bFlush();
    expect(updates.length).toBe(before);
    expect(env.s.runtime.get("bg1")!.tail.lines(5)).toEqual(["one", "two"]);
  });
});

describe("bash tool: hard timeout", () => {
  it("throws the native timeout text and records timed_out", async () => {
    const { env, call } = setup();
    env.runner.script([{ at: 0, chunk: "partial\n" }]);
    const p = call({ command: "sleep 99", timeout: 5 });
    const assertion = expect(p).rejects.toThrow(/partial[\s\S]*Command timed out after 5 seconds/);
    await w6bFlush();
    env.clock.advance(5000);
    await assertion;
    await w6bFlush();
    expect(env.runner.kills).toEqual(["term"]);
    expect(state(env).state).toBe("timed_out");
  });

  it("timeout <= bg_timeout: no handoff timer, the kill comes at timeout", async () => {
    const { env, call } = setup();
    const p = call({ command: "x", timeout: 10, bg_timeout: 10 });
    const assertion = expect(p).rejects.toThrow(/timed out after 10 seconds/);
    await w6bFlush();
    expect(env.clock.pending()).toBe(1);
    env.clock.advance(10_000);
    await assertion;
    expect(state(env).handoffReason).toBeUndefined();
    expect(state(env).spec.hardTimeoutMs).toBe(10_000);
  });

  it("timeout after handoff still kills the background task", async () => {
    const { env, call } = setup();
    const p = call({ command: "x", timeout: 60, bg_timeout: 10 });
    await w6bFlush();
    env.clock.advance(10_000);
    await p;
    env.clock.advance(50_000);
    await w6bFlush();
    expect(env.runner.kills).toEqual(["term"]);
    expect(state(env).state).toBe("timed_out");
  });
});

describe("bash tool: abort", () => {
  it("abort before handoff kills the foreground task with cause turn_abort", async () => {
    const { env, call } = setup();
    const ac = new AbortController();
    const p = call({ command: "x" }, { signal: ac.signal });
    const assertion = expect(p).rejects.toThrow(/aborted/);
    await w6bFlush();
    ac.abort();
    await assertion;
    await w6bFlush();
    expect(env.runner.kills).toEqual(["term"]);
    expect(state(env)).toMatchObject({ state: "killed", killCause: "turn_abort" });
  });

  it("a pre-aborted signal kills the started process", async () => {
    const { env, call } = setup();
    const ac = new AbortController();
    ac.abort();
    await expect(call({ command: "x" }, { signal: ac.signal })).rejects.toThrow(/aborted/);
    await w6bFlush();
    expect(env.runner.kills).toHaveLength(1);
    expect(state(env).state).toBe("killed");
  });

  it("abort after handoff does not kill the task", async () => {
    const { env, call, ctl } = setup();
    const ac = new AbortController();
    const p = call({ command: "x" }, { signal: ac.signal });
    await w6bFlush();
    ctl.handoff("bg1", "user");
    await p;
    ac.abort();
    await w6bFlush();
    expect(env.runner.kills).toEqual([]);
    expect(state(env).state).toBe("background");
  });
});

describe("bash tool: failures", () => {
  it("run_in_background at maxRunningTasks is an error with the limit text", async () => {
    const { env, call } = setup({ config: { maxRunningTasks: 1 } });
    await call({ command: "a", run_in_background: true });
    await expect(call({ command: "b", run_in_background: true }, { id: "c2" })).rejects.toThrow(/1 background tasks are running.*Action/s);
    expect(env.runner.started).toHaveLength(1);
    expect(env.notices.at(-1)?.level).toBe("error");
  });

  it("the task limit also applies to a foreground call", async () => {
    const { call } = setup({ config: { maxRunningTasks: 1 } });
    await call({ command: "a", run_in_background: true });
    await expect(call({ command: "b" }, { id: "c2" })).rejects.toThrow(/background tasks are running/);
  });

  it("spawn failure: spawn_failed event and an error naming cause and action (background and foreground)", async () => {
    const runner = { capabilities: { pid: false, splitStreams: false, gracefulTerm: false }, start: () => ({ startError: "bad cwd" }) };
    const { env, call } = setup({ runner });
    await expect(call({ command: "a", run_in_background: true })).rejects.toThrow(/bad cwd[\s\S]*Action/);
    await expect(call({ command: "b" }, { id: "c2" })).rejects.toThrow(/bad cwd[\s\S]*Action/);
    expect(state(env).state).toBe("spawn_failed");
    expect(state(env, "bg2").state).toBe("spawn_failed");
    expect(env.notices.filter((n) => n.level === "error")).toHaveLength(2);
  });

  it("log open error: runs ring-only and flags log_degraded", async () => {
    const { env, call } = setup();
    env.logs.failNextOpen("read-only fs");
    env.runner.script([{ at: 0, chunk: "out\n", exit: EXIT0 }]);
    const r = await call({ command: "x" });
    expect(text(r as never)).toBe("out\n");
    expect(state(env).logDegraded).toBe(true);
    expect(env.logs.contents("bg1")).toBe("");
    expect(env.notices.some((n) => /read-only fs/.test(n.msg))).toBe(true);
  });
});

describe("bash tool: pass-through", () => {
  it("enabled=false runs Pi's native bash for a plain command, with no task", async () => {
    const { env, call } = setup({ config: { enabled: false } });
    const r = await call({ command: "echo native-ok" });
    expect(text(r as never)).toContain("native-ok");
    expect(env.runner.started).toHaveLength(0);
    expect(env.s.registry.list()).toHaveLength(0);
  });

  it.each([
    ["run_in_background", { run_in_background: true }],
    ["bg_timeout", { bg_timeout: 1 }],
    ["notify", { notify: "done" }],
  ])("enabled=false rejects %s with the inactive text instead of running in the foreground", async (_n, extra) => {
    const { env, call } = setup({ config: { enabled: false } });
    await expect(call({ command: "echo should-not-run", ...extra })).rejects.toThrow(/pi-bg is inactive.*Action:/);
    expect(env.notices.some((n) => n.level === "error" && n.msg.includes("pi-bg is inactive"))).toBe(true);
    expect(env.runner.started).toHaveLength(0);
    expect(env.s.registry.list()).toHaveLength(0);
  });

  it("inactiveReason rejects run_in_background with that reason", async () => {
    const { env, call } = setup();
    env.s.inactiveReason = () => "bash is owned by x";
    await expect(call({ command: "echo hi", run_in_background: true })).rejects.toThrow("bash is owned by x");
    expect(env.notices.some((n) => n.msg.includes("bash is owned by x"))).toBe(true);
  });

  it("inactiveReason set also passes through", async () => {
    const { env, call } = setup();
    env.s.inactiveReason = () => "bash is owned by x";
    const r = await call({ command: "echo native-two" });
    expect(text(r as never)).toContain("native-two");
    expect(env.s.registry.list()).toHaveLength(0);
  });
});
