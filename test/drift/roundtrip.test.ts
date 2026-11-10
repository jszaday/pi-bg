// Producer -> wire -> validator: each tool is run through FakePi.callTool and its structuredContent/details are
// validated against the response schema. A stub returning a mirror of a bug (camelCase) must fail the same checker.
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { registerBgTools } from "../../src/pi/bg-tools.js";
import { toBashHandoffResult } from "../../src/pi/results.js";
import { TOOL_NAMES, type ToolName } from "../../src/tools/schemas.js";
import { FakePi } from "../fakes/index.js";
import { makeHarness, type Harness } from "../pi/w6a-services.js";
import { w6bCtx, w6bEnv, w6bFlush } from "../pi/w6b-helpers.js";
import { checkResult, RESPONSE_SCHEMAS } from "./wire-schemas.js";

const exit0 = { code: 0, signal: null };

function setup(): Harness {
  const h = makeHarness();
  registerBgTools(h.pi.asExtensionAPI(), h.s);
  return h;
}

describe("bg_* producers satisfy the response schemas", () => {
  it("bg_status: empty, running and finished tasks", async () => {
    const h = setup();
    expect(checkResult("bg_status", await h.pi.callTool("bg_status", {}))).toEqual({ ok: true, why: "" });
    h.start("a", [{ at: 0, chunk: "hi\n", exit: exit0 }]);
    h.start("b", [{ at: 0, chunk: "yo\n" }]);
    await h.flush();
    for (const p of [{}, { tail_lines: 2 }, { id: "bg1" }, { id: "bg2", tail_lines: 1 }, { include_finished: false }]) {
      const r = await h.pi.callTool("bg_status", p);
      expect(checkResult("bg_status", r), JSON.stringify(p)).toEqual({ ok: true, why: "" });
    }
  });
  it("bg_status: task without log (no log_path, log_degraded true)", async () => {
    const h = setup();
    h.start("a", [{ at: 0, chunk: "x\n" }], { log: false });
    expect(checkResult("bg_status", await h.pi.callTool("bg_status", {})).ok).toBe(true);
  });
  it("bg_output: tail, since cursor, grep, stream, degraded", async () => {
    const h = setup();
    h.start("a", [{ at: 0, chunk: "one\nERR two\nthree\n", exit: exit0 }]);
    h.start("b", [{ at: 0, chunk: "ring\n" }], { log: false });
    await h.flush();
    for (const p of [{ id: "bg1" }, { id: "bg1", since: 0 }, { id: "bg1", grep: "ERR", context: 1 }, { id: "bg1", stream: "stderr" }, { id: "bg1", max_bytes: 5 }, { id: "bg2" }]) {
      const r = await h.pi.callTool("bg_output", p);
      expect(checkResult("bg_output", r), JSON.stringify(p)).toEqual({ ok: true, why: "" });
    }
  });
  it("bg_wait: finished, timeout and no_tasks reasons", async () => {
    const h = setup();
    const none = await h.pi.callTool("bg_wait", {});
    expect(checkResult("bg_wait", none).ok).toBe(true);
    expect((none.structuredContent as { reason: string }).reason).toBe("no_tasks");
    h.start("a", [{ at: 100, chunk: "x\n", exit: exit0 }]);
    const p = h.pi.callTool("bg_wait", { timeout_s: 1 });
    await h.flush();
    h.clock.advance(100);
    await h.flush();
    const done = await p;
    expect(checkResult("bg_wait", done)).toEqual({ ok: true, why: "" });
    h.start("b");
    const t = h.pi.callTool("bg_wait", { ids: ["bg2"], timeout_s: 1 });
    await h.flush();
    h.clock.advance(1000);
    await h.flush();
    const timed = await t;
    expect(checkResult("bg_wait", timed).ok).toBe(true);
    expect((timed.structuredContent as { reason: string }).reason).toBe("timeout");
  });
  it("bg_kill: killed and already finished", async () => {
    const h = setup();
    h.start("a", [{ at: 0, exit: exit0 }]);
    h.start("b");
    await h.flush();
    const p = h.pi.callTool("bg_kill", { all: true });
    for (let i = 0; i < 5; i++) {
      await h.flush();
      h.clock.advance(1000);
    }
    expect(checkResult("bg_kill", await p)).toEqual({ ok: true, why: "" });
    expect(checkResult("bg_kill", await h.pi.callTool("bg_kill", { id: "bg1" })).ok).toBe(true);
  });
  it("bg_write: write and eof", async () => {
    const h = setup();
    h.start("repl", [], { stdin: true });
    for (const p of [{ id: "bg1", data: "hi\n" }, { id: "bg1", data: "", eof: true }]) {
      expect(checkResult("bg_write", await h.pi.callTool("bg_write", p)), JSON.stringify(p)).toEqual({ ok: true, why: "" });
    }
  });
  it("bg_monitor: start, grep, replace and stop", async () => {
    const h = setup();
    h.start("srv");
    for (const p of [{ id: "bg1" }, { id: "bg1", grep: "ready", max_notifications: 3 }, { id: "bg1", stop: true }, { id: "bg1", stop: true }]) {
      expect(checkResult("bg_monitor", await h.pi.callTool("bg_monitor", p)), JSON.stringify(p)).toEqual({ ok: true, why: "" });
    }
  });
  it("every bg_* tool is covered above and has a response schema", () => {
    const h = setup();
    const registered = [...h.pi.tools.keys()].sort();
    expect(registered).toEqual(TOOL_NAMES.filter((n) => n !== "bash").sort());
    for (const n of registered) expect(n in RESPONSE_SCHEMAS).toBe(true);
  });
});

