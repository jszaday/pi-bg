import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createLive, skipReason, sleep, until, type Live } from "../support/harness.js";

const skip = skipReason("handoff");
let live: Live | undefined;
afterEach(async () => { await live?.cleanup(); live = undefined; });

describe.skipIf(!!skip)("live handoff (real pi-bg in a real AgentSession)", () => {
  it("bg_timeout moves a running bash call to the background; it keeps running; bg_status later shows exited", async () => {
    live = await createLive();
    live.faux.setResponses([
      live.toolTurn(live.call("bash", { command: "sleep 2; echo done", bg_timeout: 1 }, "c1")),
      live.text("ok"),
    ]);
    const t0 = Date.now();
    await live.session.prompt("go");
    const r = live.toolResults().find((x) => x.id === "c1")!;
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/bg1/);
    expect(r.text).toMatch(/background/i);
    expect(r.at - t0).toBeGreaterThanOrEqual(900);
    expect(r.at - t0).toBeLessThan(1900); // returned at the handoff, not at process end
    // still running right after the handoff
    const running = (await liveStatus(live, "s1")).text;
    expect(running).toMatch(/bg1/);
    expect(running).toMatch(/background/);
    await sleep(1800);
    const done = (await liveStatus(live, "s2")).text;
    expect(done).toMatch(/bg1\s+exited\s+\S+\s+0/);
    expect(done).not.toMatch(/background/);
  }, 30_000);

  it("bg_timeout 0 keeps a quick call in the foreground while a parallel call hands off with its own id", async () => {
    live = await createLive();
    live.faux.setResponses([
      live.toolTurn(live.call("bash", { command: "echo quick", bg_timeout: 0 }, "q1"), live.call("bash", { command: "sleep 3", bg_timeout: 1 }, "q2")),
      live.text("ok"),
    ]);
    await live.session.prompt("go");
    const res = live.toolResults();
    expect(res.find((x) => x.id === "q1")!.text).toMatch(/quick/);
    expect(res.find((x) => x.id === "q1")!.text).not.toMatch(/background/i);
    expect(res.find((x) => x.id === "q2")!.text).toMatch(/bg\d+/);
    expect(res.find((x) => x.id === "q2")!.isError).toBe(false);
    expect((await liveStatus(live, "s9")).text).toMatch(/background/);
  }, 30_000);

  it("abort before the handoff kills the foreground command's group and registers no background task", async () => {
    live = await createLive();
    live.faux.setResponses([
      live.toolTurn(live.call("bash", { command: "echo tick1; sleep 3160 & sleep 3160", bg_timeout: 20 }, "a1")),
      live.text("never"),
    ]);
    const run = live.session.prompt("go");
    await until(() => live!.events.some((e) => e.type === "tool_execution_start" && e.toolCallId === "a1"), 10_000, "bash to start");
    await until(() => pgrepCount(3160) >= 2, 5000, "both sleeps to run");
    await live.session.abort();
    await run.catch(() => undefined);
    await until(() => pgrepCount(3160) === 0, 5000, "group to be killed");
    const r = live.toolResults().find((x) => x.id === "a1");
    expect(r?.isError).toBe(true);
    expect(r?.text).toMatch(/Command aborted/);
    await sleep(500); // the exit event follows the kill by the idle grace
    const st = (await liveStatus(live, "s3")).text;
    expect(st).toMatch(/bg1\s+killed/); // recorded as killed, never as a background task
    expect(st).not.toMatch(/background/);
  }, 40_000);

  it("a foreground command over `timeout` ends with the native timeout text, not a handoff", async () => {
    live = await createLive();
    live.faux.setResponses([
      live.toolTurn(live.call("bash", { command: "echo hi; sleep 3161", timeout: 1, bg_timeout: 20 }, "t1")),
      live.text("ok"),
    ]);
    await live.session.prompt("go");
    const r = live.toolResults().find((x) => x.id === "t1")!;
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/hi/);
    expect(r.text).toMatch(/Command timed out after 1 seconds/);
    expect(r.text).not.toMatch(/background/i);
    await until(() => pgrepCount(3161) === 0, 5000, "timed-out command to be killed");
  }, 40_000);
});

// Exact match on the command line: the wrapping shell's own command line also contains "sleep N".
function pgrepCount(n: number): number {
  try {
    return execFileSync("pgrep", ["-fx", `sleep ${n}`], { encoding: "utf8" }).trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function liveStatus(live: Live, id: string) {
  live.faux.setResponses([live.toolTurn(live.call("bg_status", {}, id)), live.text("ok")]);
  await live.session.prompt("status");
  await until(() => live.toolResults().some((x) => x.id === id), 5000, "bg_status result");
  return live.toolResults().find((x) => x.id === id)!;
}
