// Bash tool with the real result mapper (results.js is NOT mocked here, unlike bash-tool.test.ts).
import { describe, expect, it } from "vitest";
import { handoffText } from "../../src/core/format.js";
import { handoffMechanism, registerBashTool } from "../../src/pi/bash-tool.js";
import { FakePi } from "../fakes/index.js";
import { w6bCtx, w6bEnv, w6bFlush } from "./w6b-helpers.js";

const EXIT0 = { code: 0, signal: null };
const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("");

function setup(shellCommandPrefix?: string) {
  const env = w6bEnv();
  const pi = new FakePi();
  (pi as unknown as { getSettings: () => object }).getSettings = () => ({ shellCommandPrefix });
  const ctl = registerBashTool(pi.asExtensionAPI(), env.s);
  const call = (params: Record<string, unknown>, id = "c1") => pi.callTool("bash", params, { toolCallId: id, ctx: w6bCtx as never });
  return { env, ctl, call };
}

describe("bash tool with the real mapper", () => {
  it("a bg_timeout handoff carries the format.ts handoff text and the pi_bg details", async () => {
    const { env, call } = setup();
    env.runner.script([{ at: 0, chunk: "building\n" }]);
    const p = call({ command: "make", bg_timeout: 5 });
    await w6bFlush();
    env.clock.advance(5000);
    const r = await p;
    const task = env.s.registry.get("bg1")!;
    expect(text(r as never)).toBe(handoffText(task, ["building"], "bg_timeout"));
    expect(text(r as never)).toContain("bg1");
    expect(r.details).toMatchObject({ pi_bg: { task_id: "bg1", reason: "bg_timeout" } });
  });

  it("run_in_background maps to a requested handoff", async () => {
    const { call } = setup();
    const r = await call({ command: "srv", run_in_background: true });
    expect(r.details).toMatchObject({ pi_bg: { task_id: "bg1", reason: "requested" } });
  });

  it("handoff before a same-tick exit returns the handoff result; the exit is still recorded", async () => {
    const { env, call, ctl } = setup();
    env.runner.script([{ at: 100, exit: EXIT0 }]);
    const p = call({ command: "x" });
    await w6bFlush();
    expect(ctl.handoff("bg1", "user")).toBe(true);
    env.clock.advance(100); // the exit lands in the same tick as the unresolved handoff
    const r = await p;
    expect(r.details).toMatchObject({ pi_bg: { task_id: "bg1", reason: "user" } });
    await w6bFlush();
    expect(env.s.registry.get("bg1")).toMatchObject({ state: "exited", handoffReason: "user" });
  });

  it("an exit before the handoff wins: native result, handoff refused (negative control)", async () => {
    const { env, call, ctl } = setup();
    env.runner.script([{ at: 100, chunk: "ok\n", exit: EXIT0 }]);
    const p = call({ command: "x" });
    await w6bFlush();
    env.clock.advance(100);
    await w6bFlush();
    expect(ctl.handoff("bg1", "user")).toBe(false);
    const r = await p;
    expect(text(r as never)).toBe("ok\n");
    expect((r.details as { pi_bg?: unknown } | undefined)?.pi_bg).toBeUndefined();
  });

  // shellCommandPrefix (Pi settings): the per-call native tool prepends it ("prefix\ncommand") and the runner must not add it again.
  it("no prefix set: the runner gets the command unmodified (foreground and background)", async () => {
    const { env, call } = setup();
    env.runner.script([{ at: 0, exit: EXIT0 }, { at: 0, exit: EXIT0 }]);
    await call({ command: "echo once" });
    await call({ command: "echo two", run_in_background: true }, "c2");
    expect(env.runner.started.map((s) => s.command)).toEqual(["echo once", "echo two"]);
  });

  it("prefix set: the foreground runner receives exactly one prefix", async () => {
    const { env, call } = setup("set -e");
    env.runner.script([{ at: 0, exit: EXIT0 }]);
    await call({ command: "echo once" });
    expect(env.runner.started.map((s) => s.command)).toEqual(["set -e\necho once"]);
  });

  it("prefix set: the run_in_background runner receives exactly one prefix", async () => {
    const { env, call } = setup("set -e");
    env.runner.script([{ at: 0, exit: EXIT0 }]);
    await call({ command: "echo once", run_in_background: true });
    expect(env.runner.started.map((s) => s.command)).toEqual(["set -e\necho once"]);
  });
});

describe("handoffMechanism.recover", () => {
  const mech = () => handoffMechanism();
  const fg = (taskId: string, toolCallId: string) => ({ taskId, toolCallId, handedOff: false, reject() {}, detach() {} });

  it("prefers the side table (with its reason) and consumes the entry", () => {
    const m = mech();
    m.trigger(fg("bg1", "c1"), "bg_timeout");
    expect(m.recover("c1", new Error("pi-bg-handoff:bg1"))).toEqual({ taskId: "bg1", reason: "bg_timeout" });
    expect(m.recover("c1", new Error("other"))).toBeUndefined();
  });

  it("falls back to the message prefix when the side table has no entry", () => {
    expect(mech().recover("cX", new Error("pi-bg-handoff:bg7"))).toEqual({ taskId: "bg7", reason: "user" });
  });

  it("ignores ordinary errors and non-errors", () => {
    expect(mech().recover("cX", new Error("Command timed out after 5 seconds"))).toBeUndefined();
    expect(mech().recover("cX", "pi-bg-handoff:bg7")).toBeUndefined();
  });
});
