import { afterEach, describe, expect, it } from "vitest";
import { createLive, skipReason, sleep, until, type Live } from "../support/harness.js";

const skip = skipReason("notify");
let live: Live | undefined;
afterEach(async () => { await live?.cleanup(); live = undefined; });

describe.skipIf(!!skip)("live notification (real pi-bg in a real AgentSession)", () => {
  it("a task finishing while idle delivers a pi-bg:task custom message that starts a turn; ack is observed once", async () => {
    live = await createLive({ notify: { batchMs: 0 } });
    live.faux.setResponses([
      live.toolTurn(live.call("bash", { command: "sleep 2; echo finished-ok", bg_timeout: 1 }, "b1")),
      live.text("started"),
    ]);
    await live.session.prompt("go");
    await live.session.agent?.waitForIdle?.();
    live.faux.setResponses([live.text("saw notification")]);
    const starts = () => live!.events.filter((e) => e.type === "agent_start").length;
    const startsBefore = starts();
    await until(() => live!.events.some((e) => e.type === "message_end" && e.message?.role === "custom" && e.message?.customType === "pi-bg:task"), 8000, "custom message_end (ack)");
    await until(() => starts() > startsBefore, 5000, "a new turn started by the notification");
    await live.session.agent?.waitForIdle?.();
    const acks = live.events.filter((e) => e.type === "message_end" && e.message?.role === "custom" && e.message?.customType === "pi-bg:task");
    expect(acks).toHaveLength(1);
    expect(JSON.stringify(acks[0].message.details?.taskIds)).toContain("bg1");
    expect(JSON.stringify(acks[0].message.content)).toMatch(/bg1/);
    expect(live.session.messages.filter((m: any) => m.role === "custom" && m.customType === "pi-bg:task")).toHaveLength(1);
  }, 40_000);

  it("negative control: notify.default off delivers nothing", async () => {
    live = await createLive({ notify: { default: "off", batchMs: 0 } });
    live.faux.setResponses([
      live.toolTurn(live.call("bash", { command: "sleep 2; echo finished-ok", bg_timeout: 1 }, "b1")),
      live.text("started"),
    ]);
    await live.session.prompt("go");
    await sleep(3500);
    expect(live.events.some((e) => e.type === "message_end" && e.message?.customType === "pi-bg:task")).toBe(false);
  }, 40_000);

  it("a task finishing during a running tool is delivered once, after the tool result (steer waits for the batch)", async () => {
    live = await createLive({ notify: { batchMs: 0 } });
    live.faux.setResponses([
      live.toolTurn(live.call("bash", { command: "sleep 1; echo mid-done", run_in_background: true }, "b1")),
      live.toolTurn(live.call("bash", { command: "sleep 3", bg_timeout: 0 }, "slow")),
      live.text("saw notification"),
    ]);
    await live.session.prompt("go");
    await live.session.agent?.waitForIdle?.();
    expect(customEnds(live)).toHaveLength(1);
    const order = live.session.messages.map((m: any) => (m.role === "toolResult" ? `tool:${m.toolCallId}` : m.role === "custom" ? "custom" : m.role));
    expect(order.indexOf("custom")).toBeGreaterThan(order.indexOf("tool:slow"));
  }, 40_000);

  it("Esc (clearQueue then abort) discards the queued steer; pi-bg redelivers it once with the next prompt", async () => {
    live = await createLive({ notify: { batchMs: 0 } });
    live.faux.setResponses([
      live.toolTurn(live.call("bash", { command: "sleep 1; echo esc-done", run_in_background: true }, "b1")),
      live.toolTurn(live.call("bash", { command: "sleep 30", bg_timeout: 0 }, "slow")),
      live.text("unused"),
    ]);
    const run = live.session.prompt("go");
    await until(() => live!.events.some((e) => e.type === "tool_execution_start" && e.toolCallId === "slow"), 10_000, "slow tool to start");
    await sleep(2200); // bg1 finished and its notification is queued as a steer
    live.session.clearQueue(); // interactive Esc: restoreQueuedMessagesToEditor clears the agent queues, then aborts
    await live.session.abort();
    await run.catch(() => undefined);
    await live.session.agent?.waitForIdle?.();
    expect(customEnds(live)).toHaveLength(0); // the steer was lost
    live.faux.setResponses([live.text("saw it")]);
    await live.session.prompt("next");
    await live.session.agent?.waitForIdle?.();
    expect(customEnds(live)).toHaveLength(1); // redelivered via nextTurn, once
    expect(live.session.messages.filter((m: any) => m.role === "custom" && m.customType === "pi-bg:task")).toHaveLength(1);
  }, 40_000);
});

const customEnds = (l: Live) => l.events.filter((e) => e.type === "message_end" && e.message?.role === "custom" && e.message?.customType === "pi-bg:task");
