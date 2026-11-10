import { afterEach, describe, expect, it } from "vitest";
import { createLive, skipReason, sleep, until, type Live } from "../support/harness.js";

const skip = skipReason("wait");
let live: Live | undefined;
afterEach(async () => { await live?.cleanup(); live = undefined; });

/** tool_execution_start fires BEFORE execute() runs (S1): wait for it, then give execute() time to register the wait. */
async function waitStarted(l: Live, id: string): Promise<void> {
  await until(() => l.events.some((e) => e.type === "tool_execution_start" && e.toolCallId === id), 10_000, `${id} to start`);
  await sleep(150);
}
const userTexts = (l: Live, needle: string) =>
  l.session.messages.filter((m: any) => m.role === "user" && JSON.stringify(m.content).includes(needle)).length;

describe.skipIf(!!skip)("live bg_wait (real pi-bg in a real AgentSession)", () => {
  it("a steer releases bg_wait within 300 ms with user_message, delivered exactly once, task keeps running", async () => {
    live = await createLive();
    live.faux.setResponses([
      live.toolTurn(live.call("bash", { command: "sleep 30", bg_timeout: 1 }, "b1")),
      live.toolTurn(live.call("bg_wait", { timeout_s: 20 }, "w1")),
      live.text("noted"),
    ]);
    const run = live.session.prompt("go");
    await waitStarted(live, "w1");
    const t0 = Date.now();
    await live.session.steer("STEER-MARK-1");
    await until(() => live!.toolResults().some((x) => x.id === "w1"), 2000, "bg_wait to be released");
    const w = live.toolResults().find((x) => x.id === "w1")!;
    expect(w.at - t0).toBeLessThan(300);
    expect(w.isError).toBe(false);
    expect(w.text).toMatch(/because the user sent a message/);
    expect(w.text).toMatch(/bg1/);
    await run;
    await live.session.agent?.waitForIdle?.();
    expect(userTexts(live, "STEER-MARK-1")).toBe(1); // no duplicate delivery
    // the task was not touched by the release
    live.faux.setResponses([live.toolTurn(live.call("bg_status", {}, "s1")), live.text("ok")]);
    await live.session.prompt("status");
    expect(live.toolResults().find((x) => x.id === "s1")!.text).toMatch(/bg1\s+background/);
  }, 40_000);

  it("Esc-equivalent abort releases bg_wait as aborted and leaves the task running", async () => {
    live = await createLive();
    live.faux.setResponses([
      live.toolTurn(live.call("bash", { command: "sleep 30", bg_timeout: 1 }, "b1")),
      live.toolTurn(live.call("bg_wait", { timeout_s: 20 }, "w1")),
      live.text("never"),
    ]);
    const run = live.session.prompt("go");
    await waitStarted(live, "w1");
    const t0 = Date.now();
    await live.session.abort();
    await run.catch(() => undefined);
    const w = live.toolResults().find((x) => x.id === "w1");
    expect(w, "bg_wait produced a result after abort").toBeDefined();
    expect(w!.at - t0).toBeLessThan(1000);
    expect(w!.text).toMatch(/wait was cancelled/);
    live.faux.setResponses([live.toolTurn(live.call("bg_status", {}, "s1")), live.text("ok")]);
    await live.session.prompt("status");
    expect(live.toolResults().find((x) => x.id === "s1")!.text).toMatch(/bg1\s+background/);
  }, 40_000);

  it("a follow-up releases bg_wait too, delivered exactly once after the agent would have stopped", async () => {
    live = await createLive();
    live.faux.setResponses([
      live.toolTurn(live.call("bash", { command: "sleep 30", bg_timeout: 1 }, "b1")),
      live.toolTurn(live.call("bg_wait", { timeout_s: 20 }, "w1")),
      live.text("noted"),
      live.text("follow-up seen"),
    ]);
    const run = live.session.prompt("go");
    await waitStarted(live, "w1");
    const t0 = Date.now();
    await live.session.followUp("FOLLOW-MARK-1");
    await until(() => live!.toolResults().some((x) => x.id === "w1"), 2000, "bg_wait to be released");
    expect(live.toolResults().find((x) => x.id === "w1")!.at - t0).toBeLessThan(300);
    await run;
    await live.session.agent?.waitForIdle?.();
    expect(userTexts(live, "FOLLOW-MARK-1")).toBe(1);
  }, 40_000);

  it("a steer followed by Esc (interactive path: clearQueue then abort) is never delivered to the model", async () => {
    live = await createLive();
    live.faux.setResponses([
      live.toolTurn(live.call("bash", { command: "sleep 30", bg_timeout: 1 }, "b1")),
      live.toolTurn(live.call("bg_wait", { timeout_s: 20 }, "w1")),
      live.text("never"),
    ]);
    const run = live.session.prompt("go");
    await waitStarted(live, "w1");
    await live.session.steer("STEER-MARK-2");
    const cleared = live.session.clearQueue(); // what interactive mode's Esc does before abort
    await live.session.abort();
    await run.catch(() => undefined);
    expect(JSON.stringify(cleared)).toContain("STEER-MARK-2"); // returned for restoring to the editor
    expect(userTexts(live, "STEER-MARK-2")).toBe(0);
  }, 40_000);
});