describe("bash handoff result (toBashHandoffResult)", () => {
  it("satisfies the handoff schema, with and without a log", () => {
    const h = makeHarness();
    const task = h.start("sleep 9", [{ at: 0, chunk: "x\n" }]);
    h.s.registry.dispatch(task.id, { type: "handoff", reason: "bg_timeout", at: h.clock.now() });
    const t = h.s.registry.get(task.id)!;
    const r = toBashHandoffResult(t, ["x"], "bg_timeout", { truncated: false });
    expect(checkResult("bash", r)).toEqual({ ok: true, why: "" });
    expect(r.details).toMatchObject({ truncated: false, pi_bg: { task_id: t.id, reason: "bg_timeout" } });
    const bare = toBashHandoffResult({ ...t, logPath: undefined, pid: undefined }, [], "requested");
    expect(checkResult("bash", bare).ok).toBe(true);
  });
});

const bashToolExists = existsSync(new URL("../../src/pi/bash-tool.ts", import.meta.url));
if (!bashToolExists) console.log("[drift] src/pi/bash-tool.ts is absent on this branch: bash tool round trip skipped until it lands");
describe.skipIf(!bashToolExists)("bash tool round trip (FakePi.callTool, fake runner)", () => {
  async function bash() {
    const { registerBashTool } = await import("../../src/pi/bash-tool.js");
    const env = w6bEnv();
    const pi = new FakePi();
    registerBashTool(pi.asExtensionAPI(), env.s);
    const call = (params: Record<string, unknown>) => pi.callTool("bash", params, { toolCallId: "c1", ctx: w6bCtx as never });
    return { env, call };
  }
  it("run_in_background result satisfies the handoff schema", async () => {
    const { env, call } = await bash();
    env.runner.script([{ at: 0, chunk: "up\n" }]);
    const r = await call({ command: "server", run_in_background: true, description: "srv" });
    expect(checkResult("bash", r)).toEqual({ ok: true, why: "" });
    expect((r.structuredContent as { reason: string }).reason).toBe("requested");
  });
  it("bg_timeout handoff result satisfies the handoff schema", async () => {
    const { env, call } = await bash();
    env.runner.script([{ at: 0, chunk: "x\n" }]);
    const p = call({ command: "sleep 99", bg_timeout: 1 });
    await w6bFlush();
    env.clock.advance(1000);
    const r = await p;
    expect(checkResult("bash", r)).toEqual({ ok: true, why: "" });
    expect((r.structuredContent as { reason: string }).reason).toBe("bg_timeout");
  });
});

describe("negative control: the checker rejects wrong shapes", () => {
  const stubResult = (sc: unknown) => ({ content: [{ type: "text", text: "ok" }], details: sc, structuredContent: sc });
  const stub = (name: string, sc: unknown) => {
    const h = makeHarness();
    h.pi.registerTool({ name, parameters: { type: "object", properties: {} }, execute: async () => stubResult(sc) } as never);
    return h.pi.callTool(name, {});
  };
  it("rejects camelCase keys", async () => {
    const r = await stub("bg_status", { tasks: [{ id: "bg1", command: "x", state: "exited", startedAt: "t", runtimeS: 1, totalBytes: 0, notify: "done", notified: false, logDegraded: false }] });
    const c = checkResult("bg_status", r);
    expect(c.ok).toBe(false);
  });
  it.each<[ToolName, unknown]>([
    ["bg_output", { id: "bg1", state: "exited", output: "", returnedBytes: 0, total_bytes: 0, next_cursor: 0, truncated: false, stream: "combined", log_degraded: false }],
    ["bg_wait", { reason: "finished", waitedS: 1, tasks: [] }],
    ["bg_kill", { killed: [], alreadyFinished: [], failed: [] }],
    ["bg_write", { id: "bg1", writtenBytes: 1, eof: false }],
    ["bg_monitor", { id: "bg1", monitoring: true, maxNotifications: 5 }],
    ["bash", { task_id: "bg1", state: "running", reason: "bg_timeout", runtime_s: 1, output_tail: [], log_degraded: false }],
    ["bg_status", { tasks: [{ id: "bg1", extra: 1 }] }],
    ["bg_status", undefined],
  ])("rejects a wrong %s shape", async (tool, sc) => {
    expect(checkResult(tool, await stub(tool, sc)).ok).toBe(false);
  });
  it("rejects a result with empty text", () => {
    expect(checkResult("bg_kill", { content: [], structuredContent: { killed: [], already_finished: [], failed: [] } }).ok).toBe(false);
  });
  it("accepts a correct stub (the control is not vacuously failing)", async () => {
    expect(checkResult("bg_kill", await stub("bg_kill", { killed: ["bg1"], already_finished: [], failed: [] })).ok).toBe(true);
  });
});
